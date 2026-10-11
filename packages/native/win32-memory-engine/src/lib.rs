//! win32-memory-engine: C-ABI surface with one JSON line in, one JSON line
//! out. Thin boundary style in the shape of `sandbox-windows-acl/src/ffi.ts`:
//! documented wrappers around a cached engine state, no hidden behavior.
//!
//! Envelope: `{"ok":true,"data":…}` or
//! `{"ok":false,"error":{"code","detail","win32"},"data":…}` where `data`
//! accompanies a refusal when the probe produced usable assessment data.

mod hwnd;
mod input;
mod observer;
mod policy;
mod writer;

use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, GetLastError, LUID, ERROR_NOT_ALL_ASSIGNED};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub use hwnd::{
    probe_window_presence, spawn_ui_poller, stamp_changed, stamp_of, within_ttl, Rect, UiCache,
    UiChange, UiChangeKind, UiPollerHandle, WindowRecord,
};
pub use input::{
    plan_presses, resolve_vk, InputSender, KeyAction, KeyPress, KeyStepSpec, TimerGuard,
    DEFAULT_HOLD_MS, MAX_PENDING_PRESSES,
};
pub use observer::{
    find_pattern, list_modules, open_read, parse_pattern, read_pointer, resolve_pointer_chain,
    scan_module, scan_span, spawn_watcher, ByteSource, ModuleInfo, Observation, OpenReport,
    Pattern, ProcessReader, WatchSpec, WatcherHandle, DEFAULT_SCAN_CHUNK,
};
pub use policy::{
    classify, descend, probe_target, require, Capability, ProbeAttempt, ProbeEvidence,
    TargetAssessment, TargetClass, TargetProbe,
};
pub use writer::{
    check_scope, Authorizer, ByteSink, CallbackAuthorizer, DenyAuthorizer, MemoryActuator,
    ProcessWriter, WriteOp,
};

/// Coded engine error: every refusal names its cause and keeps the Win32 code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// Handle denied by the OS (`ERROR_ACCESS_DENIED` class).
    AccessDenied { detail: String, win32: u32 },
    /// Target process exited.
    ProcessEnded { detail: String },
    /// Named entity (process, module, key) does not exist.
    NotFound { detail: String },
    /// Malformed AOB signature.
    InvalidPattern { detail: String },
    /// Address or span leaves the permitted range.
    OutOfRange { detail: String },
    /// Pointer chain cannot be walked (width, unreadable link).
    BadPointerChain { detail: String },
    /// Confirmation hook or capability gate declined the operation.
    Rejected { detail: String },
    /// Protected (PPL/anti-cheat class) target: refused terminally.
    Protected { detail: String },
    /// `ReadProcessMemory` failure with a residual Win32 code.
    ReadFailed { detail: String, win32: u32 },
    /// `WriteProcessMemory` failure with a residual Win32 code.
    WriteFailed { detail: String, win32: u32 },
    /// Input queue or schedule above the cap.
    InputOverflow { detail: String },
    /// Ill-formed request or parameter combination.
    InvalidRequest { detail: String },
    /// Win32 boundary failure that fits no category above.
    Io { detail: String, win32: u32 },
}

impl EngineError {
    /// Stable machine code (wire contract with the host).
    pub fn code(&self) -> &'static str {
        match self {
            EngineError::AccessDenied { .. } => "E_ACCESS_DENIED",
            EngineError::ProcessEnded { .. } => "E_PROCESS_ENDED",
            EngineError::NotFound { .. } => "E_NOT_FOUND",
            EngineError::InvalidPattern { .. } => "E_INVALID_PATTERN",
            EngineError::OutOfRange { .. } => "E_OUT_OF_RANGE",
            EngineError::BadPointerChain { .. } => "E_BAD_POINTER_CHAIN",
            EngineError::Rejected { .. } => "E_REJECTED",
            EngineError::Protected { .. } => "E_PROTECTED_TARGET",
            EngineError::ReadFailed { .. } => "E_READ_FAILED",
            EngineError::WriteFailed { .. } => "E_WRITE_FAILED",
            EngineError::InputOverflow { .. } => "E_INPUT_OVERFLOW",
            EngineError::InvalidRequest { .. } => "E_INVALID_REQUEST",
            EngineError::Io { .. } => "E_IO",
        }
    }

    /// Human-readable explanation.
    pub fn detail(&self) -> &str {
        match self {
            EngineError::AccessDenied { detail, .. }
            | EngineError::ProcessEnded { detail }
            | EngineError::NotFound { detail }
            | EngineError::InvalidPattern { detail }
            | EngineError::OutOfRange { detail }
            | EngineError::BadPointerChain { detail }
            | EngineError::Rejected { detail }
            | EngineError::Protected { detail }
            | EngineError::ReadFailed { detail, .. }
            | EngineError::WriteFailed { detail, .. }
            | EngineError::InputOverflow { detail }
            | EngineError::InvalidRequest { detail }
            | EngineError::Io { detail, .. } => detail,
        }
    }

    /// Residual Win32 error code, when the failure came from Win32.
    pub fn win32_code(&self) -> Option<u32> {
        match self {
            EngineError::AccessDenied { win32, .. }
            | EngineError::ReadFailed { win32, .. }
            | EngineError::WriteFailed { win32, .. }
            | EngineError::Io { win32, .. } => Some(*win32),
            _ => None,
        }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code(), self.detail())
    }
}

impl std::error::Error for EngineError {}

/// Checked address span: `[start, start + size)` with overflow refused at
/// construction time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemSpan {
    pub start: usize,
    pub size: usize,
}

