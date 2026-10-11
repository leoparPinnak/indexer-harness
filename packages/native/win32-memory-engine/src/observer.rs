//! Process observation: `OpenProcess` + `ReadProcessMemory`, AOB/pattern-scan
//! resolution, pointer-chain resolution, and the dirty-flag poll thread.
//!
//! Unsafe Win32 calls live only in the boundary functions at the bottom.
//! Everything above them is pure logic over [`ByteSource`], testable with a
//! mock memory stack.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, ERROR_PARTIAL_COPY, HANDLE,
};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
    TH32CS_SNAPMODULE32,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessInformation, OpenProcess, PROCESS_ACCESS_RIGHTS,
    PROCESS_PROTECTION_LEVEL, PROCESS_PROTECTION_LEVEL_INFORMATION, PROCESS_QUERY_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ, ProcessProtectionLevelInfo,
    PROTECTION_LEVEL_ANTIMALWARE_LIGHT, PROTECTION_LEVEL_AUTHENTICODE, PROTECTION_LEVEL_CODEGEN_LIGHT,
    PROTECTION_LEVEL_LSA_LIGHT, PROTECTION_LEVEL_NONE, PROTECTION_LEVEL_PPL_APP,
    PROTECTION_LEVEL_WINDOWS, PROTECTION_LEVEL_WINDOWS_LIGHT, PROTECTION_LEVEL_WINTCB,
    PROTECTION_LEVEL_WINTCB_LIGHT,
};

use crate::policy::TargetClass;
use crate::{EngineError, MonoClock, ValueType};

/// Still-active exit code reported by `GetExitCodeProcess` (Win32 `STILL_ACTIVE`).
const STILL_ACTIVE: u32 = 259;
/// ToolHelp enumeration end marker (Win32 `ERROR_NO_MORE_FILES`).
const ERROR_NO_MORE_FILES: u32 = 18;
/// Default AOB scan chunk: how many bytes per `ReadProcessMemory` call.
pub const DEFAULT_SCAN_CHUNK: usize = 64 * 1024;

/// Readable process memory. Production impl: [`ProcessReader`]; tests use a
/// mock byte stack.
pub trait ByteSource {
    /// Read `out.len()` bytes starting at `addr`.
    fn read_bytes(&self, addr: usize, out: &mut [u8]) -> Result<(), EngineError>;
}

/// Parsed AOB signature: known bytes interleaved with `??` wildcards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern {
    text: String,
    tokens: Vec<Option<u8>>,
}

impl Pattern {
    /// Token count; matches shorter than this never hit.
    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    /// Whether the pattern has no tokens (always false for parsed patterns).
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    /// Original signature text as supplied by the caller.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Whether the pattern matches `hay` starting at `at`.
    pub fn matches_at(&self, hay: &[u8], at: usize) -> bool {
        if at + self.tokens.len() > hay.len() {
            return false;
        }
        self.tokens
            .iter()
            .zip(&hay[at..at + self.tokens.len()])
            .all(|(want, got)| want.is_none_or(|want| want == *got))
    }
}

/// Parse a whitespace-separated byte signature: `48 8B ?? 1F`. Wildcards are
/// exactly `??`; every other token is two hex digits.
pub fn parse_pattern(text: &str) -> Result<Pattern, EngineError> {
    let mut tokens = Vec::new();
    for token in text.split_whitespace() {
        if token == "??" {
            tokens.push(None);
        } else if token.len() == 2 && token.bytes().all(|b| b.is_ascii_hexdigit()) {
            tokens.push(Some(
                u8::from_str_radix(token, 16).expect("validated two hex digits"),
            ));
        } else {
            return Err(EngineError::InvalidPattern {
                detail: format!("invalid pattern token '{token}'"),
            });
        }
    }
    if tokens.is_empty() {
        return Err(EngineError::InvalidPattern {
            detail: "empty pattern".to_string(),
        });
    }
    Ok(Pattern {
        text: text.to_string(),
        tokens,
    })
}

/// First offset in `hay` where `pattern` matches, if any.
pub fn find_pattern(hay: &[u8], pattern: &Pattern) -> Option<usize> {
    if hay.len() < pattern.len() {
        return None;
    }
    (0..=hay.len() - pattern.len()).find(|at| pattern.matches_at(hay, *at))
}

