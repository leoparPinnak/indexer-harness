//! Raw scan-code input: `SendInput` with `KEYEVENTF_SCANCODE` press/release
//! pairs on a dedicated OS thread with a monotonic (`QueryPerformanceCounter`)
//! paced queue. `timeBeginPeriod(1)` sharpens scheduler granularity while the
//! sender is alive. No `SendMessage`/`PostMessage` anywhere: the message
//! queue of the target is never touched.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC_EX, VIRTUAL_KEY,
};

use crate::{EngineError, MonoClock};

/// Default key hold for `Tap` when the step gives none (protocol constant).
pub const DEFAULT_HOLD_MS: u64 = 30;
/// Rest-spin threshold: sleeps stop this early and spin the remainder.
const SPIN_THRESHOLD_MICROS: u64 = 500;

/// What one scheduled step asks of the keyboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAction {
    Down,
    Up,
    /// Press followed by release after `hold_ms`.
    Tap,
}

/// One planned step after virtual-key resolution.
#[derive(Debug, Clone, Copy)]
pub struct KeyStepSpec {
    /// Hardware make code (bits 0..8); prefix info comes from `extended`.
    pub scan: u16,
    /// Whether the key is an extended (E0-prefixed) key.
    pub extended: bool,
    pub action: KeyAction,
    /// Hold time for `Tap` (ms).
    pub hold_ms: u64,
    /// Spacing to the next step (ms); 0 means `interval_ms`.
    pub after_ms: u64,
}

/// One discrete key event on the timed queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct KeyPress {
    pub scan: u16,
    pub extended: bool,
    /// `true` releases the key.
    pub release: bool,
    /// Microseconds relative to the schedule epoch.
    pub at_micros: u64,
}

/// Expand steps into ordered press/release events on a shared timeline.
///
/// Step 0 starts at t=0; each later step starts one spacing (its `after_ms`,
/// or `interval_ms` when 0) after the previous step's start, pushed behind the
/// previous release when the hold outlives the spacing. `Tap` emits a
/// down/up pair; `Down`/`Up` emit the single event.
pub fn plan_presses(steps: &[KeyStepSpec], interval_ms: u64) -> Result<Vec<KeyPress>, EngineError> {
    let spacing_micros = |step: &KeyStepSpec| {
        let millis = if step.after_ms == 0 {
            interval_ms
        } else {
            step.after_ms
        };
        millis.saturating_mul(1_000)
    };
    let mut presses = Vec::new();
    let mut next_start = 0u64;
    let mut previous_release = 0u64;
    for (index, step) in steps.iter().enumerate() {
        let start = if index == 0 {
            0
        } else {
            next_start.max(previous_release)
        };
        match step.action {
            KeyAction::Down => presses.push(KeyPress {
                scan: step.scan,
                extended: step.extended,
                release: false,
                at_micros: start,
            }),
            KeyAction::Up => presses.push(KeyPress {
                scan: step.scan,
                extended: step.extended,
                release: true,
                at_micros: start,
            }),
            KeyAction::Tap => {
                let hold_ms = if step.hold_ms == 0 {
                    DEFAULT_HOLD_MS
                } else {
                    step.hold_ms
                };
                let hold = hold_ms.saturating_mul(1_000);
                presses.push(KeyPress {
                    scan: step.scan,
                    extended: step.extended,
                    release: false,
                    at_micros: start,
                });
                let release_at = start.saturating_add(hold);
                presses.push(KeyPress {
                    scan: step.scan,
                    extended: step.extended,
                    release: true,
                    at_micros: release_at,
                });
                previous_release = release_at;
            }
        }
        next_start = start.saturating_add(spacing_micros(step));
    }
    Ok(presses)
}

/// RAII holder keeping `timeBeginPeriod(1)` active while input flows.
pub struct TimerGuard(u32);

impl TimerGuard {
    /// Raise the system timer resolution to 1 ms.
    pub fn acquire() -> Result<Self, EngineError> {
        let code = unsafe { timeBeginPeriod(1) };
        if code == 0 {
            Ok(TimerGuard(1))
        } else {
            Err(EngineError::Io {
                detail: "timeBeginPeriod(1) failed".to_string(),
                win32: code,
            })
        }
    }
}

impl Drop for TimerGuard {
    fn drop(&mut self) {
        let _released = unsafe { timeEndPeriod(self.0) };
    }
}

enum Command {
    Schedule(Vec<KeyPress>),
    Shutdown,
}

#[derive(Default)]
struct Stats {
    sent: u64,
    queued: usize,
    errors: Vec<EngineError>,
}

