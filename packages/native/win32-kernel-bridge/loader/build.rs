// win32-kernel-bridge — loader/build.rs
//
// IOCTL ABI'sinin TEK KAYNAĞI olan shared/me_ioctl.h, burada bindgen ile
// Rust bağlarına çevrilir (OUT_DIR/me_ioctl.rs). Böylece sürücü (#include)
// ve yükleyici (derleme zamanı üretimi) aynı başlıktan beslenir; IOCTL kodu
// ya da yapı yerleşimi hiçbir yerde elle kopyalanmaz.

use std::env;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let header = manifest_dir.join("..").join("shared").join("me_ioctl.h");

    println!("cargo:rerun-if-changed={}", header.display());

    let bindings = bindgen::Builder::default()
        .header(header.to_string_lossy())
        .use_core()
        .ctypes_prefix("core::ffi")
        .layout_tests(false)
        .generate_comments(true)
        // GUID baytı dizersi yalnız sürücü tarafında kurulur (C başlatıcı listesi).
        .blocklist_macro("ME_IFGUID_DATA.*")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .expect("shared/me_ioctl.h bindgen ile çevrilemedi");

    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("me_ioctl.rs");
    bindings
        .write_to_file(out)
        .expect("OUT_DIR/me_ioctl.rs yazılamadı");
}