/// Scan `[base, base + size)` for `pattern` in `chunk_len`-sized reads.
/// Chunks overlap by `pattern.len() - 1` carry bytes so matches straddling a
/// chunk boundary are found. Returns the first (lowest) match address.
pub fn scan_span(
    source: &dyn ByteSource,
    base: usize,
    size: usize,
    pattern: &Pattern,
    chunk_len: usize,
) -> Result<Option<usize>, EngineError> {
    if chunk_len == 0 {
        return Err(EngineError::InvalidPattern {
            detail: "scan chunk_len must be greater than zero".to_string(),
        });
    }
    let carry_max = pattern.len() - 1;
    let mut buf = vec![0u8; chunk_len];
    let mut window = Vec::with_capacity(chunk_len + carry_max);
    let mut carry: Vec<u8> = Vec::with_capacity(carry_max);
    let mut offset = 0usize;
    while offset < size {
        let read_len = chunk_len.min(size - offset);
        source.read_bytes(base + offset, &mut buf[..read_len])?;
        let window_addr = base + offset - carry.len();
        window.clear();
        window.extend_from_slice(&carry);
        window.extend_from_slice(&buf[..read_len]);
        if let Some(hit) = find_pattern(&window, pattern) {
            return Ok(Some(window_addr + hit));
        }
        let kept = carry_max.min(read_len);
        carry.clear();
        carry.extend_from_slice(&buf[read_len - kept..read_len]);
        offset += read_len;
    }
    Ok(None)
}

/// Resolve `pattern` inside the named module (ASCII case-insensitive base
/// name match) and return the hit address.
pub fn scan_module(
    source: &dyn ByteSource,
    modules: &[ModuleInfo],
    module: &str,
    pattern: &Pattern,
) -> Result<usize, EngineError> {
    let target = modules
        .iter()
        .find(|m| m.name.eq_ignore_ascii_case(module))
        .ok_or_else(|| EngineError::NotFound {
            detail: format!("module '{module}' not present in target"),
        })?;
    scan_span(source, target.base, target.size as usize, pattern, DEFAULT_SCAN_CHUNK)?.ok_or_else(
        || EngineError::NotFound {
            detail: format!("pattern '{}' not found in '{}'", pattern.text(), target.name),
        },
    )
}

/// Read one little-endian pointer (`width` bytes: 4 or 8) at `addr`.
pub fn read_pointer(
    source: &dyn ByteSource,
    addr: usize,
    width: usize,
) -> Result<usize, EngineError> {
    match width {
        4 => {
            let mut raw = [0u8; 4];
            source.read_bytes(addr, &mut raw)?;
            Ok(u32::from_le_bytes(raw) as usize)
        }
        8 => {
            let mut raw = [0u8; 8];
            source.read_bytes(addr, &mut raw)?;
            Ok(u64::from_le_bytes(raw) as usize)
        }
        _ => Err(EngineError::BadPointerChain {
            detail: format!("pointer width {width} is not 4 or 8"),
        }),
    }
}

/// Walk the pointer chain `[[[base+off0]+off1]…]+offN`: each intermediate
/// location is dereferenced at `width` bytes, the final offset is added
/// without dereferencing. An empty `offsets` list returns `base` unchanged.
pub fn resolve_pointer_chain(
    source: &dyn ByteSource,
    base: usize,
    offsets: &[i64],
    width: usize,
) -> Result<usize, EngineError> {
    let mut addr = base;
    for (step, offset) in offsets.iter().enumerate() {
        addr = add_offset(addr, *offset)?;
        if step + 1 < offsets.len() {
            addr = read_pointer(source, addr, width)?;
        }
    }
    Ok(addr)
}

fn add_offset(addr: usize, offset: i64) -> Result<usize, EngineError> {
    let landed = if offset >= 0 {
        addr.checked_add(offset as usize)
    } else {
        addr.checked_sub(offset.unsigned_abs() as usize)
    };
    landed.ok_or_else(|| EngineError::OutOfRange {
        detail: format!("pointer chain offset {offset} overflows from {addr:#x}"),
    })
}

