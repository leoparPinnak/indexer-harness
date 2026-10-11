//! Test sertifikası üretimi, test imzalama ve sertifika temizliği.
//!
//! Akış (yalnız belgelenmiş araçlar; kancalama/enjeksiyon yok):
//!   1. PowerShell `New-SelfSignedCertificate -Type CodeSigningCert` üretir.
//!   2. Sertifika `certutil -addstore` ile Root + TrustedPublisher mağazalarına
//!      konur (test imzalı çekirdek yüklemesi için gerekli güven).
//!   3. `signtool sign /fd SHA256 /sha1 <parmak izi> <sys>` imzalar.
//!   4. `signtool verify` ile doğrular.
//! Kaldırma: `certutil -delstore` + PowerShell `Remove-Item` mağaza temizliği.

use std::path::{Path, PathBuf};

use crate::error::{MeError, Result};
use crate::tool::{find_signtool, run_powershell, run_tool, ToolOutput};

const CERT_SUBJECT: &str = "CN=WinMemEng Test Signing (DSH)";

pub struct TestCert {
    pub thumbprint: String,
    pub cer_path: PathBuf,
}

fn parse_thumbprint(output: &ToolOutput) -> Result<String> {
    output
        .stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_uppercase())
        .filter(|line| line.chars().all(|c| c.is_ascii_hexdigit()) && line.len() >= 16)
        .ok_or(MeError::InvalidParameter("parmak izi PowerShell çıktısından ayrıştırılamadı"))
}

/// Üret + mağazalara güven + sürücüyü imzala. Dönen: sertifika + .cer yolu.
pub fn provision_and_sign(sys_path: &Path) -> Result<TestCert> {
    let cer_path = std::env::temp_dir().join("winmemeng-test-signing.cer");
    let ps = format!(
        "$c = New-SelfSignedCertificate -Type CodeSigningCert -Subject '{subject}' \
         -CertStoreLocation Cert:\\CurrentUser\\My -KeyAlgorithm RSA -KeyLength 2048 \
         -HashAlgorithm SHA256 -KeyExportPolicy Exportable; \
         $c | Export-Certificate -FilePath '{cer}' -Force | Out-Null; \
         $c.Thumbprint",
        subject = CERT_SUBJECT,
        cer = cer_path.display()
    );

    let created = run_powershell(&ps)?;
    if !created.ok() {
        return Err(MeError::InvalidParameter(
            "New-SelfSignedCertificate başarısız (PowerShell/İstemci Sertifikaları)",
        ));
    }
    let thumbprint = parse_thumbprint(&created)?;

    // Güven köküne al: test imzalı çekirdek yüklemesi bunu şart koşar.
    for store in ["Root", "TrustedPublisher"] {
        let out = run_tool(
            "certutil.exe",
            &[
                "-f".to_string(),
                "-addstore".to_string(),
                store.to_string(),
                cer_path.display().to_string(),
            ],
        )?;
        if !out.ok() {
            return Err(MeError::InvalidParameter(
                "certutil -addstore başarısız (yönetici yetkisi gerekli)",
            ));
        }
    }

    sign(sys_path, &thumbprint)?;

    Ok(TestCert { thumbprint, cer_path })
}

/// `signtool sign /fd SHA256 /sha1 <parmak izi> <sys>`.
pub fn sign(sys_path: &Path, thumbprint: &str) -> Result<()> {
    let signtool = find_signtool()
        .ok_or(MeError::InvalidParameter("signtool.exe bulunamadı (Windows SDK/WDK)"))?;

    let out = run_tool(
        &signtool,
        &[
            "sign".to_string(),
            "/fd".to_string(),
            "SHA256".to_string(),
            "/sha1".to_string(),
            thumbprint.to_string(),
            sys_path.display().to_string(),
        ],
    )?;
    if !out.ok() {
        return Err(MeError::InvalidParameter("signtool sign başarısız"));
    }
    Ok(())
}

/// `signtool verify` — sonuç ham raporlanır.
pub fn verify(sys_path: &Path) -> Result<ToolOutput> {
    let signtool = find_signtool()
        .ok_or(MeError::InvalidParameter("signtool.exe bulunamadı (Windows SDK/WDK)"))?;
    run_tool(
        &signtool,
        &["verify".to_string(), "/pa".to_string(), sys_path.display().to_string()],
    )
}

/// Sertifika temizliği: mağazalardan sil (kaldırma adımının parçası).
pub fn remove_test_cert(thumbprint: &str) -> Result<()> {
    let mut errors = Vec::new();

    for store in ["Root", "TrustedPublisher"] {
        let out = run_tool(
            "certutil.exe",
            &[
                "-delstore".to_string(),
                store.to_string(),
                thumbprint.to_string(),
            ],
        )?;
        if !out.ok() {
            errors.push(format!("{store}: {}", out.combined().trim()));
        }
    }

    let ps = format!(
        "Remove-Item -LiteralPath 'Cert:\\CurrentUser\\My\\{thumb}' -ErrorAction SilentlyContinue",
        thumb = thumbprint
    );
    let out = run_powershell(&ps)?;
    if !out.ok() {
        errors.push(format!("CurrentUser\\My: {}", out.combined().trim()));
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(MeError::InvalidParameter(
            "sertifika temizliği kısmen başarısız (certutil/PowerShell çıktısına bakın)",
        ))
    }
}