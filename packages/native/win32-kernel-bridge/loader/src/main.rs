//! winmem-loader — WinMemEng kurulum/kaldırma ve IOCTL konsolu.
//!
//! Komutlar:
//!   provision  --sys <winmemeng.sys>            sertifika üret + test imzala + testsigning doğrula
//!   install    --sys <winmemeng.sys> [--name N] sc create type= kernel
//!   start      [--name N]                       NtLoadDriver / sc start
//!   stop       [--name N]                       sc stop
//!   uninstall  [--name N]                       sc stop + sc delete (+ sertifika temizliği: --cert <parmak izi>)
//!   status     [--name N]                       hizmet + testsigning durumu
//!   input-ready [--bounce]                      sınıf-servis bağlantı yoklaması (+ gerekirse CM döngüsü)
//!   readvm     --pid N --addr HEX [--size N | --out F]
//!   writevm    --pid N --addr HEX --file F
//!   watch-add|watch-remove N | watch-clear | watch-drain [--max N]
//!   key        --seq "30,30:b,e0:4d:e0:4d:b"    MAKE/BREAK dizisi enjeksiyonu
//!   move       --dx N --dy N [--buttons left|right|middle]  fare enjeksiyonu
//!   pidof      <görüntü-adı>
//!   modules    --pid N
//!   Genel: --target normal|ppl|pp|unknown|gone  politika yoklaması (varsayılan normal)
//!
//! RİSK: yüklenen sürücü çekirdek ayrıcalıklıdır; yalnz test imzalama + yönetici
//! oturumu içindir. Hook yok, SSDT/IDT ezme yok — yalnız belgelenmiş dışa
//! aktarımlar ve sınıf geri çağırma sözleşmesi.

use std::path::PathBuf;
use std::process::exit;

use winmem_kernel_loader::policy::{KernelAdmission, TargetClass};
use winmem_kernel_loader::{
    cert, inputstack, scm, InjectedKey, MeClient, MeError, Result as MeResult,
};

const DEFAULT_SERVICE: &str = "WinMemEng";

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("hata: {msg}");
    exit(1)
}

struct Args {
    command: String,
    positional: Vec<String>,
    flags: std::collections::HashMap<String, String>,
}

fn parse_args() -> Args {
    let mut argv = std::env::args().skip(1);
    let command = match argv.next() {
        Some(c) => c,
        None => fail("komut gerekli; bkz. dosya başındaki komut listesi"),
    };
    let mut positional = Vec::new();
    let mut flags = std::collections::HashMap::new();
    while let Some(token) = argv.next() {
        if let Some(name) = token.strip_prefix("--") {
            let value = argv.next().unwrap_or_else(|| fail(format!("--{name} değeri gerekli")));
            flags.insert(name.to_string(), value);
        } else {
            positional.push(token);
        }
    }
    Args { command, positional, flags }
}

impl Args {
    fn flag(&self, name: &str) -> Option<&str> {
        self.flags.get(name).map(|s| s.as_str())
    }

    fn require(&self, name: &str) -> &str {
        self.flag(name)
            .unwrap_or_else(|| fail(format!("--{name} gerekli")))
    }

    fn number_u64(&self, name: &str) -> u64 {
        parse_number(self.require(name))
            .unwrap_or_else(|_| fail(format!("--{name} geçerli bir sayı değil")))
    }

    fn service_name(&self) -> &str {
        self.flag("name").unwrap_or(DEFAULT_SERVICE)
    }
}

fn parse_number(text: &str) -> std::result::Result<u64, std::num::ParseIntError> {
    let text = text.trim();
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16)
    } else {
        text.parse()
    }
}

fn open_client(args: &Args) -> MeResult<MeClient> {
    match args.flag("target").unwrap_or("normal") {
        "normal" => MeClient::open(KernelAdmission::for_normal_target()),
        other => match other {
            "ppl" => MeClient::open_for_target(TargetClass::ProtectedProcessLight),
            "pp" => MeClient::open_for_target(TargetClass::ProtectedProcess),
            "unknown" => MeClient::open_for_target(TargetClass::ProtectedUnknown),
            "gone" => MeClient::open_for_target(TargetClass::Gone),
            _ => Err(MeError::InvalidParameter("bilinmeyen --target")),
        },
    }
}

