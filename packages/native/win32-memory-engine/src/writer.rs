//! Target memory writes: `WriteProcessMemory` reachable only through
//! [`MemoryActuator`], gated by a call-start confirmation hook and a narrow
//! address scope. The READ side ([`crate::observer::ProcessReader`]) is a
//! separate type with separate handle rights by design.

use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, HANDLE};
use windows::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_ACCESS_RIGHTS, PROCESS_VM_OPERATION, PROCESS_VM_WRITE,
};

use crate::{EngineError, MemSpan};

/// Writable target memory. Production impl: [`ProcessWriter`]; tests use a
/// recording mock sink.
pub trait ByteSink {
    /// Write `data` at `addr`.
    fn write_bytes(&self, addr: usize, data: &[u8]) -> Result<(), EngineError>;
}

/// The write performed at one call site.
#[derive(Clone, Copy)]
pub struct WriteOp<'a> {
    /// Destination address in the target.
    pub addr: usize,
    /// Declared payload size (must equal `payload.len()`).
    pub size: usize,
    /// Little-endian encoded bytes to write.
    pub payload: &'a [u8],
    /// Caller-supplied audit tag (reported to the confirm hook).
    pub tag: &'a str,
}

/// Call-start confirmation hook: every write asks `authorize` before any
/// touching of target memory. A declined (or missing) hook is a coded
/// rejection, never a silent skip.
pub trait Authorizer {
    fn authorize(&self, op: &WriteOp<'_>) -> bool;
}

/// Closure-backed [`Authorizer`] for hosts and tests.
pub struct CallbackAuthorizer<F> {
    callback: F,
}

impl<F> CallbackAuthorizer<F>
where
    F: Fn(&WriteOp<'_>) -> bool,
{
    pub fn new(callback: F) -> Self {
        CallbackAuthorizer { callback }
    }
}

impl<F> Authorizer for CallbackAuthorizer<F>
where
    F: Fn(&WriteOp<'_>) -> bool,
{
    fn authorize(&self, op: &WriteOp<'_>) -> bool {
        (self.callback)(op)
    }
}

/// Always-refusing authorizer: the state of a host that installed no hook.
pub struct DenyAuthorizer;

impl Authorizer for DenyAuthorizer {
    fn authorize(&self, _op: &WriteOp<'_>) -> bool {
        false
    }
}

/// Pure scope check: the operation span must lie inside one allowed span
/// (checked arithmetic; partial overlaps are refused).
pub fn check_scope(scope: &[MemSpan], op: &WriteOp<'_>) -> Result<(), EngineError> {
    let wanted = MemSpan::new(op.addr, op.size)?;
    for allowed in scope {
        if allowed.contains_span(&wanted) {
            return Ok(());
        }
    }
    Err(EngineError::OutOfRange {
        detail: format!(
            "write span {:#x}+{} is outside the allowed scope",
            op.addr, op.size
        ),
    })
}

/// The single write gateway: validates the op, runs the confirmation hook at
/// call start, enforces the narrow scope, then writes.
pub struct MemoryActuator<'a, S: ByteSink, A: Authorizer> {
    sink: &'a S,
    authorizer: &'a A,
    scope: &'a [MemSpan],
    writes: u64,
}

impl<'a, S: ByteSink, A: Authorizer> MemoryActuator<'a, S, A> {
    pub fn new(sink: &'a S, authorizer: &'a A, scope: &'a [MemSpan]) -> Self {
        MemoryActuator {
            sink,
            authorizer,
            scope,
            writes: 0,
        }
    }

    /// Completed writes through this actuator.
    pub fn writes(&self) -> u64 {
        self.writes
    }

    /// Perform one write. Order: op well-formedness, call-start hook, scope,
    /// `WriteProcessMemory`.
    pub fn actuate(&mut self, op: &WriteOp<'_>) -> Result<usize, EngineError> {
        if op.payload.is_empty() {
            return Err(EngineError::InvalidRequest {
                detail: "empty write payload".to_string(),
            });
        }
        if op.size != op.payload.len() {
            return Err(EngineError::InvalidRequest {
                detail: format!(
                    "declared size {} does not match payload {}",
                    op.size,
                    op.payload.len()
                ),
            });
        }
        if !self.authorizer.authorize(op) {
            return Err(EngineError::Rejected {
                detail: format!("confirm hook declined write '{}'", op.tag),
            });
        }
        check_scope(self.scope, op)?;
        self.sink.write_bytes(op.addr, op.payload)?;
        self.writes += 1;
        Ok(op.payload.len())
    }
}

/// Write handle to a target process (WRITE side; reads live in
/// [`crate::observer::ProcessReader`]).
pub struct ProcessWriter {
    handle: HANDLE,
    pid: u32,
}

impl ProcessWriter {
    /// Open the target with `PROCESS_VM_WRITE | PROCESS_VM_OPERATION`.
    pub fn open(pid: u32) -> Result<Self, EngineError> {
        let rights: PROCESS_ACCESS_RIGHTS = PROCESS_VM_WRITE | PROCESS_VM_OPERATION;
        let handle = unsafe { OpenProcess(rights, false, pid) }.map_err(|e| {
            let code = crate::win32_code(&e);
            if code == ERROR_ACCESS_DENIED.0 {
                EngineError::AccessDenied {
                    detail: format!("write access to {pid} denied"),
                    win32: code,
                }
            } else {
                EngineError::NotFound {
                    detail: format!("process {pid} not writable (win32 {code})"),
                }
            }
        })?;
        Ok(ProcessWriter { handle, pid })
    }

    /// Target process id.
    pub fn pid(&self) -> u32 {
        self.pid
    }
}

impl ByteSink for ProcessWriter {
    fn write_bytes(&self, addr: usize, data: &[u8]) -> Result<(), EngineError> {
        let mut written = 0usize;
        unsafe {
            WriteProcessMemory(
                self.handle,
                addr as *const _,
                data.as_ptr() as *const _,
                data.len(),
                Some(&mut written),
            )
        }
        .map_err(|e| {
            let code = crate::win32_code(&e);
            if code == ERROR_ACCESS_DENIED.0 {
                EngineError::AccessDenied {
                    detail: format!("write at {addr:#x} denied"),
                    win32: code,
                }
            } else {
                EngineError::WriteFailed {
                    detail: format!("WriteProcessMemory at {addr:#x} failed"),
                    win32: code,
                }
            }
        })?;
        if written != data.len() {
            return Err(EngineError::WriteFailed {
                detail: format!("short write at {addr:#x}: {written}/{}", data.len()),
                win32: 0,
            });
        }
        Ok(())
    }
}

impl Drop for ProcessWriter {
    fn drop(&mut self) {
        // Drop path: a failed CloseHandle cannot be reported to anyone.
        let _closed = unsafe { CloseHandle(self.handle) };
    }
}

// The Win32 process handle is safe to share: `WriteProcessMemory` is
// thread-safe and the handle is owned by this type alone.
unsafe impl Send for ProcessWriter {}
unsafe impl Sync for ProcessWriter {}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct RecordingSink {
        writes: RefCell<Vec<(usize, Vec<u8>)>>,
        fail: bool,
    }

    impl RecordingSink {
        fn new(fail: bool) -> Self {
            RecordingSink {
                writes: RefCell::new(Vec::new()),
                fail,
            }
        }
    }

    impl ByteSink for RecordingSink {
        fn write_bytes(&self, addr: usize, data: &[u8]) -> Result<(), EngineError> {
            if self.fail {
                return Err(EngineError::WriteFailed {
                    detail: "mock sink failure".to_string(),
                    win32: 42,
                });
            }
            self.writes.borrow_mut().push((addr, data.to_vec()));
            Ok(())
        }
    }

    struct AllowTag(&'static str);

    impl Authorizer for AllowTag {
        fn authorize(&self, op: &WriteOp<'_>) -> bool {
            op.tag == self.0
        }
    }

    fn span(start: usize, size: usize) -> MemSpan {
        MemSpan::new(start, size).expect("valid span")
    }

    #[test]
    fn scope_requires_full_containment() {
        let scope = [span(0x1000, 0x10)];
        let payload = [1u8, 2, 3, 4];
        // Exact fit at both edges is allowed.
        let edge = WriteOp {
            addr: 0x100C,
            size: 4,
            payload: &payload,
            tag: "edge",
        };
        assert!(check_scope(&scope, &edge).is_ok());
        // One byte past the end is refused.
        let past = WriteOp {
            addr: 0x100D,
            size: 4,
            payload: &payload,
            tag: "past",
        };
        assert!(matches!(
            check_scope(&scope, &past),
            Err(EngineError::OutOfRange { .. })
        ));
        // Span starting before the scope is refused.
        let before = WriteOp {
            addr: 0x0FFE,
            size: 4,
            payload: &payload,
            tag: "before",
        };
        assert!(matches!(
            check_scope(&scope, &before),
            Err(EngineError::OutOfRange { .. })
        ));
    }

    #[test]
    fn declination_blocks_the_sink() {
        let sink = RecordingSink::new(false);
        let authorizer = AllowTag("allowed");
        let scope = [span(0x1000, 0x100)];
        let mut actuator = MemoryActuator::new(&sink, &authorizer, &scope);
        let payload = [9u8, 8, 7, 6];
        let declined = WriteOp {
            addr: 0x1000,
            size: 4,
            payload: &payload,
            tag: "denied",
        };
        assert!(matches!(
            actuator.actuate(&declined),
            Err(EngineError::Rejected { .. })
        ));
        assert!(sink.writes.borrow().is_empty());

        let approved = WriteOp {
            tag: "allowed",
            ..declined
        };
        assert_eq!(actuator.actuate(&approved), Ok(4));
        assert_eq!(&sink.writes.borrow()[0], &(0x1000, payload.to_vec()));
        assert_eq!(actuator.writes(), 1);
    }

    #[test]
    fn hook_runs_before_scope_so_host_sees_every_attempt() {
        let sink = RecordingSink::new(false);
        let seen: RefCell<Vec<usize>> = RefCell::new(Vec::new());
        let authorizer = CallbackAuthorizer::new(|op: &WriteOp<'_>| {
            seen.borrow_mut().push(op.addr);
            true
        });
        let scope = [span(0x1000, 0x10)];
        let mut actuator = MemoryActuator::new(&sink, &authorizer, &scope);
        let payload = [1u8];
        let outside = WriteOp {
            addr: 0x9000,
            size: 1,
            payload: &payload,
            tag: "outside",
        };
        assert!(matches!(
            actuator.actuate(&outside),
            Err(EngineError::OutOfRange { .. })
        ));
        // The attempt reached the hook even though the scope refused it.
        assert_eq!(&seen.borrow()[..], &[0x9000][..]);
        assert!(sink.writes.borrow().is_empty());
    }

    #[test]
    fn malformed_ops_are_refused_before_any_gate() {
        let sink = RecordingSink::new(false);
        let authorizer = DenyAuthorizer;
        let mut actuator = MemoryActuator::new(&sink, &authorizer, &[]);
        let payload = [1u8, 2];
        let mismatched = WriteOp {
            addr: 0x10,
            size: 3,
            payload: &payload,
            tag: "mismatch",
        };
        assert!(matches!(
            actuator.actuate(&mismatched),
            Err(EngineError::InvalidRequest { .. })
        ));
        let empty = WriteOp {
            addr: 0x10,
            size: 0,
            payload: &[],
            tag: "empty",
        };
        assert!(matches!(
            actuator.actuate(&empty),
            Err(EngineError::InvalidRequest { .. })
        ));
    }

    #[test]
    fn sink_failures_propagate_with_code() {
        let sink = RecordingSink::new(true);
        let authorizer = CallbackAuthorizer::new(|_: &WriteOp<'_>| true);
        let scope = [span(0x0, 0x1000)];
        let mut actuator = MemoryActuator::new(&sink, &authorizer, &scope);
        let payload = [1u8];
        let op = WriteOp {
            addr: 0x20,
            size: 1,
            payload: &payload,
            tag: "boom",
        };
        assert!(matches!(
            actuator.actuate(&op),
            Err(EngineError::WriteFailed { win32: 42, .. })
        ));
    }

    #[test]
    fn deny_authorizer_refuses() {
        assert!(!DenyAuthorizer.authorize(&WriteOp {
            addr: 0,
            size: 1,
            payload: &[0],
            tag: "any",
        }));
    }
}
