//! Politika sınıf etiketleri (Sözleşme: `policy.rs` — KERNEL_ALLOWED (T1) +
//! HARDWARE_TIER (T2)).
//!
//! Köprü bir YETENEK katmanıdır: çekirdek IOCTL yüzeyi handle açmadan çalışır
//! ve PPL dahil tüm süreçlere kopyalama yapabilir (T1 spesifikasyonu: "handle
//! reddi yok"). RED kararları bu modülde tutulur ve IOCTL istemcisi
//! [`KernelAdmission`] damgası olmadan açılamaz — yani motorun
//! `TargetClass` sınıflaması UM sınırında zorlanır.

use crate::error::{MeError, Result};

/// Motorun hedef sınıfı (win32-memory-engine `TargetClass` ile birebir).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TargetClass {
    Normal,
    ProtectedProcessLight,
    ProtectedProcess,
    ProtectedUnknown,
    Gone,
}

/// Köprü yetenek sınıfları — düşüş merdiveni üzerine eklenen T1/T2 etiketleri.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CapabilityClass {
    /// Motor içi: yalnız uzaktan bellek (handle tabanlı) — köprü dışı.
    MemoryAllowed,
    /// Motor içi: yalnız pencere/girdi görüntüsü.
    InputOnly,
    /// Motor içi: yalnız ekran görüşü.
    VisionOnly,
    /// T1: çekirdek köprüsü IOCTL'leri (READVM/WRITEVM/PROTECT/INJECT/PID_OF/MODULES).
    KernelAllowed,
    /// T2 (ayrı donanım paketi): DMA/USB tabanlı fiziksel erişim sınıfı.
    HardwareTier,
    /// Mutlak ret.
    Refused,
}

/// Sınıf etiketinin yetenek kademesi.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tier {
    T1,
    T2,
}

impl CapabilityClass {
    pub fn tier(self) -> Option<Tier> {
        match self {
            CapabilityClass::KernelAllowed => Some(Tier::T1),
            CapabilityClass::HardwareTier => Some(Tier::T2),
            _ => None,
        }
    }
}

/// Yetkilendirme damgası: IOCTL istemcisi ancak bu damgayla açılır.
///
/// Korunan sınıflar (PPL/PP/bilinmeyen) ve kaybolmuş hedefler için üretilemez;
/// politika reddi motorla aynı gerekçede (`REFUSED`, ek deneme yok).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct KernelAdmission {
    pub target: TargetClass,
    pub class: CapabilityClass,
}

impl KernelAdmission {
    /// Hedef sınıfa göre çekirdek yetenek yoklaması.
    ///
    /// `Ok(KernelAllowed)` yalnız Normal hedefler için verilir; PPL/PP/
    /// bilinmeyen hedefler `Err(ProtectedTarget)` ile REFUSED olur ve IOCTL
    /// yolu hiç açılmaz (motorda `E_PROTECTED_TARGET` ile aynı politika).
    pub fn admit(target: TargetClass) -> Result<Self> {
        match target {
            TargetClass::Normal => Ok(KernelAdmission {
                target,
                class: CapabilityClass::KernelAllowed,
            }),
            TargetClass::ProtectedProcessLight => {
                Err(MeError::ProtectedTarget("ProtectedProcessLight"))
            }
            TargetClass::ProtectedProcess => Err(MeError::ProtectedTarget("ProtectedProcess")),
            TargetClass::ProtectedUnknown => Err(MeError::ProtectedTarget("ProtectedUnknown")),
            TargetClass::Gone => Err(MeError::ProtectedTarget("Gone (hedef süreç sonlanmış)")),
        }
    }

    /// Ham yetenek damgası: motor zaten kendi yoklamasını yaptıysa ve hedef
    /// Normal ise açıkça çağrılır.
    pub fn for_normal_target() -> Self {
        KernelAdmission {
            target: TargetClass::Normal,
            class: CapabilityClass::KernelAllowed,
        }
    }
}