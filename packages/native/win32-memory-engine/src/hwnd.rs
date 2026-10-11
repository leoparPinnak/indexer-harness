//! Direct HWND mapping: `EnumWindows`/`EnumChildWindows` traversal plus a
//! coordinate/dirty-stamp UI cache. No `WM_PAINT` hook: the cache is
//! re-measured by a driver-free dirty-rectangle poll loop.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetWindowRect, GetWindowThreadProcessId,
    GetWindowTextW, IsWindowVisible, WNDENUMPROC,
};

use crate::{EngineError, MonoClock};

/// Screen-space rectangle of a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// One HWND with its owning process/thread and current measurement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WindowRecord {
    /// HWND value (stable key within a desktop session).
    pub hwnd: u64,
    pub pid: u32,
    pub thread_id: u32,
    /// Owning top-level HWND; 0 for top-level records.
    pub parent: u64,
    pub class_name: String,
    pub text: String,
    pub rect: Rect,
    pub visible: bool,
}

/// Dirty-stamp fields: a record is dirty when any of these change between
/// two measurements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirtyStamp {
    rect: Rect,
    visible: bool,
    class_name: String,
    text: String,
}

/// Stamp of a freshly measured record.
pub fn stamp_of(record: &WindowRecord) -> DirtyStamp {
    DirtyStamp {
        rect: record.rect,
        visible: record.visible,
        class_name: record.class_name.clone(),
        text: record.text.clone(),
    }
}

/// Whether two measurements differ (the dirty-detection predicate).
pub fn stamp_changed(before: &DirtyStamp, after: &DirtyStamp) -> bool {
    before != after
}

/// Whether `last_micros` is still within `ttl_micros` of `now_micros`
/// (saturating; a clock older than the TTL is stale).
pub fn within_ttl(last_micros: u64, now_micros: u64, ttl_micros: u64) -> bool {
    now_micros.saturating_sub(last_micros) <= ttl_micros
}

/// Why a cache entry changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UiChangeKind {
    Added,
    Updated,
    Removed,
}

/// One cache delta pushed to the host.
#[derive(Debug, Clone, Serialize)]
pub struct UiChange {
    pub kind: UiChangeKind,
    pub hwnd: u64,
    /// Increments on every stamp change; 0 for `Removed`.
    pub version: u64,
    /// `None` for `Removed`.
    pub record: Option<WindowRecord>,
    pub mono_micros: u64,
}

struct CacheEntry {
    record: WindowRecord,
    stamp: DirtyStamp,
    version: u64,
    seen_micros: u64,
}

/// HWND → last record cache with per-entry dirty stamp and TTL freshness.
///
/// `apply` measures against the previous stamp and emits `Added`/`Updated`;
/// HWNDs missing from the measurement set are removed with a `Removed` change
/// (nothing disappears silently). Lookups and snapshots honour the TTL.
pub struct UiCache {
    entries: HashMap<u64, CacheEntry>,
    ttl_micros: u64,
}

impl UiCache {
    pub fn new(ttl_micros: u64) -> Self {
        UiCache {
            entries: HashMap::new(),
            ttl_micros,
        }
    }

    /// Merge one measurement round; returns the deltas in measurement order
    /// followed by removals in ascending HWND order.
    pub fn apply(&mut self, records: Vec<WindowRecord>, now_micros: u64) -> Vec<UiChange> {
        let mut changes = Vec::new();
        let mut seen = Vec::with_capacity(records.len());
        for record in records {
            let hwnd = record.hwnd;
            seen.push(hwnd);
            match self.entries.get_mut(&hwnd) {
                Some(entry) => {
                    let stamp = stamp_of(&record);
                    let changed = stamp_changed(&entry.stamp, &stamp);
                    if changed {
                        entry.version += 1;
                        entry.stamp = stamp;
                        changes.push(UiChange {
                            kind: UiChangeKind::Updated,
                            hwnd,
                            version: entry.version,
                            record: Some(record.clone()),
                            mono_micros: now_micros,
                        });
                    }
                    entry.record = record;
                    entry.seen_micros = now_micros;
                }
                None => {
                    self.entries.insert(
                        hwnd,
                        CacheEntry {
                            stamp: stamp_of(&record),
                            record,
                            version: 1,
                            seen_micros: now_micros,
                        },
                    );
                    changes.push(UiChange {
                        kind: UiChangeKind::Added,
                        hwnd,
                        version: 1,
                        record: self.entries.get(&hwnd).map(|entry| entry.record.clone()),
                        mono_micros: now_micros,
                    });
                }
            }
        }
        let mut gone: Vec<u64> = self
            .entries
            .keys()
            .copied()
            .filter(|hwnd| !seen.contains(hwnd))
            .collect();
        gone.sort_unstable();
        for hwnd in gone {
            self.entries.remove(&hwnd);
            changes.push(UiChange {
                kind: UiChangeKind::Removed,
                hwnd,
                version: 0,
                record: None,
                mono_micros: now_micros,
            });
        }
        changes
    }