/// One watched scalar location.
#[derive(Debug, Clone)]
pub struct WatchSpec {
    /// Stable key reported on every observation.
    pub key: String,
    /// Resolved address of the scalar.
    pub address: usize,
    /// Scalar layout of the bytes at `address`.
    pub value_type: ValueType,
}

/// One sample of a watched location. `error` is set instead of `value` when
/// the read or decode failed; error-only observations are emitted when the
/// failure is new or its code changed.
#[derive(Debug, Clone)]
pub struct Observation {
    pub key: String,
    pub address: usize,
    pub value_type: ValueType,
    pub bytes: Vec<u8>,
    /// Decoded scalar value, `None` on failure or for undecodable payloads.
    pub value: Option<serde_json::Value>,
    pub error: Option<EngineError>,
    /// True on the first sample (and on the first sample after a failure).
    pub first: bool,
    /// Monotonic microsecond timestamp of the sample.
    pub mono_micros: u64,
}

/// Handle to the dedicated poll thread: dirty flag + observation channel.
pub struct WatcherHandle {
    rx: Receiver<Observation>,
    stop: Arc<AtomicBool>,
    dirty: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl WatcherHandle {
    /// Collect every observation queued since the last call.
    pub fn drain(&self) -> Vec<Observation> {
        self.dirty.store(false, Ordering::SeqCst);
        let mut out = Vec::new();
        while let Ok(observation) = self.rx.try_recv() {
            out.push(observation);
        }
        out
    }

    /// Whether undrained changes are pending (the dirty flag).
    pub fn has_dirty(&self) -> bool {
        self.dirty.load(Ordering::SeqCst)
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
                    detail: "observer thread panicked".to_string(),
                    win32: 0,
                }),
            },
            None => Ok(()),
        }
    }
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        let _joined = self.shutdown();
    }
}

/// Spawn the dedicated poll thread: re-reads every spec on `interval_micros`
/// and emits an [`Observation`] on first sight, on change, and on new read
/// failures.
pub fn spawn_watcher(
    source: Arc<dyn ByteSource + Send + Sync>,
    specs: Vec<WatchSpec>,
    interval_micros: u64,
    clock: MonoClock,
) -> Result<WatcherHandle, EngineError> {
    if specs.is_empty() {
        return Err(EngineError::InvalidRequest {
            detail: "cannot watch an empty spec list".to_string(),
        });
    }
    let (tx, rx) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let dirty = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread_dirty = Arc::clone(&dirty);
    let join = std::thread::Builder::new()
        .name("wme-observer".to_string())
        .spawn(move || {
            watch_loop(source, specs, interval_micros, clock, tx, thread_stop, thread_dirty)
        })
        .map_err(|e| EngineError::Io {
            detail: format!("observer thread spawn failed: {e}"),
            win32: 0,
        })?;
    Ok(WatcherHandle {
        rx,
        stop,
        dirty,
        join: Some(join),
    })
}