/// "--seq 30,30:b,0x4d+e0,0x4d+e0:b" → art arda MAKE/BREAK çerçeveleri.
/// Biçim: `<hex-kod>[+e0|+e1][:b]`; `:b` bırakım, `+e0/+e1` önek bayrağı.
fn parse_key_seq(seq: &str) -> MeResult<Vec<InjectedKey>> {
    let mut keys = Vec::new();
    for token in seq.split(',') {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }

        let mut flags: u16 = 0;
        let mut colon_parts = token.split(':');
        let code_part = colon_parts.next().unwrap_or_default();
        for suffix in colon_parts {
            match suffix.trim() {
                "b" => flags |= winmem_kernel_loader::abi::ME_KEY_BREAK as u16,
                _ => return Err(MeError::InvalidParameter("bilinmeyen tuş soneki (:b bekleniyordu)")),
            }
        }

        let mut atoms = code_part.split('+');
        let code = atoms.next().unwrap_or_default().trim();
        let code = code
            .strip_prefix("0x")
            .or_else(|| code.strip_prefix("0X"))
            .unwrap_or(code);
        for modifier in atoms {
            match modifier.trim() {
                "e0" => flags |= winmem_kernel_loader::abi::ME_KEY_E0 as u16,
                "e1" => flags |= winmem_kernel_loader::abi::ME_KEY_E1 as u16,
                _ => return Err(MeError::InvalidParameter("bilinmeyen tuş niteleyicisi (+e0/+e1)")),
            }
        }

        let make_code = u16::from_str_radix(code, 16)
            .map_err(|_| MeError::InvalidParameter("tarama kodu hexadecimal olmalı"))?;
        keys.push(InjectedKey { make_code, flags });
    }
    if keys.is_empty() {
        return Err(MeError::InvalidParameter("--seq boş"));
    }
    Ok(keys)
}

/// İşaretli sayı (fare deltası için negatif destekli).
fn parse_signed(text: &str) -> MeResult<i64> {
    let text = text.trim();
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).map(|v| v as i64)
    } else {
        text.parse::<i64>()
    }
    .map_err(|_| MeError::InvalidParameter("sayı bekleniyordu"))
}

fn main() {
    let args = parse_args();

    if let Err(err) = run(&args) {
        fail(err);
    }
}