    /// Last record of `hwnd` if its measurement is still within the TTL.
    pub fn lookup(&self, hwnd: u64, now_micros: u64) -> Option<&WindowRecord> {
        self.entries
            .get(&hwnd)
            .filter(|entry| within_ttl(entry.seen_micros, now_micros, self.ttl_micros))
            .map(|entry| &entry.record)
    }

    /// All TTL-fresh records.
    pub fn snapshot(&self, now_micros: u64) -> Vec<WindowRecord> {
        self.entries
            .values()
            .filter(|entry| within_ttl(entry.seen_micros, now_micros, self.ttl_micros))
            .map(|entry| entry.record.clone())
            .collect()
    }

    /// Cached HWND count (fresh or stale).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Measure every window of `pid`: matching top-level HWNDs and (optionally)
/// their children.
pub fn collect_windows(pid: u32, include_children: bool) -> Vec<WindowRecord> {
    let mut top_levels = Vec::new();
    let mut ctx = EnumCtx {
        pid,
        parent: 0,
        out: &mut top_levels as *mut Vec<WindowRecord>,
    };
    // Returning FALSE from the callback (our early-exit) makes EnumWindows
    // report failure; the collected records are the intended result.
    let _walked = unsafe { EnumWindows(enum_proc, LPARAM(&mut ctx as *mut _ as isize)) };
    if include_children {
        let parents: Vec<u64> = top_levels.iter().map(|record| record.hwnd).collect();
        for parent in parents {
            let mut children = Vec::new();
            let mut ctx = EnumCtx {
                pid,
                parent,
                out: &mut children as *mut Vec<WindowRecord>,
            };
            let _walked = unsafe {
                EnumChildWindows(
                    Some(HWND(parent as usize as *mut _)),
                    enum_proc,
                    LPARAM(&mut ctx as *mut _ as isize),
                )
            };
            top_levels.append(&mut children);
        }
    }
    top_levels
}

/// Window evidence for the capability ladder: whether `pid` owns any window
/// and whether any of them is visible.
pub fn probe_window_presence(pid: u32) -> (bool, bool) {
    let records = collect_windows(pid, true);
    let found = !records.is_empty();
    let visible = records.iter().any(|record| record.visible);
    (found, visible)
}

/// Handle to the dedicated UI cache poll thread.
pub struct UiPollerHandle {
    rx: Receiver<UiChange>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl UiPollerHandle {
    /// Collect cache deltas since the last call.
    pub fn drain(&self) -> Vec<UiChange> {
        let mut out = Vec::new();
        while let Ok(change) = self.rx.try_recv() {
            out.push(change);
        }
        out
    }

    /// Whether undrained deltas are pending (the dirty flag).
    pub fn has_dirty(&self) -> bool {
        !self.rx.is_empty()
    }

    /// Stop the poll thread and join it.
    pub fn stop(mut self) -> Result<(), EngineError> {
        self.shutdown()
    }

    fn shutdown(&mut self) -> Result<(), EngineError> {
        self.stop.store(true, Ordering::SeqCst);
        match self.join.take() {
            // Drop-time shutdown cannot report; `stop()` surfaces panics.
            Some(join) => match join.join() {
                Ok(()) => Ok(()),
                Err(_) => Err(EngineError::Io {
                    detail: "ui poller thread panicked".to_string(),
                    win32: 0,
                }),
            },
            None => Ok(()),
        }
    }
}

impl Drop for UiPollerHandle {
    fn drop(&mut self) {
        let _joined = self.shutdown();
    }
}

/// Spawn the driver-free dirty-rectangle poll loop for `pid`. `initial` seeds
/// the cache (already reported to the caller, so no duplicate deltas).
pub fn spawn_ui_poller(
    pid: u32,
    include_children: bool,
    interval_micros: u64,
    ttl_micros: u64,
    clock: MonoClock,
    initial: Vec<WindowRecord>,
) -> Result<UiPollerHandle, EngineError> {
    let (tx, rx) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let join = std::thread::Builder::new()
        .name("wme-ui-cache".to_string())
        .spawn(move || {
            let mut cache = UiCache::new(ttl_micros);
            // Seeded records were already reported by the attach caller.
            let _seeded = cache.apply(initial, clock.now_micros());
            while !thread_stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_micros(interval_micros.max(1)));
                let records = collect_windows(pid, include_children);
                for change in cache.apply(records, clock.now_micros()) {
                    if tx.send(change).is_err() {
                        return; // no consumer left; nothing to diff for
                    }
                }
            }
        })
        .map_err(|e| EngineError::Io {
            detail: format!("ui poller thread spawn failed: {e}"),
            win32: 0,
        })?;
    Ok(UiPollerHandle {
        rx,
        stop,
        join: Some(join),
    })
}