fn watch_loop(
    source: Arc<dyn ByteSource + Send + Sync>,
    specs: Vec<WatchSpec>,
    interval_micros: u64,
    clock: MonoClock,
    tx: Sender<Observation>,
    stop: Arc<AtomicBool>,
    dirty: Arc<AtomicBool>,
) {
    let scratch_len = specs
        .iter()
        .map(|spec| spec.value_type.byte_len())
        .max()
        .unwrap_or(0);
    let mut scratch = vec![0u8; scratch_len];
    let mut samples: Vec<Option<Vec<u8>>> = (0..specs.len()).map(|_| None).collect();
    let mut last_error: Vec<Option<&'static str>> = (0..specs.len()).map(|_| None).collect();
    while !stop.load(Ordering::SeqCst) {
        for (index, spec) in specs.iter().enumerate() {
            let size = spec.value_type.byte_len();
            match source.read_bytes(spec.address, &mut scratch[..size]) {
                Ok(()) => {
                    let changed = samples[index].as_deref() != Some(&scratch[..size]);
                    if changed {
                        let bytes = scratch[..size].to_vec();
                        let first = samples[index].is_none();
                        samples[index] = Some(bytes.clone());
                        last_error[index] = None;
                        let (value, error) =
                            match crate::decode_scalar(spec.value_type, &bytes) {
                                Ok(value) => (Some(value), None),
                                Err(error) => (None, Some(error)),
                            };
                        let observation = Observation {
                            value,
                            error,
                            key: spec.key.clone(),
                            address: spec.address,
                            value_type: spec.value_type,
                            bytes,
                            first,
                            mono_micros: clock.now_micros(),
                        };
                        if tx.send(observation).is_err() {
                            return; // no consumer left; nothing to observe for
                        }
                        dirty.store(true, Ordering::SeqCst);
                    }
                }
                Err(error) => {
                    let code = error.code();
                    let fresh = last_error[index] != Some(code);
                    if samples[index].is_some() || fresh {
                        samples[index] = None;
                        last_error[index] = Some(code);
                        let observation = Observation {
                            key: spec.key.clone(),
                            address: spec.address,
                            value_type: spec.value_type,
                            bytes: Vec::new(),
                            value: None,
                            error: Some(error),
                            first: false,
                            mono_micros: clock.now_micros(),
                        };
                        if tx.send(observation).is_err() {
                            return;
                        }
                        dirty.store(true, Ordering::SeqCst);
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_micros(interval_micros.max(1)));
    }
}

/// Loaded module of the target process (AOB scan target).
#[derive(Debug, Clone)]
pub struct ModuleInfo {
    pub name: String,
    pub base: usize,
    pub size: u32,
}

/// Outcome of the classified `OpenProcess` attempt: the reader when VM read
/// access was granted, plus the protection class written from the denial
/// path. Nothing is swallowed: the Win32 code of a refusal is preserved.
#[derive(Debug)]
pub struct OpenReport {
    pub reader: Option<ProcessReader>,
    pub class: TargetClass,
    /// `ERROR_ACCESS_DENIED` distinguished from other refusals.
    pub access_denied: bool,
    pub win32: Option<u32>,
}

/// Open the target for `ReadProcessMemory` with rights classification.
///
/// On `ERROR_ACCESS_DENIED` the target is additionally probed with
/// `PROCESS_QUERY_LIMITED_INFORMATION` to label its protection level into
/// [`TargetClass`]; the restricted handle is closed afterwards and no read is
/// attempted through it.
pub fn open_read(pid: u32) -> OpenReport {
    let rights: PROCESS_ACCESS_RIGHTS =
        PROCESS_VM_READ | PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION;
    match open_process_rights(pid, rights) {
        Ok(handle) => {
            let mut class = query_protection_class(handle);
            if class == TargetClass::Unprobed {
                class = TargetClass::Normal;
            }
            OpenReport {
                reader: Some(ProcessReader::from_handle(pid, handle)),
                class,
                access_denied: false,
                win32: None,
            }
        }
        Err(code) => {
            let access_denied = code == ERROR_ACCESS_DENIED.0;
            if access_denied {
                match open_process_rights(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
                    Ok(probe) => {
                        let class = query_protection_class(probe);
                        close_handle(probe);
                        OpenReport {
                            reader: None,
                            class,
                            access_denied: true,
                            win32: Some(code),
                        }
                    }
                    Err(inner) => OpenReport {
                        reader: None,
                        class: class_from_refusal(inner),
                        access_denied: true,
                        win32: Some(code),
                    },
                }
            } else {
                OpenReport {
                    reader: None,
                    class: class_from_refusal(code),
                    access_denied,
                    win32: Some(code),
                }
            }
        }
    }
}

fn class_from_refusal(code: u32) -> TargetClass {
    if code == ERROR_INVALID_PARAMETER.0 {
        TargetClass::Gone
    } else {
        TargetClass::ProtectedUnknown
    }
}

/// Read handle to a target process (READ side; writes live in [`crate::writer`]).
pub struct ProcessReader {
    handle: HANDLE,
    pid: u32,
}

impl ProcessReader {
    fn from_handle(pid: u32, handle: HANDLE) -> Self {
        ProcessReader { handle, pid }
    }

    /// Target process id.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Read `out.len()` bytes at `addr`. Failures are reported with the
    /// Win32 code: a dead target surfaces as [`EngineError::ProcessEnded`].
    pub fn read_at(&self, addr: usize, out: &mut [u8]) -> Result<(), EngineError> {
        read_process_memory(self.handle, addr, out).map_err(|code| {
            if !self.alive() {
                EngineError::ProcessEnded {
                    detail: format!("target {} exited during read (win32 {code})", self.pid),
                }
            } else if code == ERROR_PARTIAL_COPY.0 || code == ERROR_INVALID_PARAMETER.0 {
                EngineError::OutOfRange {
                    detail: format!("unreadable range at {addr:#x} (win32 {code})"),
                }
            } else if code == ERROR_ACCESS_DENIED.0 {
                EngineError::AccessDenied {
                    detail: format!("read denied at {addr:#x}",),
                    win32: code,
                }
            } else {
                EngineError::ReadFailed {
                    detail: format!("ReadProcessMemory at {addr:#x} failed"),
                    win32: code,
                }
            }
        })
    }

    /// Whether the target process still runs (`GetExitCodeProcess`).
    pub fn alive(&self) -> bool {
        exit_code(self.handle) == Some(STILL_ACTIVE)
    }
}

impl ByteSource for ProcessReader {
    fn read_bytes(&self, addr: usize, out: &mut [u8]) -> Result<(), EngineError> {
        self.read_at(addr, out)
    }
}

impl Drop for ProcessReader {
    fn drop(&mut self) {
        close_handle(self.handle);
    }
}

// The Win32 process handle is safe to share: `ReadProcessMemory` is
// thread-safe and the handle is owned by this type alone.
unsafe impl Send for ProcessReader {}
unsafe impl Sync for ProcessReader {}

/// List the loaded modules of `pid` (AOB targets).
pub fn list_modules(pid: u32) -> Result<Vec<ModuleInfo>, EngineError> {
    let snapshot =
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) }
            .map_err(|e| {
                let code = crate::win32_code(&e);
                if code == ERROR_INVALID_PARAMETER.0 {
                    EngineError::NotFound {
                        detail: format!("process {pid} not found (win32 {code})"),
                    }
                } else {
                    EngineError::Io {
                        detail: format!("module snapshot of {pid} failed"),
                        win32: code,
                    }
                }
            })?;
    let mut modules = Vec::new();
    let mut entry = MODULEENTRY32W {
        dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
        ..Default::default()
    };
    if let Err(e) = unsafe { Module32FirstW(snapshot, &mut entry) } {
        close_handle(snapshot);
        return Err(from_module_enum_error(e));
    }
    push_module(&mut modules, &entry);
    loop {
        match unsafe { Module32NextW(snapshot, &mut entry) } {
            Ok(()) => push_module(&mut modules, &entry),
            Err(e) => {
                let code = crate::win32_code(&e);
                if code == ERROR_NO_MORE_FILES {
                    break;
                }
                close_handle(snapshot);
                return Err(EngineError::Io {
                    detail: "Module32NextW failed".to_string(),
                    win32: code,
                });
            }
        }
    }
    close_handle(snapshot);
    Ok(modules)
}

fn push_module(modules: &mut Vec<ModuleInfo>, entry: &MODULEENTRY32W) {
    modules.push(ModuleInfo {
        name: utf16_trimmed(&entry.szModule),
        base: entry.modBaseAddr as usize,
        size: entry.modBaseSize,
    });
}

fn from_module_enum_error(e: windows::core::Error) -> EngineError {
    let code = crate::win32_code(&e);
    if code == ERROR_NO_MORE_FILES {
        EngineError::NotFound {
            detail: "target has no enumerable modules".to_string(),
        }
    } else {
        EngineError::Io {
            detail: "Module32FirstW failed".to_string(),
            win32: code,
        }
    }
}

fn utf16_trimmed(raw: &[u16]) -> String {
    let end = raw.iter().position(|unit| *unit == 0).unwrap_or(raw.len());
    String::from_utf16_lossy(&raw[..end])
}

// ---------------------------------------------------------------------------
// Win32 boundary functions
// ---------------------------------------------------------------------------

fn open_process_rights(pid: u32, rights: PROCESS_ACCESS_RIGHTS) -> Result<HANDLE, u32> {
    unsafe { OpenProcess(rights, false, pid) }.map_err(|e| crate::win32_code(&e))
}

fn read_process_memory(handle: HANDLE, addr: usize, out: &mut [u8]) -> Result<(), u32> {
    let mut read = 0usize;
    unsafe {
        ReadProcessMemory(
            handle,
            addr as *const _,
            out.as_mut_ptr() as *mut _,
            out.len(),
            Some(&mut read),
        )
    }
    .map_err(crate::win32_code)?;
    if read != out.len() {
        return Err(ERROR_PARTIAL_COPY.0);
    }
    Ok(())
}

fn exit_code(handle: HANDLE) -> Option<u32> {
    let mut code = 0u32;
    unsafe { GetExitCodeProcess(handle, &mut code) }.ok()?;
    Some(code)
}

fn close_handle(handle: HANDLE) {
    // Drop path: a failed CloseHandle cannot be reported to anyone.
    let _closed = unsafe { CloseHandle(handle) };
}

fn query_protection_class(handle: HANDLE) -> TargetClass {
    let mut info = PROCESS_PROTECTION_LEVEL_INFORMATION::default();
    let queried = unsafe {
        GetProcessInformation(
            handle,
            ProcessProtectionLevelInfo,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<PROCESS_PROTECTION_LEVEL_INFORMATION>() as u32,
        )
    };
    if queried.is_err() {
        return TargetClass::Unprobed;
    }
    class_from_protection(info.ProtectionLevel)
}

fn class_from_protection(level: PROCESS_PROTECTION_LEVEL) -> TargetClass {
    let light = level == PROTECTION_LEVEL_WINTCB_LIGHT
        || level == PROTECTION_LEVEL_WINDOWS_LIGHT
        || level == PROTECTION_LEVEL_ANTIMALWARE_LIGHT
        || level == PROTECTION_LEVEL_LSA_LIGHT
        || level == PROTECTION_LEVEL_CODEGEN_LIGHT
        || level == PROTECTION_LEVEL_PPL_APP;
    let full = level == PROTECTION_LEVEL_WINTCB
        || level == PROTECTION_LEVEL_WINDOWS
        || level == PROTECTION_LEVEL_AUTHENTICODE;
    if light {
        TargetClass::ProtectedProcessLight
    } else if full {
        TargetClass::ProtectedProcess
    } else if level == PROTECTION_LEVEL_NONE {
        TargetClass::Normal
    } else {
        TargetClass::ProtectedUnknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mock byte stack: flat Vec hosted at `base`, bounds-checked.
    struct MockMemory {
        base: usize,
        bytes: Vec<u8>,
    }

    impl MockMemory {
        fn at(base: usize, bytes: Vec<u8>) -> Self {
            MockMemory { base, bytes }
        }
    }

    impl ByteSource for MockMemory {
        fn read_bytes(&self, addr: usize, out: &mut [u8]) -> Result<(), EngineError> {
            let start = addr
                .checked_sub(self.base)
                .filter(|start| start + out.len() <= self.bytes.len())
                .ok_or_else(|| EngineError::OutOfRange {
                    detail: format!("mock range {addr:#x}+{}", out.len()),
                })?;
            out.copy_from_slice(&self.bytes[start..start + out.len()]);
            Ok(())
        }
    }

    fn plant_pointer(mem: &mut MockMemory, addr: usize, value: usize) {
        let start = addr - mem.base;
        let raw = (value as u64).to_le_bytes();
        mem.bytes[start..start + 8].copy_from_slice(&raw);
    }

    #[test]
    fn parses_hex_tokens_and_wildcards() {
        let pattern = parse_pattern("48 8b ?? 1F").expect("valid pattern");
        assert_eq!(pattern.len(), 4);
        assert!(pattern.matches_at(&[0x48, 0x8b, 0x00, 0x1f], 0));
        assert!(!pattern.matches_at(&[0x48, 0x8c, 0x00, 0x1f], 0));
    }

    #[test]
    fn rejects_malformed_patterns() {
        assert!(matches!(
            parse_pattern("48 8"),
            Err(EngineError::InvalidPattern { .. })
        ));
        assert!(matches!(
            parse_pattern("zz 8b"),
            Err(EngineError::InvalidPattern { .. })
        ));
        assert!(matches!(
            parse_pattern("? 8b"),
            Err(EngineError::InvalidPattern { .. })
        ));
        assert!(matches!(
            parse_pattern("   "),
            Err(EngineError::InvalidPattern { .. })
        ));
    }

    #[test]
    fn finds_first_match_with_wildcards() {
        let pattern = parse_pattern("de ?? be").expect("valid");
        let hay = [0x00, 0xde, 0xaa, 0xbe, 0xde, 0x11, 0xbe];
        assert_eq!(find_pattern(&hay, &pattern), Some(1));
        assert_eq!(find_pattern(&[0xde, 0x00], &pattern), None);
    }

    #[test]
    fn scan_finds_match_straddling_chunk_boundary() {
        // Chunk length 4 with pattern at bytes 3..6: crosses every boundary.
        let mut bytes = vec![0u8; 16];
        bytes[3] = 0x11;
        bytes[4] = 0x22;
        bytes[5] = 0x33;
        let mem = MockMemory::at(0x1000, bytes);
        let pattern = parse_pattern("11 22 33").expect("valid");
        let hit = scan_span(&mem, 0x1000, 16, &pattern, 4).expect("scan");
        assert_eq!(hit, Some(0x1003));
    }

    #[test]
    fn scan_reports_missing_match_and_bad_ranges() {
        let mem = MockMemory::at(0x4000, vec![0u8; 8]);
        let pattern = parse_pattern("aa bb").expect("valid");
        assert_eq!(scan_span(&mem, 0x4000, 8, &pattern, 4), Ok(None));
        assert!(scan_span(&mem, 0x4000, 8, &pattern, 0).is_err());
        // Reading past the mock stack surfaces a coded range error.
        assert!(matches!(
            scan_span(&mem, 0x4000, 32, &pattern, 16),
            Err(EngineError::OutOfRange { .. })
        ));
    }

    #[test]
    fn resolves_multilevel_pointer_chain() {
        // chain: [[[0x2000]+0x10]+0x8]  ->  node1 @0x3000, node2 @0x3100, hit 0x5000
        let mut mem = MockMemory::at(0x2000, vec![0u8; 0x1200]);
        plant_pointer(&mut mem, 0x2000, 0x3000);
        plant_pointer(&mut mem, 0x3010, 0x3100);
        let target = resolve_pointer_chain(&mem, 0x2000, &[0, 0x10, 0x8], 8).expect("chain");
        assert_eq!(target, 0x3108);
    }

    #[test]
    fn empty_offsets_return_base() {
        let mem = MockMemory::at(0, Vec::new());
        assert_eq!(resolve_pointer_chain(&mem, 0x1234, &[], 8), Ok(0x1234));
    }

    #[test]
    fn reads_four_byte_pointers() {
        let mut mem = MockMemory::at(0x100, vec![0u8; 8]);
        mem.bytes[0..4].copy_from_slice(&0xAABB_CCDD_u32.to_le_bytes());
        assert_eq!(read_pointer(&mem, 0x100, 4), Ok(0xAABB_CCDD));
        assert!(matches!(
            read_pointer(&mem, 0x100, 3),
            Err(EngineError::BadPointerChain { .. })
        ));
    }

    #[test]
    fn rejects_overflowing_chain_offsets() {
        let mem = MockMemory::at(0, vec![0u8; 32]);
        assert!(matches!(
            resolve_pointer_chain(&mem, 0x10, &[-0x20], 8),
            Err(EngineError::OutOfRange { .. })
        ));
        assert!(matches!(
            resolve_pointer_chain(&mem, usize::MAX, &[1], 8),
            Err(EngineError::OutOfRange { .. })
        ));
    }

    #[test]
    fn scan_module_matches_by_basename() {
        let mut bytes = vec![0u8; 8];
        bytes[2] = 0xca;
        bytes[3] = 0xfe;
        let mem = MockMemory::at(0x7FF0_0000, bytes);
        let modules = vec![
            ModuleInfo {
                name: "ntdll.dll".to_string(),
                base: 0x1000,
                size: 0x1000,
            },
            ModuleInfo {
                name: "Game.EXE".to_string(),
                base: 0x7FF0_0000,
                size: 8,
            },
        ];
        let pattern = parse_pattern("ca fe").expect("valid");
        let hit = scan_module(&mem, &modules, "game.exe", &pattern).expect("hit");
        assert_eq!(hit, 0x7FF0_0002);
        assert!(matches!(
            scan_module(&mem, &modules, "absent.dll", &pattern),
            Err(EngineError::NotFound { .. })
        ));
    }
}