/// Owner of the permanent input thread: the timed queue lives inside the
/// thread, counters cross over a short-held stats lock.
pub struct InputSender {
    tx: Sender<Command>,
    stats: Arc<Mutex<Stats>>,
    handle: Option<JoinHandle<()>>,
    clock: MonoClock,
    _timer: TimerGuard,
}

impl InputSender {
    /// Start the permanent OS thread with raised timer resolution.
    pub fn start(clock: MonoClock) -> Result<Self, EngineError> {
        let timer = TimerGuard::acquire()?;
        let (tx, rx) = mpsc::channel();
        let stats = Arc::new(Mutex::new(Stats::default()));
        let thread_stats = Arc::clone(&stats);
        let handle = std::thread::Builder::new()
            .name("wme-input".to_string())
            .spawn(move || input_loop(rx, thread_stats, clock))
            .map_err(|e| EngineError::Io {
                detail: format!("input thread spawn failed: {e}"),
                win32: 0,
            })?;
        Ok(InputSender {
            tx,
            stats,
            handle: Some(handle),
            clock,
            _timer: timer,
        })
    }

    /// Queue one schedule. Event times are relative to this call (the
    /// schedule epoch) and merge with whatever is still pending.
    pub fn schedule(&self, presses: &[KeyPress]) -> Result<usize, EngineError> {
        if presses.is_empty() {
            return Err(EngineError::InvalidRequest {
                detail: "empty scancode schedule".to_string(),
            });
        }
        let base = self.clock.now_micros();
        let batch: Vec<KeyPress> = presses
            .iter()
            .map(|press| KeyPress {
                at_micros: base.saturating_add(press.at_micros),
                ..*press
            })
            .collect();
        {
            let mut stats = lock(&self.stats);
            stats.queued += batch.len();
        }
        self.tx
            .send(Command::Schedule(batch))
            .map_err(|_| EngineError::Io {
                detail: "input thread stopped".to_string(),
                win32: 0,
            })
            .map(|_| presses.len())
    }

    /// Presses executed so far.
    pub fn sent(&self) -> u64 {
        lock(&self.stats).sent
    }

    /// Presses waiting on the queue.
    pub fn queued(&self) -> usize {
        lock(&self.stats).queued
    }

    /// Drain recorded `SendInput` failures (nothing is swallowed).
    pub fn take_errors(&mut self) -> Vec<EngineError> {
        std::mem::take(&mut lock(&self.stats).errors)
    }

    /// Stop the input thread and join it. Undelivered presses are cancelled.
    pub fn shutdown(mut self) -> Result<(), EngineError> {
        self.stop()
    }

    fn stop(&mut self) -> Result<(), EngineError> {
        let _nudge = self.tx.send(Command::Shutdown);
        match self.handle.take() {
            Some(join) => match join.join() {
                Ok(()) => Ok(()),
                Err(_) => Err(EngineError::Io {
                    detail: "input thread panicked".to_string(),
                    win32: 0,
                }),
            },
            None => Ok(()),
        }
    }
}

