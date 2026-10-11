//! Harici araç çalıştırma yardımı (powershell, signtool, certutil, bcdedit).
//!
//! Hepsi gözlemlenebilir alt süreç çağrılarıdır; kancalama ya da enjeksiyon
//! içermez. Çıktı ham olarak raporlanır.

use std::ffi::OsStr;
use std::process::Command;

use crate::error::{MeError, Result};

pub struct ToolOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

impl ToolOutput {
    pub fn ok(&self) -> bool {
        self.status == 0
    }

    pub fn combined(&self) -> String {
        format!("{}\n{}", self.stdout, self.stderr)
    }
}

/// `program` + argümanlarla alt süreç çalıştır, çıktıyı yakala.
pub fn run_tool<S: AsRef<OsStr>>(program: &str, args: &[S]) -> Result<ToolOutput> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|_| MeError::Win32(std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32))?;

    Ok(ToolOutput {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// PowerShell'i `-NoProfile -NonInteractive` ile çalıştır ve tek komut ver.
pub fn run_powershell(command: &str) -> Result<ToolOutput> {
    run_tool(
        "powershell.exe",
        &[
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-Command".to_string(),
            command.to_string(),
        ],
    )
}

/// signtool.exe'yi PATH'ten ya da yüklü Windows Kits 10 ağaçlarından bul.
pub fn find_signtool() -> Option<String> {
    if let Ok(out) = run_tool("where.exe", &["signtool.exe".to_string()]) {
        if out.ok() {
            let first = out.stdout.lines().find(|l| !l.trim().is_empty());
            if let Some(path) = first {
                return Some(path.trim().to_string());
            }
        }
    }

    let kits_root = r"C:\Program Files (x86)\Windows Kits\10\bin";
    if let Ok(entries) = std::fs::read_dir(kits_root) {
        let mut versions: Vec<_> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        versions.sort();
        versions.reverse();
        for version_dir in versions {
            let candidate = version_dir.join("x64").join("signtool.exe");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}