//! Hata tipleri — NTSTATUS ve Win32 hata kodları kaybolmaz.
//!
//! Köprü sözleşmesi gereği çekirdek tarafı NTSTATUS ile hata verir; UM
//! tarafı DeviceIoControl'un GetLastError dönüşünü olduğu gibi korur.

use std::fmt;

/// Win32 GetLastError / NTSTATUS kaynak kodu.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MeError {
    /// DeviceIoControl/CreateFile ile taşınan Win32 hata kodu.
    Win32(u32),
    /// Yerel doğrulama hatası (durum sözleşmede belgeli).
    InvalidParameter(&'static str),
    /// IOCTL gönderildi ama çekirdek katman hazır değil
    /// (ör. sınıf-servis geri çağırma henüz bağlanmadı).
    NotReady(&'static str),
    /// Politika reddi: korumalı hedef sınıfı (REFUSED).
    ProtectedTarget(&'static str),
    /// Sürüm anlaşmazlığı (ABI sürümü desteklenmiyor).
    AbiMismatch(u32),
}

impl MeError {
    pub fn last_win32() -> Self {
        MeError::Win32(unsafe { windows_sys::Win32::Foundation::GetLastError() })
    }
}

impl fmt::Display for MeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MeError::Win32(code) => write!(f, "Win32 hatası {code:#010x}"),
            MeError::InvalidParameter(what) => write!(f, "geçersiz parametre: {what}"),
            MeError::NotReady(what) => write!(f, "katman hazır değil: {what}"),
            MeError::ProtectedTarget(what) => {
                write!(f, "politika reddi (REFUSED): korumalı hedef: {what}")
            }
            MeError::AbiMismatch(v) => write!(f, "ABI sürüm uyuşmazlığı: beklenen {} görülen {v}", crate::abi::ME_ABI_VERSION),
        }
    }
}

impl std::error::Error for MeError {}

pub type Result<T, E = MeError> = std::result::Result<T, E>;