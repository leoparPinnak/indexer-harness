//! hwndmap — Direct HWND Mapping: PID → pencere listesi + UI önbelleği.
//!
//! `EnumWindows` taraması tek geçişte sınıf, başlık, geometri, sahiplik ve
//! görünürlük toplar. Sonuç `HashMap<pid, Vec<WindowRec>>` olarak saklanır;
//! damga değişmediyse TTL dolmadan yeniden taranmaz (kirli-damga/TTL).

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindow, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
};

#[derive(Debug, Clone, Hash, PartialEq)]
pub struct WindowRec {
    pub hwnd: u64,
    pub pid: u32,
    pub tid: u32,
    pub class: String,
    pub title: String,
    pub rect: (i32, i32, i32, i32),
    pub owned: bool,
    pub visible: bool,
}

#[derive(Default)]
struct Collected {
    by_pid: HashMap<u32, Vec<WindowRec>>,
}

unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Collected);
    let mut pid = 0u32;
    let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));

    let mut class_buf = [0u16; 256];
    let clen = GetClassNameW(hwnd, &mut class_buf);
    let class = String::from_utf16_lossy(&class_buf[..clen as usize]);

    let tlen = GetWindowTextLengthW(hwnd) as usize;
    let mut title_buf = vec![0u16; tlen + 1];
    let wlen = GetWindowTextW(hwnd, &mut title_buf);
    let title = String::from_utf16_lossy(&title_buf[..wlen as usize]);

    let mut rc = RECT::default();
    let rect = match GetWindowRect(hwnd, &mut rc) {
        Ok(_) => (rc.left, rc.top, rc.right, rc.bottom),
        Err(_) => (0, 0, 0, 0),
    };

    out.by_pid.entry(pid).or_default().push(WindowRec {
        hwnd: hwnd.0 as u64,
        pid,
        tid,
        class,
        title,
        rect,
        owned: GetWindow(hwnd, GW_OWNER).is_ok(),
        visible: IsWindowVisible(hwnd).as_bool(),
    });
    TRUE
}

/// Tüm masaüstünün tek geçiş eşlemesi.
pub fn map_desktop() -> io::Result<HashMap<u32, Vec<WindowRec>>> {
    let mut collected = Collected::default();
    unsafe {
        EnumWindows(Some(enum_cb), LPARAM(&mut collected as *mut Collected as isize))
            .map_err(|e| io::Error::from_raw_os_error(e.code().0))?;
    }
    Ok(collected.by_pid)
}

/// Kirli-damga + TTL önbelleği: damga (hedeflerin içerik özeti) değişmedikçe
/// ve TTL dolmadıkça tarama tekrarlanmaz.
pub struct UiCache {
    ttl: Duration,
    last_scan: Option<Instant>,
    last_stamp: u64,
    map: HashMap<u32, Vec<WindowRec>>,
}

impl UiCache {
    pub fn new(ttl: Duration) -> Self {
        Self { ttl, last_scan: None, last_stamp: 0, map: HashMap::new() }
    }

    fn stamp(map: &HashMap<u32, Vec<WindowRec>>) -> u64 {
        let mut h = DefaultHasher::new();
        for (pid, wins) in map {
            pid.hash(&mut h);
            wins.hash(&mut h);
        }
        h.finish()
    }

    /// Gerekliyse yeniden tarar; `(canlı_veri, yenilendi_mi)` döner.
    pub fn poll(&mut self) -> io::Result<(&HashMap<u32, Vec<WindowRec>>, bool)> {
        let fresh = match self.last_scan {
            None => true,
            Some(t) => t.elapsed() >= self.ttl,
        };
        if fresh {
            let map = map_desktop()?;
            let stamp = Self::stamp(&map);
            let changed = stamp != self.last_stamp;
            self.map = map;
            self.last_stamp = stamp;
            self.last_scan = Some(Instant::now());
            return Ok((&self.map, changed));
        }
        Ok((&self.map, false))
    }

    pub fn windows_of(&self, pid: u32) -> Option<&Vec<WindowRec>> {
        self.map.get(&pid)
    }
}