fn run(args: &Args) -> MeResult<()> {
    match args.command.as_str() {
        "provision" => {
            let sys = PathBuf::from(args.require("sys"));
            match scm::check_testsigning()? {
                scm::TestSigning::Enabled => println!("testsigning: etkin"),
                scm::TestSigning::Disabled => eprintln!("{}", scm::TESTSIGNING_WARNING),
                scm::TestSigning::Unknown(_) => {
                    eprintln!("uyarı: testsigning durumu belirlenemedi (bcdedit çıktısına bakın)")
                }
            }
            let cert = cert::provision_and_sign(&sys)?;
            println!("sertifika parmak izi: {}", cert.thumbprint);
            println!("imzalandı: {}", sys.display());
            let verify = cert::verify(&sys)?;
            println!("{}", verify.combined().trim());
        }

        "install" => {
            let sys = PathBuf::from(args.require("sys"));
            scm::create_kernel_service(args.service_name(), &sys)?;
            println!("hizmet kuruldu: {} (type= kernel)", args.service_name());
        }

        "start" => {
            scm::start_service(args.service_name())?;
            println!("hizmet yüklendi/çalışıyor: {}", args.service_name());
        }

        "stop" => {
            scm::stop_service(args.service_name())?;
            println!("hizmet durduruldu: {}", args.service_name());
        }

        "uninstall" => {
            scm::stop_and_delete(args.service_name())?;
            if let Some(thumb) = args.flag("cert") {
                cert::remove_test_cert(thumb)?;
                println!("sertifika temizlendi: {thumb}");
            }
            println!("hizmet kaldırıldı: {}", args.service_name());
        }

        "status" => {
            let state = scm::query_service(args.service_name())?;
            println!(
                "hizmet {}: var={} çalışıyor={}",
                args.service_name(),
                state.exists,
                state.running
            );
            match scm::check_testsigning()? {
                scm::TestSigning::Enabled => println!("testsigning: etkin"),
                scm::TestSigning::Disabled => println!("{}", scm::TESTSIGNING_WARNING),
                scm::TestSigning::Unknown(_) => println!("testsigning: bilinmiyor"),
            }
        }

        "input-ready" => {
            let mut client = open_client(args)?;
            if client.input_link_ready()? {
                println!("sınıf-servis bağlantısı: kurulu");
            } else {
                println!("sınıf-servis bağlantısı: KURULU DEĞİL");
                if args.flag("bounce").is_some() {
                    eprintln!("uyarı: giriş yığını yeniden başlatılıyor; kısa süreli giriş kesintisi olur");
                    let report = inputstack::bounce_input_stack()?;
                    println!(
                        "CM döngüsü: HID düğüm={} yeniden bağlanan={} sorun={}",
                        report.hid_nodes_seen,
                        report.bounced,
                        report.problems.len()
                    );
                    for problem in &report.problems {
                        eprintln!("  {problem}");
                    }
                } else {
                    eprintln!("ipucu: --bounce ile CFG döngüsü tetiklenebilir");
                }
            }
        }

        "readvm" => {
            let pid = args.number_u64("pid") as u32;
            let addr = args.number_u64("addr");
            let size = args.flag("size").map(|s| parse_number(s).unwrap_or(0)).unwrap_or(256) as usize;
            let mut buf = vec![0u8; size];
            let mut client = open_client(args)?;
            let read = client.read_vm(pid, addr, &mut buf)?;
            if let Some(out) = args.flag("out") {
                std::fs::write(out, &buf[..read])
                    .map_err(|e| MeError::Win32(e.raw_os_error().unwrap_or(0) as u32))?;
                println!("{read} bayt yazıldı: {out}");
            } else {
                for (i, chunk) in buf[..read].chunks(16).enumerate() {
                    let hex: Vec<String> = chunk.iter().map(|b| format!("{b:02x}")).collect();
                    println!("{:08x}: {}", addr as usize + i * 16, hex.join(" "));
                }
            }
        }

        "writevm" => {
            let pid = args.number_u64("pid") as u32;
            let addr = args.number_u64("addr");
            let file = args.require("file");
            let data = std::fs::read(file)
                .map_err(|e| MeError::Win32(e.raw_os_error().unwrap_or(0) as u32))?;
            let mut client = open_client(args)?;
            let written = client.write_vm(pid, addr, &data)?;
            println!("{written} bayt yazıldı");
        }

        "watch-add" => {
            let pid = args.positional.first().map(|p| parse_number(p).unwrap_or(0)).unwrap_or(0) as u32;
            let mut client = open_client(args)?;
            client.watch_add(pid)?;
            println!("izlemeye alındı: {pid}");
        }

        "watch-remove" => {
            let pid = args.positional.first().map(|p| parse_number(p).unwrap_or(0)).unwrap_or(0) as u32;
            let mut client = open_client(args)?;
            client.watch_remove(pid)?;
            println!("izlemeden çıkarıldı: {pid}");
        }

        "watch-clear" => {
            let mut client = open_client(args)?;
            client.watch_clear()?;
            println!("izleme listesi temizlendi");
        }

        "watch-drain" => {
            let max = args.flag("max").map(|m| parse_number(m).unwrap_or(64)).unwrap_or(64) as u32;
            let mut client = open_client(args)?;
            for event in client.watch_drain(max)? {
                println!(
                    "{} pid={} parent={} name={}",
                    if event.record_type == 1 { "CREATE" } else { "EXIT  " },
                    event.pid,
                    event.parent_pid,
                    event.image_name
                );
            }
        }

        "key" => {
            let keys = parse_key_seq(args.require("seq"))?;
            let mut client = open_client(args)?;
            client.inject_scancode(0, &keys)?;
            println!("{} enjeksiyon çerçevesi gönderildi", keys.len());
        }

        "move" => {
            let dx = parse_signed(args.require("dx"))? as i32;
            let dy = parse_signed(args.require("dy"))? as i32;
            let mut client = open_client(args)?;
            client.inject_mouse(0, 0, 0, 0, dx, dy)?;
            if let Some(button) = args.flag("buttons") {
                use winmem_kernel_loader::abi::*;
                let (down, up) = match button {
                    "left" => (ME_MOUSE_LEFT_BUTTON_DOWN, ME_MOUSE_LEFT_BUTTON_UP),
                    "right" => (ME_MOUSE_RIGHT_BUTTON_DOWN, ME_MOUSE_RIGHT_BUTTON_UP),
                    "middle" => (ME_MOUSE_MIDDLE_BUTTON_DOWN, ME_MOUSE_MIDDLE_BUTTON_UP),
                    _ => fail("--buttons left|right|middle"),
                };
                client.inject_mouse(0, 0, down as u16, 0, 0, 0)?;
                client.inject_mouse(0, 0, up as u16, 0, 0, 0)?;
            }
            println!("fare enjeksiyonu gönderildi");
        }

        "pidof" => {
            let name = args.positional.first().map(|s| s.as_str()).unwrap_or_else(|| fail("görüntü adı gerekli"));
            let mut client = open_client(args)?;
            for (pid, base) in client.pid_of(name)? {
                println!("pid={pid} base=0x{base:x}");
            }
        }

        "modules" => {
            let pid = args.number_u64("pid") as u32;
            let mut client = open_client(args)?;
            for module in client.modules(pid)? {
                let mark = if module.is_ntoskrnl { " [ntoskrnl]" } else { "" };
                println!(
                    "0x{:012x} {:>10} {}{}",
                    module.image_base, module.image_size, module.name, mark
                );
            }
        }

        "admission" => {
            // Politika yoklamasını göster (hedef sınıfı testi).
            let target = match args.flag("target").unwrap_or("normal") {
                "normal" => TargetClass::Normal,
                "ppl" => TargetClass::ProtectedProcessLight,
                "pp" => TargetClass::ProtectedProcess,
                "unknown" => TargetClass::ProtectedUnknown,
                "gone" => TargetClass::Gone,
                _ => fail("bilinmeyen --target"),
            };
            match KernelAdmission::admit(target) {
                Ok(admission) => println!("izin: {:?}", admission.class),
                Err(err) => println!("REFUSED: {err}"),
            }
        }

        other => fail(format!("bilinmeyen komut: {other}")),
    }
    Ok(())
}