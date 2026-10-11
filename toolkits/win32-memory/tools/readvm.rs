//! readvm — PID + sanal adres aralığı okur.
//!
//! Katmanlar: `ProcReader` (OpenProcess + ReadProcessMemory), tip kod çözücü
//! (`ValueKind`), pointer zinciri çözücü (`resolve_chain`). Win32 sınır çağrıları
//! yalnız burada `unsafe`; kod çözme/zincir mantığı saf.

use std::io;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

/// Tek çağrıda okunacak en büyük blok.
pub const MAX_BULK: usize = 4 << 20;

#[derive(Clone, Copy, Debug)]
pub enum ValueKind {
    U8,
    U16,
    U32,
    U64,
    I32,
    I64,
    F32,
    F64,
    /// Süreç pointer genişliğiyle okunur (4 ya da 8 bayt).
    Ptr,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Decoded {
    U(u64),
    I(i64),
    F(f64),
}

/// Saf kod çözme: ham baytları değere çevirir; boyut yetmezse hata.
pub fn decode(kind: ValueKind, raw: &[u8], ptr_width: usize) -> io::Result<Decoded> {
    let need = match kind {
        ValueKind::U8 => 1,
        ValueKind::U16 => 2,
        ValueKind::U32 | ValueKind::I32 | ValueKind::F32 => 4,
        ValueKind::U64 | ValueKind::I64 | ValueKind::F64 => 8,
        ValueKind::Ptr => ptr_width,
    };
    if raw.len() < need {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "E_SHORT_READ"));
    }
    let le = &raw[..need];
    Ok(match kind {
        ValueKind::U8 => Decoded::U(le[0] as u64),
        ValueKind::U16 => Decoded::U(u16::from_le_bytes([le[0], le[1]]) as u64),
        ValueKind::U32 => Decoded::U(u32::from_le_bytes(le.try_into().unwrap()) as u64),
        ValueKind::U64 => Decoded::U(u64::from_le_bytes(le.try_into().unwrap())),
        ValueKind::I32 => Decoded::I(i32::from_le_bytes(le.try_into().unwrap()) as i64),
        ValueKind::I64 => Decoded::I(i64::from_le_bytes(le.try_into().unwrap())),
        ValueKind::F32 => Decoded::F(f32::from_le_bytes(le.try_into().unwrap()) as f64),
        ValueKind::F64 => Decoded::F(f64::from_le_bytes(le.try_into().unwrap())),
        ValueKind::Ptr => Decoded::U(if ptr_width == 4 {
            u32::from_le_bytes(le.try_into().unwrap()) as u64
        } else {
            u64::from_le_bytes(le.try_into().unwrap())
        }),
    })
}

/// Tek sürecin okuma yüzeyi.
pub struct ProcReader {
    pub pid: u32,
    pub ptr_width: usize,
    handle: HANDLE,
}

impl ProcReader {
    pub fn open(pid: u32, ptr_width: usize) -> io::Result<Self> {
        assert!(ptr_width == 4 || ptr_width == 8);
        let handle = unsafe {
            OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
                .map_err(|e| io::Error::from_raw_os_error(e.code().0))?
        };
        Ok(Self { pid, ptr_width, handle })
    }

    /// `[addr, addr+len)` ham baytlarını okur.
    pub fn read(&self, addr: u64, len: usize) -> io::Result<Vec<u8>> {
        if len > MAX_BULK {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "E_RANGE_TOO_LARGE"));
        }
        let mut buf = vec![0u8; len];
        let mut got = 0usize;
        unsafe {
            ReadProcessMemory(self.handle, addr as *const _, buf.as_mut_ptr() as *mut _, len, Some(&mut got))
                .map_err(|e| io::Error::from_raw_os_error(e.code().0))?;
        }
        buf.truncate(got);
        Ok(buf)
    }

    /// `base` noktasından başlayıp her adımda pointer okuyan zinciri çözer:
    /// `[[base+o0]+o1]+…+oN`; son offset'in gösterdiği yer zincirin sonucudur.
    pub fn resolve_chain(&self, base: u64, offsets: &[i64]) -> io::Result<u64> {
        resolve_chain_with(self, base, offsets)
    }
}

impl Drop for ProcReader {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// Zincir çözümü okuma arayüzünden bağımsız saf akış (`ByteSource` gibi).
pub fn resolve_chain_with<S>(src: &S, base: u64, offsets: &[i64]) -> io::Result<u64>
where
    S: AsRef<ProcReader>,
{
    let r = src.as_ref();
    let mut addr = base;
    let (last, hops) = offsets.split_last().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "E_EMPTY_CHAIN")
    })?;
    for off in hops {
        addr = addr.wrapping_add(*off as u64);
        let raw = r.read(addr, r.ptr_width)?;
        addr = match decode(ValueKind::Ptr, &raw, r.ptr_width)? {
            Decoded::U(p) => p,
            _ => unreachable!(),
        };
        if addr == 0 {
            return Err(io::Error::new(io::ErrorKind::NotFound, "E_NULL_HOP"));
        }
    }
    Ok(addr.wrapping_add(*last as u64))
}

impl AsRef<ProcReader> for ProcReader {
    fn as_ref(&self) -> &ProcReader {
        self
    }
}