impl Drop for InputSender {
    fn drop(&mut self) {
        // Drop path: shutdown errors cannot be reported to anyone.
        let _stopped = self.stop();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // Poisoned mutex state stays usable; the guarding invariant is
    // cross-thread exclusion, not payload validity.
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn input_loop(rx: Receiver<Command>, stats: Arc<Mutex<Stats>>, clock: MonoClock) {
    type Scheduled = Reverse<(u64, u64, KeyPress)>;
    let mut queue: BinaryHeap<Scheduled> = BinaryHeap::new();
    let mut sequence = 0u64;
    loop {
        let Some(Reverse((due_at, _, _))) = queue.peek().copied() else {
            match rx.recv() {
                Ok(Command::Schedule(batch)) => enqueue(&mut queue, &mut sequence, batch),
                Ok(Command::Shutdown) | Err(_) => break,
            }
            continue;
        };
        let now = clock.now_micros();
        if due_at > now {
            let remaining = due_at - now;
            if remaining > SPIN_THRESHOLD_MICROS {
                match rx.recv_timeout(Duration::from_micros(remaining - SPIN_THRESHOLD_MICROS)) {
                    Ok(Command::Schedule(batch)) => enqueue(&mut queue, &mut sequence, batch),
                    Ok(Command::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => {}
                }
            } else {
                std::hint::spin_loop();
            }
            continue;
        }
        let Some(Reverse((_, _, press))) = queue.pop() else {
            continue;
        };
        match send_scancode(press) {
            Ok(()) => lock(&stats).sent += 1,
            Err(error) => {
                let mut stats = lock(&stats);
                if stats.errors.len() < 32 {
                    stats.errors.push(error);
                }
            }
        }
        lock(&stats).queued -= 1;
    }
}

fn enqueue(queue: &mut BinaryHeap<Reverse<(u64, u64, KeyPress)>>, sequence: &mut u64, batch: Vec<KeyPress>) {
    for press in batch {
        *sequence += 1;
        queue.push(Reverse((press.at_micros, *sequence, press)));
    }
}

// ---------------------------------------------------------------------------
// Win32 boundary functions
// ---------------------------------------------------------------------------

/// Send one hardware-level key event (`KEYEVENTF_SCANCODE`, extended keys
/// flagged with `KEYEVENTF_EXTENDEDKEY`).
fn send_scancode(press: KeyPress) -> Result<(), EngineError> {
    let mut flags = KEYEVENTF_SCANCODE;
    if press.extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if press.release {
        flags |= KEYEVENTF_KEYUP;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: press.scan & 0xFF,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    if sent == 1 {
        Ok(())
    } else {
        let code = unsafe { windows::Win32::Foundation::GetLastError() }.0;
        Err(EngineError::Io {
            detail: format!("SendInput dropped scancode {:#x}", press.scan),
            win32: code,
        })
    }
}

/// Optional virtual-key → scan-code conversion (`MapVirtualKeyW`
/// `MAPVK_VK_TO_VSC_EX`): returns `(make_code, extended)` when mapped.
pub fn resolve_vk(vk: u16) -> Option<(u16, bool)> {
    let mapped = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC_EX) };
    if mapped == 0 {
        return None;
    }
    let prefix = ((mapped >> 8) & 0xFF) as u8;
    let extended = prefix == 0xE0 || prefix == 0xE1;
    Some(((mapped & 0xFF) as u16, extended))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tap(scan: u16, extended: bool, hold_ms: u64, after_ms: u64) -> KeyStepSpec {
        KeyStepSpec {
            scan,
            extended,
            action: KeyAction::Tap,
            hold_ms,
            after_ms,
        }
    }

    #[test]
    fn tap_emits_down_then_up_with_hold() {
        let presses = plan_presses(&[tap(0x1F, false, 30, 0)], 10).expect("plan");
        assert_eq!(presses.len(), 2);
        assert!(!presses[0].release);
        assert!(presses[1].release);
        assert_eq!(presses[0].at_micros, 0);
        assert_eq!(presses[1].at_micros, 30_000);
    }

    #[test]
    fn spacing_defaults_to_interval_and_orders_events() {
        let steps = [
            tap(0x11, false, 5, 0),
            tap(0x12, false, 5, 0),
            tap(0x13, true, 5, 25),
        ];
        let presses = plan_presses(&steps, 10).expect("plan");
        assert_eq!(presses[2].at_micros, 20_000); // second step at 1x interval
        assert_eq!(presses[4].at_micros, 45_000); // third step honors after_ms 25
        assert!(presses[4].extended);
        assert!(presses.windows(2).all(|pair| pair[0].at_micros <= pair[1].at_micros));
    }

    #[test]
    fn hold_longer_than_spacing_never_overlaps_releases() {
        let steps = [tap(0x1F, false, 50, 0), tap(0x20, false, 5, 0)];
        let presses = plan_presses(&steps, 10).expect("plan");
        // Second down must not start before the first key was released.
        assert_eq!(presses[2].at_micros, 50_000);
        assert_eq!(presses[3].at_micros, 55_000);
    }

    #[test]
    fn single_down_and_up_steps_stay_single() {
        let steps = [
            KeyStepSpec {
                scan: 0x1D,
                extended: false,
                action: KeyAction::Down,
                hold_ms: 0,
                after_ms: 0,
            },
            KeyStepSpec {
                scan: 0x1D,
                extended: false,
                action: KeyAction::Up,
                hold_ms: 0,
                after_ms: 0,
            },
        ];
        let presses = plan_presses(&steps, 4).expect("plan");
        assert_eq!(presses.len(), 2);
        assert_eq!(presses[1].at_micros, 4_000);
    }

    #[test]
    fn oversized_schedules_are_coded_overflows() {
        let steps: Vec<KeyStepSpec> = (0..MAX_PENDING_PRESSES)
            .map(|_| tap(0x1F, false, 1, 1))
            .collect();
        assert!(matches!(
            plan_presses(&steps, 1),
            Err(EngineError::InputOverflow { .. })
        ));
    }

    #[test]
    fn empty_plan_is_empty() {
        assert_eq!(plan_presses(&[], 10), Ok(Vec::new()));
    }
}
