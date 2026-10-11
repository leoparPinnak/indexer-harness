//! writevm — kapsam + onay kancası kontrollü WriteProcessMemory.
//!
//! Yazım yolu tek: `MemoryActuator::actuate`. Kapamalar sırası:
//! kapsam kontrolü → çağrı-başı onay kancası → WriteProcessMemory.
//! Kapama yoksa ya da reddederse yazım hiç uğramaz. Kapsam/onay mantığı
//! Win32'den bağımsızdır, `ByteSink` arkasında test edilebilir.

use std::io;
use std::ops::Range;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_VM_OPERATION, PROCESS_VM_WRITE};

#[derive(Debug, Clone, PartialEq)]
pub enum Reject {
    OutOfScope,
    HookDenied,
}

#[derive(Debug, Clone)]
pub struct WriteOp<'a> {
    pub addr: u64,
    pub bytes: &'a [u8],
    /// Serbest etiket: kancaya niyet bilgisi taşır.
    pub tag: &'a str,
}

/// Çağrı-başı onay kancası. `true` = yaz; `false` = `E_REJECTED`.
pub type ConfirmHook = dyn Fn(&WriteOp<'_>) -> bool;

/// Yazılabilir VA aralıkları. Boş kapsam hiçbir yazımı geçirmez.
#[derive(Default)]
pub struct WriteScope {
    ranges: Vec<Range<u64>>,
}

impl WriteScope {
    pub fn allow(&mut self, range: Range<u64>) {
        if !range.is_empty() {
            self.ranges.push(range);
        }
    }

    pub fn clear(&mut self) {
        self.ranges.clear();
    }

    pub fn covers(&self, addr: u64, len: usize) -> bool {
        let end = addr.saturating_add(len as u64);
        self.ranges.iter().any(|r| r.start <= addr && end <= r.end)
    }
}

pub struct MemoryActuator<'h> {
    handle: HANDLE,
    pub scope: WriteScope,
    pub hook: Option<Box<ConfirmHook + 'h>>,
}

impl<'h> MemoryActuator<'h> {
    pub fn open(pid: u32) -> io::Result<Self> {
        let handle = unsafe {
            OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_WRITE, false, pid)
                .map_err(|e| io::Error::from_raw_os_error(e.code().0))?
        };
        Ok(Self { handle, scope: WriteScope::default(), hook: None })
    }

    pub fn set_hook(&mut self, hook: Box<ConfirmHook + 'h>) {
        self.hook = Some(hook);
    }

    /// Tek yazım. Sıra: kapsam → kanca → WriteProcessMemory.
    /// Ret: `Err((Reject, op))`; yazım hatası: `io::Error`.
    pub fn actuate(&self, op: WriteOp<'_>) -> Result<(), (Reject, io::Error)> {
        let deny = |r: Reject| (r, io::Error::new(io::ErrorKind::PermissionDenied, "E_REJECTED"));
        if !self.scope.covers(op.addr, op.bytes.len()) {
            return Err((Reject::OutOfScope, io::Error::new(io::ErrorKind::PermissionDenied, "E_OUT_OF_SCOPE")));
        }
        match &self.hook {
            None => return Err(deny(Reject::HookDenied)), // kanca yoksa yazım kapalı
            Some(h) if !h(&op) => return Err(deny(Reject::HookDenied)),
            Some(_) => {}
        }
        unsafe {
            let mut wrote = 0usize;
            WriteProcessMemory(
                self.handle,
                op.addr as *const _,
                op.bytes.as_ptr() as *const _,
                op.bytes.len(),
                Some(&mut wrote),
            )
            .map_err(|e| (Reject::HookDenied, io::Error::from_raw_os_error(e.code().0)))?;
            if wrote != op.bytes.len() {
                return Err((Reject::HookDenied, io::Error::new(io::ErrorKind::WriteZero, "E_SHORT_WRITE")));
            }
        }
        Ok(())
    }
}