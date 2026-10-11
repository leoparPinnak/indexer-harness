//! scancode — ham scan-code girdi enjeksiyonu (SendInput, adanan OS thread).
//!
//! Girdi planı SAF üretilir (`plan`): vuruşlar bas/bırak olay çiftlerine açılır,
//! zamanlamaya önceden karar verilir. Yürütme tek adanmış OS thread üzerinde
//! `SendInput(KEYEVENTF_SCANCODE)` ile yapılır; işler kanaldan sıcak döngüde
//! senkron çağrı olmadan tüketilir.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;
use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEINPUT, MOUSE_EVENT_FLAGS,
    VIRTUAL_KEY,
};

/// Ham set-1 tarama kodu (ör. 0x1E = A). `extended` true ise 0xE0 öneki
/// (sağ ok, sağ Ctrl, numpad `/`, …).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScanCode {
    pub code: u16,
    pub extended: bool,
}

/// Girdi isteği: tuş = bas + `hold_ms` sonra bırak.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stroke {
    Key { code: ScanCode, hold_ms: u64 },
    Move { x: u32, y: u32 },
    LButton { down: bool },
}

/// Planlanmış TEK sistem olayı.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    KeyDown(ScanCode),
    KeyUp(ScanCode),
    MouseMove { x: u32, y: u32 },
    LButtonDown,
    LButtonUp,
}

/// `delay_ms` olaydan ÖNCE beklenecek süre.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Planned {
    pub event: Event,
    pub delay_ms: u64,
}

/// Deterministik zamanlama planlayıcı (saf). Temel titreşim xorshift ile
/// üretilir; aynı `seed` aynı planı verir.
pub fn plan(strokes: &[Stroke], seed: u64) -> Vec<Planned> {
    let mut rng = seed | 1;
    let mut jitter = move || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        rng % 28 // 0..27 ms insanvari gecikme
    };
    let mut out = Vec::with_capacity(strokes.len() * 2);
    for s in strokes {
        match *s {
            Stroke::Key { code, hold_ms } => {
                out.push(Planned { event: Event::KeyDown(code), delay_ms: jitter() });
                out.push(Planned { event: Event::KeyUp(code), delay_ms: hold_ms });
            }
            Stroke::Move { x, y } => {
                out.push(Planned { event: Event::MouseMove { x, y }, delay_ms: jitter() });
            }
            Stroke::LButton { down } => {
                let ev = if down { Event::LButtonDown } else { Event::LButtonUp };
                out.push(Planned { event: ev, delay_ms: jitter() });
            }
        }
    }
    out
}

fn key_input(ev: Event) -> Option<INPUT> {
    let (scan, flags) = match ev {
        Event::KeyDown(c) => (
            c,
            KEYEVENTF_SCANCODE | if c.extended { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) },
        ),
        Event::KeyUp(c) => (
            c,
            KEYEVENTF_SCANCODE
                | KEYEVENTF_KEYUP
                | if c.extended { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) },
        ),
        _ => return None,
    };
    let ki = KEYBDINPUT {
        wVk: VIRTUAL_KEY(0),
        wScan: scan.code,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
    };
    Some(INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki } })
}

fn mouse_input(ev: Event) -> Option<INPUT> {
    let mi = match ev {
        Event::MouseMove { x, y } => MOUSEINPUT {
            dx: x as i32,
            dy: y as i32,
            mouseData: 0,
            dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
            time: 0,
            dwExtraInfo: 0,
        },
        Event::LButtonDown | Event::LButtonUp => MOUSEINPUT {
            dx: 0,
            dy: 0,
            mouseData: 0,
            dwFlags: if matches!(ev, Event::LButtonDown) {
                MOUSEEVENTF_LEFTDOWN
            } else {
                MOUSEEVENTF_LEFTUP
            } as MOUSE_EVENT_FLAGS,
            time: 0,
            dwExtraInfo: 0,
        },
        _ => return None,
    };
    Some(INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi } })
}

fn to_input(ev: Event) -> Option<INPUT> {
    key_input(ev).or_else(|| mouse_input(ev))
}

/// Tek olayı sisteme verir; `SendInput` yazılan olay sayısı döner.
pub fn emit(ev: Event) -> std::io::Result<u32> {
    let input = to_input(ev).expect("event her zaman INPUT'a eşlenir");
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    if sent == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(sent)
}

/// Yürütücü: adanan OS thread + iş kanalı. Kanal kapanınca thread iner.
pub struct InputWorker {
    tx: Sender<Vec<Planned>>,
    handle: thread::JoinHandle<()>,
}

impl InputWorker {
    pub fn spawn() -> Self {
        let (tx, rx): (Sender<Vec<Planned>>, Receiver<Vec<Planned>>) = channel();
        let handle = thread::Builder::new()
            .name("scancode-input".into())
            .spawn(move || worker_loop(rx))
            .expect("OS thread açılır");
        Self { tx, handle }
    }

    /// Planlanmış akışı kuyruğa bırakır (yanmayı bekletir).
    pub fn submit(&self, batch: Vec<Planned>) -> Result<(), std::sync::mpsc::SendError<Vec<Planned>>> {
        self.tx.send(batch)
    }

    pub fn join(self) {
        drop(self.tx);
        let _ = self.handle.join();
    }
}

fn worker_loop(rx: Receiver<Vec<Planned>>) {
    while let Ok(batch) = rx.recv() {
        for p in batch {
            if p.delay_ms > 0 {
                thread::sleep(Duration::from_millis(p.delay_ms));
            }
            let _ = emit(p.event);
        }
    }
}