impl MemSpan {
    pub fn new(start: usize, size: usize) -> Result<Self, EngineError> {
        if size == 0 {
            return Err(EngineError::InvalidRequest {
                detail: "zero-size span".to_string(),
            });
        }
        if start.checked_add(size).is_none() {
            return Err(EngineError::OutOfRange {
                detail: format!("span {start:#x}+{size} overflows the address space"),
            });
        }
        Ok(MemSpan { start, size })
    }

    /// Exclusive end address, `None` on overflow (cannot occur for spans
    /// built through [`MemSpan::new`]).
    pub fn end(&self) -> Option<usize> {
        self.start.checked_add(self.size)
    }

    /// Whether `inner` lies completely inside `self`.
    pub fn contains_span(&self, inner: &MemSpan) -> bool {
        match (self.end(), inner.end()) {
            (Some(own_end), Some(inner_end)) => inner.start >= self.start && inner_end <= own_end,
            _ => false,
        }
    }
}

/// Scalar layout of observed/written values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValueType {
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    U64,
    I64,
    F32,
    F64,
}

impl ValueType {
    /// Byte width of the scalar in target memory.
    pub fn byte_len(&self) -> usize {
        match self {
            ValueType::U8 | ValueType::I8 => 1,
            ValueType::U16 | ValueType::I16 => 2,
            ValueType::U32 | ValueType::I32 | ValueType::F32 => 4,
            ValueType::U64 | ValueType::I64 | ValueType::F64 => 8,
        }
    }

    /// Wire label shared with the JSON protocol.
    pub fn label(&self) -> &'static str {
        match self {
            ValueType::U8 => "u8",
            ValueType::I8 => "i8",
            ValueType::U16 => "u16",
            ValueType::I16 => "i16",
            ValueType::U32 => "u32",
            ValueType::I32 => "i32",
            ValueType::U64 => "u64",
            ValueType::I64 => "i64",
            ValueType::F32 => "f32",
            ValueType::F64 => "f64",
        }
    }
}

/// Decode little-endian scalar bytes into a JSON value.
pub fn decode_scalar(kind: ValueType, bytes: &[u8]) -> Result<serde_json::Value, EngineError> {
    let need = kind.byte_len();
    if bytes.len() != need {
        return Err(EngineError::InvalidRequest {
            detail: format!("{} needs {need} bytes, got {}", kind.label(), bytes.len()),
        });
    }
    let value = match kind {
        ValueType::U8 => serde_json::Value::from(bytes[0]),
        ValueType::I8 => serde_json::Value::from(bytes[0] as i8),
        ValueType::U16 => serde_json::Value::from(u16::from_le_bytes([bytes[0], bytes[1]])),
        ValueType::I16 => serde_json::Value::from(i16::from_le_bytes([bytes[0], bytes[1]])),
        ValueType::U32 => {
            serde_json::Value::from(u32::from_le_bytes(bytes.try_into().expect("4 bytes")))
        }
        ValueType::I32 => {
            serde_json::Value::from(i32::from_le_bytes(bytes.try_into().expect("4 bytes")))
        }
        ValueType::U64 => {
            serde_json::Value::from(u64::from_le_bytes(bytes.try_into().expect("8 bytes")))
        }
        ValueType::I64 => {
            serde_json::Value::from(i64::from_le_bytes(bytes.try_into().expect("8 bytes")))
        }
        ValueType::F32 => {
            float_value(f32::from_le_bytes(bytes.try_into().expect("4 bytes")) as f64, kind)?
        }
        ValueType::F64 => {
            float_value(f64::from_le_bytes(bytes.try_into().expect("8 bytes")), kind)?
        }
    };
    Ok(value)
}

fn float_value(value: f64, kind: ValueType) -> Result<serde_json::Value, EngineError> {
    serde_json::Number::from_f64(value)
        .map(serde_json::Value::Number)
        .ok_or_else(|| EngineError::OutOfRange {
            detail: format!(
                "{} value {value} is NaN/infinity, not representable in JSON",
                kind.label()
            ),
        })
}

/// Lowercase hex encoding of `bytes` (wire representation of raw payloads).
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit((byte >> 4) as u32, 16).expect("4-bit digit"));
        out.push(char::from_digit((byte & 0xF) as u32, 16).expect("4-bit digit"));
    }
    out
}