struct EnumCtx {
    pid: u32,
    parent: u64,
    out: *mut Vec<WindowRecord>,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumCtx);
    let mut pid = 0u32;
    let thread_id = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != ctx.pid {
        return BOOL(1);
    }
    let record = measure_window(hwnd, pid, thread_id, ctx.parent);
    (*ctx.out).push(record);
    BOOL(1)
}

fn measure_window(hwnd: HWND, pid: u32, thread_id: u32, parent: u64) -> WindowRecord {
    let mut class_buf = [0u16; 256];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class_buf) };
    let mut text_buf = [0u16; 512];
    let text_len = unsafe { GetWindowTextW(hwnd, &mut text_buf) };
    let mut rect = RECT::default();
    // A vanishing window mid-measure leaves a zeroed rectangle; the next
    // poll round drops the HWND from the cache with a Removed change.
    let _measured = unsafe { GetWindowRect(hwnd, &mut rect) };
    WindowRecord {
        hwnd: hwnd.0 as usize as u64,
        pid,
        thread_id,
        parent,
        class_name: utf16_at(&class_buf, class_len.max(0) as usize),
        text: utf16_at(&text_buf, text_len.max(0) as usize),
        rect: Rect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        },
        visible: unsafe { IsWindowVisible(hwnd) }.as_bool(),
    }
}

fn utf16_at(raw: &[u16], len: usize) -> String {
    let end = len.min(raw.len());
    let units = &raw[..end];
    let end = units.iter().position(|unit| *unit == 0).unwrap_or(end);
    String::from_utf16_lossy(&units[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(hwnd: u64, left: i32, text: &str) -> WindowRecord {
        WindowRecord {
            hwnd,
            pid: 7,
            thread_id: 70,
            parent: 0,
            class_name: "MainWindow".to_string(),
            text: text.to_string(),
            rect: Rect {
                left,
                top: 0,
                right: left + 100,
                bottom: 100,
            },
            visible: true,
        }
    }

    #[test]
    fn dirty_stamp_tracks_rect_visibility_and_text() {
        let base = record(1, 10, "abc");
        let stamp = stamp_of(&base);
        assert!(!stamp_changed(&stamp, &stamp_of(&base)));

        let mut moved = base.clone();
        moved.rect.left = 20;
        assert!(stamp_changed(&stamp, &stamp_of(&moved)));

        let mut retitled = base.clone();
        retitled.text = "abd".to_string();
        assert!(stamp_changed(&stamp, &stamp_of(&retitled)));

        let mut hidden = base;
        hidden.visible = false;
        assert!(stamp_changed(&stamp, &stamp_of(&hidden)));
    }

    #[test]
    fn ttl_is_inclusive_and_saturating() {
        assert!(within_ttl(1_000, 1_000, 500));
        assert!(within_ttl(1_000, 1_500, 500));
        assert!(!within_ttl(1_000, 1_501, 500));
        // Clock going backwards stays within the TTL (saturating difference).
        assert!(within_ttl(2_000, 1_000, 500));
    }

    #[test]
    fn cache_emits_added_updated_and_removed() {
        let mut cache = UiCache::new(1_000);
        let changes = cache.apply(vec![record(1, 10, "abc"), record(2, 30, "xyz")], 100);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].kind, UiChangeKind::Added);
        assert_eq!(changes[0].version, 1);

        // Identical re-measurement is quiet.
        let changes = cache.apply(vec![record(1, 10, "abc"), record(2, 30, "xyz")], 200);
        assert!(changes.is_empty());

        // Moved window bumps its version; vanished window is removed.
        let changes = cache.apply(vec![record(2, 35, "xyz")], 300);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].kind, UiChangeKind::Updated);
        assert_eq!(changes[0].hwnd, 2);
        assert_eq!(changes[0].version, 2);
        assert_eq!(changes[1].kind, UiChangeKind::Removed);
        assert_eq!(changes[1].hwnd, 1);
        assert!(changes[1].record.is_none());
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn lookups_expire_after_ttl() {
        let mut cache = UiCache::new(500);
        cache.apply(vec![record(1, 10, "abc")], 1_000);
        assert!(cache.lookup(1, 1_500).is_some());
        assert!(cache.lookup(1, 1_501).is_none());
        assert!(cache.snapshot(1_501).is_empty());
        assert!(cache.snapshot(1_400).len() == 1);
    }
}
