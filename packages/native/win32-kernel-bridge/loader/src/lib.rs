//! win32-kernel-bridge — UM yükleyici kitaplığı ve IOCTL istemci sınıfı.
//!
//! `win32-memory-engine` KERNEL_ALLOWED (T1) seviyesine bu paketin
//! [`client::MeClient`] sınıfıyla erişir; sürüm yüklemesi/test imzalama
//! [`scm`] + [`cert`] modüllerinde, giriş yığını sınıf bağlantısı
//! hazırlığı [`inputstack`] modülünde, sınıf etiketleri [`policy`]
//! modülündedir.
//!
//! IOCTL ABI'sinin tek kaynağı `../shared/me_ioctl.h` olup `build.rs`
//! içinde bindgen ile [`abi`] alt modülüne çevrilir.

#![deny(unsafe_op_in_unsafe_fn)]

pub mod abi {
    #![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, dead_code, clippy::all)]
    include!(concat!(env!("OUT_DIR"), "/me_ioctl.rs"));
}

pub mod cert;
pub mod client;
pub mod error;
pub mod inputstack;
pub mod policy;
pub mod scm;
pub mod tool;

pub use client::{InjectedKey, MeClient, ModuleInfo, WatchEvent};
pub use error::{MeError, Result};
pub use policy::{CapabilityClass, KernelAdmission, TargetClass, Tier};