/// Decode an even-length hex string (case-insensitive).
pub fn hex_decode(text: &str) -> Result<Vec<u8>, EngineError> {
    if text.len() % 2 != 0 {
        return Err(EngineError::InvalidRequest {
            detail: "hex payload has odd length".to_string(),
        });
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in text.as_bytes().chunks_exact(2) {
        let hi = hex_digit(pair[0])?;
        let lo = hex_digit(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_digit(byte: u8) -> Result<u8, EngineError> {
    (byte as char)
        .to_digit(16)
        .map(|value| value as u8)
        .ok_or_else(|| EngineError::InvalidRequest {
            detail: format!("invalid hex digit '{}'", byte as char),
        })
}

/// Monotonic microsecond clock backed by `QueryPerformanceCounter`.
#[derive(Debug, Clone, Copy)]
pub struct MonoClock {
    frequency: i64,
    origin: i64,
}

impl MonoClock {
    /// Anchor a clock at the current tick (frequency validated).
    pub fn new() -> Result<Self, EngineError> {
        let frequency = qpc_frequency()?;
        let origin = qpc_ticks();
        Ok(MonoClock { frequency, origin })
    }

    /// Microseconds since construction; never moves backwards.
    pub fn now_micros(&self) -> u64 {
        let delta = qpc_ticks().saturating_sub(self.origin);
        ((delta as u128 * 1_000_000u128) / self.frequency.max(1) as u128) as u64
    }
}

/// Outcome of the `SeDebugPrivilege` activation attempt.
#[derive(Debug, Clone, Serialize)]
pub struct PrivilegeReport {
    /// Privilege name that was requested.
    pub privilege: String,
    /// `true` only when the privilege is now enabled on the token.
    pub enabled: bool,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub win32: Option<u32>,
}

const PRIVILEGE_NAME: &str = "SeDebugPrivilege";

/// Enable `SeDebugPrivilege` on the current process token and report the
/// honest outcome. Requires a token that holds the privilege (in practice an
/// elevated start); `ERROR_NOT_ALL_ASSIGNED` is reported as `enabled: false`.
pub fn enable_debug_privilege() -> PrivilegeReport {
    let fail = |detail: String, win32: u32| PrivilegeReport {
        privilege: PRIVILEGE_NAME.to_string(),
        enabled: false,
        detail,
        win32: Some(win32),
    };
    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE(std::ptr::null_mut());
        if let Err(error) = OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        ) {
            return fail(
                format!("OpenProcessToken failed: {error}"),
                win32_code(&error),
            );
        }
        let mut luid = LUID::default();
        if let Err(error) =
            LookupPrivilegeValueW(PCWSTR(std::ptr::null()), w!("SeDebugPrivilege"), &mut luid)
        {
            let _closed = CloseHandle(token);
            return fail(
                format!("LookupPrivilegeValueW failed: {error}"),
                win32_code(&error),
            );
        }
        let requested = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        let adjusted =
            AdjustTokenPrivileges(token, false, Some(&requested as *const _), 0, None, None);
        let report = match adjusted {
            Err(error) => fail(
                format!("AdjustTokenPrivileges failed: {error}"),
                win32_code(&error),
            ),
            Ok(()) => {
                // AdjustTokenPrivileges reports success even when the token
                // lacks the privilege; ERROR_NOT_ALL_ASSIGNED is the truth.
                let residual = GetLastError().0;
                if residual == ERROR_NOT_ALL_ASSIGNED.0 {
                    PrivilegeReport {
                        privilege: PRIVILEGE_NAME.to_string(),
                        enabled: false,
                        detail: "privilege is not held by the token; start the engine elevated"
                            .to_string(),
                        win32: Some(residual),
                    }
                } else {
                    PrivilegeReport {
                        privilege: PRIVILEGE_NAME.to_string(),
                        enabled: true,
                        detail: "privilege enabled on the current token".to_string(),
                        win32: None,
                    }
                }
            }
        };
        let _closed = CloseHandle(token);
        report
    }
}

// ---------------------------------------------------------------------------
// JSON line protocol
// ---------------------------------------------------------------------------

/// Upper bound of one `peek` read.
pub const MAX_PEEK_LEN: u32 = 4096;

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Request {
    Attach { pid: u32 },
    Detach,
    Modules,
    Observe {
        key: String,
        module: String,
        pattern: String,
        offsets: Vec<i64>,
        value_type: ValueType,
        pointer_width: Option<u32>,
        interval_ms: u64,
    },
    Unobserve { key: String },
    Read { key: String },
    Peek { addr: u64, len: u32 },
    Poll,
    Status,
    ScopeAllow { start: u64, size: u64 },
    ScopeClear,
    Actuate {
        addr: u64,
        value_hex: String,
        tag: String,
    },
    SendScancode {
        steps: Vec<KeyStepWire>,
        interval_ms: u64,
    },
    UiAttach {
        pid: u32,
        include_children: bool,
        interval_ms: u64,
        ttl_ms: u64,
    },
    UiDetach,
    EnableDebugPrivilege,
}

#[derive(Debug, Deserialize)]
struct KeyStepWire {
    scan: Option<u16>,
    vk: Option<u16>,
    action: KeyAction,
    extended: Option<bool>,
    hold_ms: Option<u64>,
    after_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ErrorWire {
    code: &'static str,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    win32: Option<u32>,
}

impl From<&EngineError> for ErrorWire {
    fn from(error: &EngineError) -> Self {
        ErrorWire {
            code: error.code(),
            detail: error.detail().to_string(),
            win32: error.win32_code().filter(|code| *code != 0),
        }
    }
}

#[derive(Debug, Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorWire>,
}

/// Failure with optional accompanying data (probe assessments ride along
/// with the coded refusal).
pub struct DispatchError {
    pub error: EngineError,
    pub data: Option<serde_json::Value>,
}

impl From<EngineError> for DispatchError {
    fn from(error: EngineError) -> Self {
        DispatchError { error, data: None }
    }
}

#[derive(Serialize)]
struct AssessmentWire {
    pid: u32,
    capability: Capability,
    class: TargetClass,
    attached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    refusal: Option<ErrorWire>,
    attempts: Vec<ProbeAttempt>,
}

#[derive(Serialize)]
struct ObservationWire {
    key: String,
    address: u64,
    value_type: ValueType,
    value_hex: String,
    value: Option<serde_json::Value>,
    first: bool,
    mono_micros: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorWire>,
}

impl From<Observation> for ObservationWire {
    fn from(observation: Observation) -> Self {
        ObservationWire {
            key: observation.key,
            address: observation.address as u64,
            value_type: observation.value_type,
            value_hex: hex_encode(&observation.bytes),
            value: observation.value,
            first: observation.first,
            mono_micros: observation.mono_micros,
            error: observation.error.as_ref().map(ErrorWire::from),
        }
    }
}

#[derive(Serialize)]
struct ScopeWire {
    start: u64,
    size: u64,
}

#[derive(Serialize)]
struct StatusWire {
    pid: Option<u32>,
    capability: Capability,
    class: TargetClass,
    attempts: Vec<ProbeAttempt>,
    watched_keys: Vec<String>,
    watcher_running: bool,
    watch_interval_ms: u64,
    scope: Vec<ScopeWire>,
    write_armed: bool,
    confirm_hook: bool,
    ui_running: bool,
    input_queued: usize,
    input_sent: u64,
}

struct EngineState {
    clock: MonoClock,
    input: InputSender,
    pid: Option<u32>,
    reader: Option<std::sync::Arc<observer::ProcessReader>>,
    capability: Capability,
    class: TargetClass,
    attempts: Vec<ProbeAttempt>,
    specs: Vec<WatchSpec>,
    watcher: Option<WatcherHandle>,
    watch_interval_ms: u64,
    scope: Vec<MemSpan>,
    writer: Option<ProcessWriter>,
    confirm: Option<ConfirmHook>,
    ui: Option<UiPollerHandle>,
}

impl EngineState {
    fn new() -> Result<Self, EngineError> {
        let clock = MonoClock::new()?;
        let input = InputSender::start(clock)?;
        Ok(EngineState {
            clock,
            input,
            pid: None,
            reader: None,
            capability: Capability::Refused,
            class: TargetClass::Unprobed,
            attempts: Vec::new(),
            specs: Vec::new(),
            watcher: None,
            watch_interval_ms: 0,
            scope: Vec::new(),
            writer: None,
            confirm: None,
            ui: None,
        })
    }
}

/// Installed C confirmation hook: opaque context paired with its callback.
struct ConfirmHook {
    callback: WmeConfirmFn,
    ctx: usize,
}

// The host hands the same context to every call from one session; crossing
// threads with it is the host's contract to uphold.
unsafe impl Send for ConfirmHook {}

/// Confirmation callback invoked at the start of every `actuate`.
///
/// Receives the operation summary as one JSON line and returns 1 to approve.
/// Without an installed hook every write is refused (`E_REJECTED`).
pub type WmeConfirmFn = Option<unsafe extern "C" fn(op_json: *const c_char, ctx: *mut c_void) -> u8>;

impl writer::Authorizer for Option<ConfirmHook> {
    fn authorize(&self, op: &WriteOp<'_>) -> bool {
        let Some(hook) = self else {
            return false;
        };
        let summary = serde_json::json!({
            "addr": op.addr as u64,
            "size": op.size,
            "value_hex": hex_encode(op.payload),
            "tag": op.tag,
        });
        // JSON escapes control bytes, so the line has no interior NUL.
        let Ok(line) = CString::new(summary.to_string()) else {
            return false;
        };
        unsafe { (hook.callback)(line.as_ptr(), hook.ctx as *mut c_void) == 1 }
    }
}

fn with_state<F>(work: F) -> Result<serde_json::Value, DispatchError>
where
    F: FnOnce(&mut EngineState) -> Result<serde_json::Value, DispatchError>,
{
    static ENGINE: LazyLock<Mutex<Option<EngineState>>> = LazyLock::new(|| Mutex::new(None));
    // Poisoned mutex state stays usable; the guarding invariant is
    // cross-thread exclusion, not payload validity.
    let mut guard = ENGINE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        *guard = Some(EngineState::new().map_err(DispatchError::from)?);
    }
    work(guard.as_mut().expect("populated immediately above"))
}

fn respond(line: &str) -> String {
    let outcome = match serde_json::from_str::<Request>(line) {
        Ok(request) => with_state(|state| run(state, request)),
        Err(error) => Err(DispatchError::from(EngineError::InvalidRequest {
            detail: format!("unparsable request line: {error}"),
        })),
    };
    reply_line(outcome)
}

fn reply_line(outcome: Result<serde_json::Value, DispatchError>) -> String {
    let response = match outcome {
        Ok(data) => Response {
            ok: true,
            data: Some(data),
            error: None,
        },
        Err(failure) => Response {
            ok: false,
            data: failure.data,
            error: Some(ErrorWire::from(&failure.error)),
        },
    };
    serde_json::to_string(&response).unwrap_or_else(|_| {
        // Serialization of these plain structs cannot fail in practice; the
        // fallback keeps the one-line contract even if it ever did.
        r#"{"ok":false,"error":{"code":"E_IO","detail":"response serialization failed"}}"#
            .to_string()
    })
}

fn run(state: &mut EngineState, request: Request) -> Result<serde_json::Value, DispatchError> {
    match request {
        Request::Attach { pid } => run_attach(state, pid),
        Request::Detach => {
            detach(state)?;
            Ok(serde_json::json!({ "detached": true }))
        }
        Request::Modules => {
            let pid = attached_pid(state, Capability::VisionOnly)?;
            let modules = observer::list_modules(pid)?;
            let listed: Vec<serde_json::Value> = modules
                .iter()
                .map(|module| {
                    serde_json::json!({
                        "name": module.name,
                        "base": module.base as u64,
                        "size": module.size,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "modules": listed }))
        }
        Request::Observe {
            key,
            module,
            pattern,
            offsets,
            value_type,
            pointer_width,
            interval_ms,
        } => run_observe(
            state,
            key,
            module,
            pattern,
            offsets,
            value_type,
            pointer_width,
            interval_ms,
        ),
        Request::Unobserve { key } => {
            policy::require(state.capability, Capability::MemoryAllowed)?;
            let before = state.specs.len();
            state.specs.retain(|spec| spec.key != key);
            if state.specs.len() == before {
                return Err(EngineError::NotFound {
                    detail: format!("watch key '{key}' is not registered"),
                }
                .into());
            }
            restart_watcher(state, state.watch_interval_ms.max(1))?;
            Ok(serde_json::json!({ "removed": key, "watched": state.specs.len() }))
        }
        Request::Read { key } => run_read(state, &key),
        Request::Peek { addr, len } => {
            attached_pid(state, Capability::MemoryAllowed)?;
            if len == 0 || len > MAX_PEEK_LEN {
                return Err(EngineError::InvalidRequest {
                    detail: format!("peek length {len} outside 1..={MAX_PEEK_LEN}"),
                }
                .into());
            }
            let address = to_usize(addr)?;
            let mut bytes = vec![0u8; len as usize];
            read_source(state)?.read_bytes(address, &mut bytes)?;
            Ok(serde_json::json!({
                "addr": addr,
                "len": len,
                "value_hex": hex_encode(&bytes),
            }))
        }
        Request::Poll => run_poll(state),
        Request::Status => {
            let watched_keys = state.specs.iter().map(|spec| spec.key.clone()).collect();
            let status = StatusWire {
                pid: state.pid,
                capability: state.capability,
                class: state.class,
                attempts: state.attempts.clone(),
                watched_keys,
                watcher_running: state.watcher.is_some(),
                watch_interval_ms: state.watch_interval_ms,
                scope: state
                    .scope
                    .iter()
                    .map(|span| ScopeWire {
                        start: span.start as u64,
                        size: span.size as u64,
                    })
                    .collect(),
                write_armed: state.writer.is_some(),
                confirm_hook: state.confirm.is_some(),
                ui_running: state.ui.is_some(),
                input_queued: state.input.queued(),
                input_sent: state.input.sent(),
            };
            Ok(serde_json::to_value(status).map_err(serialization_failed)?)
        }
        Request::ScopeAllow { start, size } => {
            attached_pid(state, Capability::MemoryAllowed)?;
            let span = MemSpan::new(to_usize(start)?, to_usize(size)?)?;
            state.scope.push(span);
            Ok(serde_json::json!({ "spans": state.scope.len() }))
        }
        Request::ScopeClear => {
            state.scope.clear();
            Ok(serde_json::json!({ "spans": 0 }))
        }
        Request::Actuate {
            addr,
            value_hex,
            tag,
        } => run_actuate(state, addr, value_hex, tag),
        Request::SendScancode { steps, interval_ms } => {
            run_send_scancode(state, steps, interval_ms)
        }
        Request::UiAttach {
            pid,
            include_children,
            interval_ms,
            ttl_ms,
        } => run_ui_attach(state, pid, include_children, interval_ms, ttl_ms),
        Request::UiDetach => {
            if let Some(poller) = state.ui.take() {
                poller.stop()?;
            }
            Ok(serde_json::json!({ "ui_running": false }))
        }
        Request::EnableDebugPrivilege => Ok(
            serde_json::to_value(enable_debug_privilege()).map_err(serialization_failed)?,
        ),
    }
}

fn run_attach(state: &mut EngineState, pid: u32) -> Result<serde_json::Value, DispatchError> {
    if state.pid.is_some() {
        detach(state)?;
    }
    let probe = policy::probe_target(pid);
    state.pid = Some(pid);
    state.capability = probe.assessment.capability;
    state.class = probe.assessment.class;
    state.attempts = probe.assessment.attempts.clone();
    state.reader = probe.reader.map(std::sync::Arc::new);
    let wire = AssessmentWire {
        pid,
        capability: probe.assessment.capability,
        class: probe.assessment.class,
        attached: probe.assessment.capability != Capability::Refused,
        refusal: probe.assessment.refusal.as_ref().map(ErrorWire::from),
        attempts: probe.assessment.attempts,
    };
    let data = serde_json::to_value(wire).map_err(serialization_failed)?;
    match probe.assessment.refusal {
        // Coded refusal, delivered together with the assessment data.
        Some(refusal) => Err(DispatchError {
            error: refusal,
            data: Some(data),
        }),
        None => Ok(data),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_observe(
    state: &mut EngineState,
    key: String,
    module: String,
    pattern: String,
    offsets: Vec<i64>,
    value_type: ValueType,
    pointer_width: Option<u32>,
    interval_ms: u64,
) -> Result<serde_json::Value, DispatchError> {
    policy::require(state.capability, Capability::MemoryAllowed)?;
    if interval_ms == 0 {
        return Err(EngineError::InvalidRequest {
            detail: "interval_ms must be greater than zero".to_string(),
        }
        .into());
    }
    let width = match pointer_width.unwrap_or(8) {
        4 => 4,
        8 => 8,
        other => {
            return Err(EngineError::BadPointerChain {
                detail: format!("pointer_width {other} is not 4 or 8"),
            }
            .into())
        }
    };
    let pid = attached_pid(state, Capability::MemoryAllowed)?;
    let source = read_source(state)?;
    let signature = observer::parse_pattern(&pattern)?;
    let modules = observer::list_modules(pid)?;
    let hit = observer::scan_module(source.as_ref(), &modules, &module, &signature)?;
    let address = observer::resolve_pointer_chain(source.as_ref(), hit, &offsets, width)?;
    state.specs.retain(|spec| spec.key != key);
    state.specs.push(WatchSpec {
        key: key.clone(),
        address,
        value_type,
    });
    restart_watcher(state, interval_ms)?;
    Ok(serde_json::json!({
        "key": key,
        "hit": hit as u64,
        "address": address as u64,
        "value_type": value_type,
        "size": value_type.byte_len(),
        "interval_ms": interval_ms,
    }))
}

fn run_read(state: &mut EngineState, key: &str) -> Result<serde_json::Value, DispatchError> {
    policy::require(state.capability, Capability::MemoryAllowed)?;
    let spec = state
        .specs
        .iter()
        .find(|spec| spec.key == key)
        .cloned()
        .ok_or_else(|| EngineError::NotFound {
            detail: format!("watch key '{key}' is not registered"),
        })?;
    let mut bytes = vec![0u8; spec.value_type.byte_len()];
    let (value, error) = match read_source(state)?.read_bytes(spec.address, &mut bytes) {
        Ok(()) => match decode_scalar(spec.value_type, &bytes) {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(ErrorWire::from(&error))),
        },
        Err(error) => (None, Some(ErrorWire::from(&error))),
    };
    Ok(serde_json::json!({
        "key": spec.key,
        "address": spec.address as u64,
        "value_type": spec.value_type,
        "value_hex": hex_encode(&bytes),
        "value": value,
        "mono_micros": state.clock.now_micros(),
        "error": error,
    }))
}

fn run_poll(state: &mut EngineState) -> Result<serde_json::Value, DispatchError> {
    let observations: Vec<serde_json::Value> = state
        .watcher
        .as_ref()
        .map(|watcher| watcher.drain())
        .unwrap_or_default()
        .into_iter()
        .map(ObservationWire::from)
        .map(|wire| serde_json::to_value(wire).map_err(serialization_failed))
        .collect::<Result<_, _>>()?;
    let ui_changes: Vec<serde_json::Value> = state
        .ui
        .as_ref()
        .map(|poller| poller.drain())
        .unwrap_or_default()
        .into_iter()
        .map(|change| serde_json::to_value(change).map_err(serialization_failed))
        .collect::<Result<_, _>>()?;
    let input_errors: Vec<serde_json::Value> = state
        .input
        .take_errors()
        .iter()
        .map(|error| serde_json::to_value(ErrorWire::from(error)).map_err(serialization_failed))
        .collect::<Result<_, _>>()?;
    Ok(serde_json::json!({
        "observations": observations,
        "ui_changes": ui_changes,
        "input_errors": input_errors,
    }))
}

fn run_actuate(
    state: &mut EngineState,
    addr: u64,
    value_hex: String,
    tag: String,
) -> Result<serde_json::Value, DispatchError> {
    policy::require(state.capability, Capability::MemoryAllowed)?;
    let payload = hex_decode(&value_hex)?;
    if payload.is_empty() {
        return Err(EngineError::InvalidRequest {
            detail: "empty actuate payload".to_string(),
        }
        .into());
    }
    let address = to_usize(addr)?;
    let pid = attached_pid(state, Capability::MemoryAllowed)?;
    if state.writer.is_none() {
        state.writer = Some(ProcessWriter::open(pid)?);
    }
    let writer = state.writer.as_ref().expect("armed above");
    let op = WriteOp {
        addr: address,
        size: payload.len(),
        payload: &payload,
        tag: &tag,
    };
    let mut actuator = MemoryActuator::new(writer, &state.confirm, &state.scope);
    let written = actuator.actuate(&op)?;
    Ok(serde_json::json!({
        "written": written,
        "addr": addr,
        "tag": tag,
    }))
}

fn run_send_scancode(
    state: &mut EngineState,
    steps: Vec<KeyStepWire>,
    interval_ms: u64,
) -> Result<serde_json::Value, DispatchError> {
    policy::require(state.capability, Capability::InputOnly)?;
    if interval_ms == 0 {
        return Err(EngineError::InvalidRequest {
            detail: "interval_ms must be greater than zero".to_string(),
        }
        .into());
    }
    if steps.is_empty() {
        return Err(EngineError::InvalidRequest {
            detail: "empty scancode schedule".to_string(),
        }
        .into());
    }
    let mut planned = Vec::with_capacity(steps.len());
    for step in steps {
        let (scan, extended) = match (step.scan, step.vk) {
            (Some(scan), _) => (scan, step.extended.unwrap_or((scan & 0xFF00) == 0xE000)),
            (None, Some(vk)) => {
                let resolved = resolve_vk(vk).ok_or_else(|| EngineError::NotFound {
                    detail: format!("virtual key {vk:#x} maps to no scancode"),
                })?;
                (resolved.0, step.extended.unwrap_or(resolved.1))
            }
            (None, None) => {
                return Err(EngineError::InvalidRequest {
                    detail: "scancode step needs scan or vk".to_string(),
                }
                .into())
            }
        };
        planned.push(KeyStepSpec {
            scan,
            extended,
            action: step.action,
            hold_ms: step.hold_ms.unwrap_or(0),
            after_ms: step.after_ms.unwrap_or(0),
        });
    }
    let presses = plan_presses(&planned, interval_ms)?;
    let queued = state.input.schedule(&presses)?;
    Ok(serde_json::json!({ "queued": queued }))
}

fn run_ui_attach(
    state: &mut EngineState,
    pid: u32,
    include_children: bool,
    interval_ms: u64,
    ttl_ms: u64,
) -> Result<serde_json::Value, DispatchError> {
    policy::require(state.capability, Capability::VisionOnly)?;
    if state.pid != Some(pid) {
        return Err(EngineError::InvalidRequest {
            detail: format!("ui_attach pid {pid} differs from attached {:?}", state.pid),
        }
        .into());
    }
    if interval_ms == 0 || ttl_ms == 0 {
        return Err(EngineError::InvalidRequest {
            detail: "interval_ms and ttl_ms must be greater than zero".to_string(),
        }
        .into());
    }
    if let Some(poller) = state.ui.take() {
        poller.stop()?;
    }
    let records = hwnd::collect_windows(pid, include_children);
    let poller = hwnd::spawn_ui_poller(
        pid,
        include_children,
        interval_ms.saturating_mul(1_000),
        ttl_ms.saturating_mul(1_000),
        state.clock,
        records.clone(),
    )?;
    state.ui = Some(poller);
    Ok(serde_json::json!({
        "records": records,
        "interval_ms": interval_ms,
        "ttl_ms": ttl_ms,
    }))
}

fn restart_watcher(state: &mut EngineState, interval_ms: u64) -> Result<(), EngineError> {
    if let Some(watcher) = state.watcher.take() {
        watcher.stop()?;
    }
    if state.specs.is_empty() {
        state.watch_interval_ms = 0;
        return Ok(());
    }
    let source = read_source(state)?;
    state.watcher = Some(observer::spawn_watcher(
        source,
        state.specs.clone(),
        interval_ms.saturating_mul(1_000),
        state.clock,
    )?);
    state.watch_interval_ms = interval_ms;
    Ok(())
}

fn detach(state: &mut EngineState) -> Result<(), EngineError> {
    if let Some(watcher) = state.watcher.take() {
        watcher.stop()?;
    }
    if let Some(poller) = state.ui.take() {
        poller.stop()?;
    }
    state.writer = None;
    state.reader = None;
    state.specs.clear();
    state.scope.clear();
    state.watch_interval_ms = 0;
    state.pid = None;
    state.capability = Capability::Refused;
    state.class = TargetClass::Unprobed;
    state.attempts.clear();
    Ok(())
}

fn attached_pid(state: &EngineState, needed: Capability) -> Result<u32, DispatchError> {
    policy::require(state.capability, needed)?;
    state.pid.ok_or_else(|| {
        EngineError::NotFound {
            detail: "no target attached".to_string(),
        }
        .into()
    })
}

fn read_source(
    state: &EngineState,
) -> Result<std::sync::Arc<observer::ProcessReader>, DispatchError> {
    state.reader.clone().ok_or_else(|| {
        EngineError::AccessDenied {
            detail: "target grants no read access".to_string(),
            win32: 0,
        }
        .into()
    })
}

fn to_usize(value: u64) -> Result<usize, DispatchError> {
    usize::try_from(value).map_err(|_| {
        EngineError::OutOfRange {
            detail: format!("{value:#x} does not fit the host address width"),
        }
        .into()
    })
}

fn serialization_failed(error: serde_json::Error) -> DispatchError {
    EngineError::Io {
        detail: format!("response serialization failed: {error}"),
        win32: 0,
    }
    .into()
}

// ---------------------------------------------------------------------------
// C-ABI
// ---------------------------------------------------------------------------

/// Process one JSON request line and return one JSON reply line (heap; free
/// with [`wme_reply_free`]). Panics never cross the boundary: they surface as
/// `E_IO`.
#[no_mangle]
pub extern "C" fn wme_request(line: *const c_char) -> *mut c_char {
    let reply = if line.is_null() {
        reply_line(
            Err(EngineError::InvalidRequest {
                detail: "null request line".to_string(),
            }
            .into()),
        )
    } else {
        let caught = catch_unwind(AssertUnwindSafe(|| {
            let request = unsafe { CStr::from_ptr(line) };
            respond(&request.to_string_lossy())
        }));
        caught.unwrap_or_else(|_| {
            reply_line(
                Err(EngineError::Io {
                    detail: "panic contained at FFI boundary".to_string(),
                    win32: 0,
                }
                .into()),
            )
        })
    };
    alloc_reply(&reply)
}

/// Free a reply allocated by [`wme_request`] or [`wme_enable_debug_privilege`].
#[no_mangle]
pub extern "C" fn wme_reply_free(reply: *mut c_char) {
    if !reply.is_null() {
        let _owned = unsafe { CString::from_raw(reply) };
    }
}

/// Install the write confirmation hook. Returns 1 when installed, 0 when the
/// engine is unavailable. Passing `NULL` removes the hook (every write is then
/// refused with `E_REJECTED`).
///
/// # Safety
/// `cb` must stay valid for the engine's lifetime; `ctx` is passed through
/// untouched and must be valid whenever `cb` can fire.
#[no_mangle]
pub unsafe extern "C" fn wme_set_confirm_hook(cb: WmeConfirmFn, ctx: *mut c_void) -> u8 {
    let installed = with_state(|state| {
        state.confirm = cb.map(|callback| ConfirmHook {
            callback,
            ctx: ctx as usize,
        });
        Ok(serde_json::json!({ "installed": cb.is_some() }))
    });
    if installed.is_ok() {
        1
    } else {
        0
    }
}

/// Enable `SeDebugPrivilege` and return the JSON report line (heap; free with
/// [`wme_reply_free`]).
#[no_mangle]
pub extern "C" fn wme_enable_debug_privilege() -> *mut c_char {
    let report = enable_debug_privilege();
    let reply = serde_json::to_string(&report).unwrap_or_else(|_| {
        r#"{"privilege":"SeDebugPrivilege","enabled":false,"detail":"report serialization failed"}"#
            .to_string()
    });
    alloc_reply(&reply)
}

const VERSION_MARK: &[u8] = b"win32-memory-engine/0.1.0\0";

/// Static version marker; do not free.
#[no_mangle]
pub extern "C" fn wme_version() -> *const c_char {
    VERSION_MARK.as_ptr() as *const c_char
}

fn alloc_reply(reply: &str) -> *mut c_char {
    CString::new(reply)
        .unwrap_or_else(|_| {
            CString::new(r#"{"ok":false,"error":{"code":"E_IO","detail":"reply contains NUL"}}"#)
                .expect("literal without NUL")
        })
        .into_raw()
}

// ---------------------------------------------------------------------------
// Win32 boundary functions
// ---------------------------------------------------------------------------

fn qpc_ticks() -> i64 {
    let mut ticks = 0i64;
    // `MonoClock::new` validated the counter; a failure here would leave the
    // clock without any notion of time and cannot be repaired upstream.
    unsafe { QueryPerformanceCounter(&mut ticks) }
        .expect("QueryPerformanceCounter is available after MonoClock::new");
    ticks
}

fn qpc_frequency() -> Result<i64, EngineError> {
    let mut frequency = 0i64;
    unsafe { QueryPerformanceFrequency(&mut frequency) }.map_err(|error| EngineError::Io {
        detail: format!("QueryPerformanceFrequency failed: {error}"),
        win32: win32_code(&error),
    })?;
    if frequency <= 0 {
        return Err(EngineError::Io {
            detail: "QueryPerformanceFrequency returned a non-positive frequency".to_string(),
            win32: 0,
        });
    }
    Ok(frequency)
}

/// Extract the Win32 error code from a `windows::core::Error`:
/// `HRESULT_FROM_WIN32` carries it in the low 16 bits of the `0x8007xxxx`
/// facility.
pub fn win32_code(error: &windows::core::Error) -> u32 {
    let raw = error.code().0 as u32;
    if raw & 0xFFFF_0000 == 0x8007_0000 {
        raw & 0xFFFF
    } else {
        raw
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_and_rejects_malformed_input() {
        let bytes = [0x00, 0x1F, 0xAB, 0xFF];
        assert_eq!(hex_encode(&bytes), "001fabff");
        assert_eq!(hex_decode("001fabff").expect("decode"), bytes.to_vec());
        assert_eq!(hex_decode("001FABFF").expect("uppercase decode"), bytes.to_vec());
        assert!(matches!(
            hex_decode("abc"),
            Err(EngineError::InvalidRequest { .. })
        ));
        assert!(matches!(
            hex_decode("zz"),
            Err(EngineError::InvalidRequest { .. })
        ));
    }

    #[test]
    fn decodes_little_endian_scalars() {
        assert_eq!(
            decode_scalar(ValueType::U8, &[0x7F]).expect("u8"),
            serde_json::json!(127)
        );
        assert_eq!(
            decode_scalar(ValueType::I32, &(-42i32).to_le_bytes()).expect("i32"),
            serde_json::json!(-42)
        );
        assert_eq!(
            decode_scalar(ValueType::F64, &1.5f64.to_le_bytes()).expect("f64"),
            serde_json::json!(1.5)
        );
        assert_eq!(
            decode_scalar(ValueType::U64, &u64::MAX.to_le_bytes()).expect("u64"),
            serde_json::json!(u64::MAX)
        );
    }

    #[test]
    fn decode_enforces_width_and_representable_floats() {
        assert!(matches!(
            decode_scalar(ValueType::U32, &[0, 1]),
            Err(EngineError::InvalidRequest { .. })
        ));
        assert!(matches!(
            decode_scalar(ValueType::F32, &f32::NAN.to_le_bytes()),
            Err(EngineError::OutOfRange { .. })
        ));
    }

    #[test]
    fn mem_span_checks_bounds_without_overflow() {
        let span = MemSpan::new(0x1000, 0x10).expect("span");
        assert!(span.contains_span(&MemSpan::new(0x1000, 0x10).expect("fit")));
        assert!(span.contains_span(&MemSpan::new(0x1008, 0x8).expect("tail")));
        assert!(!span.contains_span(&MemSpan::new(0x1008, 0x9).expect("overhang")));
        assert!(!span.contains_span(&MemSpan::new(0x0FFF, 0x2).expect("prefix")));
        assert!(matches!(
            MemSpan::new(usize::MAX, 4),
            Err(EngineError::OutOfRange { .. })
        ));
        assert!(matches!(
            MemSpan::new(0x1000, 0),
            Err(EngineError::InvalidRequest { .. })
        ));
    }

    #[test]
    fn parses_request_lines() {
        let attach = serde_json::from_str::<Request>(r#"{"cmd":"attach","pid":7}"#).expect("attach");
        assert!(matches!(attach, Request::Attach { pid: 7 }));

        let observe = serde_json::from_str::<Request>(
            r#"{"cmd":"observe","key":"hp","module":"game.exe","pattern":"48 8B ?? 10","offsets":[0,8],"value_type":"f32","interval_ms":50}"#,
        )
        .expect("observe");
        match observe {
            Request::Observe {
                key,
                offsets,
                value_type,
                pointer_width,
                ..
            } => {
                assert_eq!(key, "hp");
                assert_eq!(offsets, vec![0, 8]);
                assert_eq!(value_type, ValueType::F32);
                assert_eq!(pointer_width, None);
            }
            other => panic!("unexpected request {other:?}"),
        }

        let scancode = serde_json::from_str::<Request>(
            r#"{"cmd":"send_scancode","interval_ms":10,"steps":[{"scan":30,"action":"tap"},{"vk":13,"action":"down"}]}"#,
        )
        .expect("send_scancode");
        match scancode {
            Request::SendScancode { steps, interval_ms } => {
                assert_eq!(interval_ms, 10);
                assert_eq!(steps.len(), 2);
                assert_eq!(steps[0].action, KeyAction::Tap);
                assert_eq!(steps[1].vk, Some(13));
            }
            other => panic!("unexpected request {other:?}"),
        }

        assert!(serde_json::from_str::<Request>(r#"{"cmd":"nope"}"#).is_err());
    }

    #[test]
    fn unparsable_lines_answer_with_coded_error() {
        let reply = respond("{not json");
        assert!(reply.contains("\"ok\":false"));
        assert!(reply.contains("E_INVALID_REQUEST"));
        assert!(!reply.contains('\n'));
    }

    #[test]
    fn missing_confirm_hook_declines_writes() {
        let op = WriteOp {
            addr: 0x1000,
            size: 1,
            payload: &[0x90],
            tag: "test",
        };
        assert!(!writer::Authorizer::authorize(&None::<ConfirmHook>, &op));
    }
}
