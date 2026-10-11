//! aobscan — wildcard'lı byte deseni taraması (Array-of-Bytes).
//!
//! Desen sözdizimi: `48 8B ?? 89 ?` — `??`/`?` joker bayt. Tarama sabit
//! parçalara bölünür; parça sınırını aşan eşleşmeler için parçalar arasında
//! `pattern.len()-1` örtüşme bırakılır. Mantık `ByteSource` arkasında saf.

use std::io;

/// Örüntü: her bayt `Some(v)` ya da joker `None`.
#[derive(Debug, PartialEq)]
pub struct Pattern(pub Vec<Option<u8>>);

/// `"48 8B ?? 90"` → Pattern. Geçersiz tokende `E_BAD_PATTERN`.
pub fn parse_pattern(text: &str) -> io::Result<Pattern> {
    let mut out = Vec::new();
    for tok in text.split_whitespace() {
        match tok {
            "?" | "??" => out.push(None),
            b if b.len() == 2 && b.chars().all(|c| c.is_ascii_hexdigit()) => {
                out.push(Some(u8::from_str_radix(b, 16).unwrap()));
            }
            _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "E_BAD_PATTERN")),
        }
    }
    if out.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "E_BAD_PATTERN"));
    }
    Ok(Pattern(out))
}

impl Pattern {
    /// `hay[start..]` bu desenle başlıyor mu?
    pub fn matches_at(&self, hay: &[u8], start: usize) -> bool {
        self.0.iter().enumerate().all(|(i, want)| match want {
            None => true,
            Some(w) => hay.get(start + i) == Some(w),
        })
    }

    /// Tam tampon taraması — eşleşme başlangıç indeksleri (saf; test yüzeyi).
    pub fn find_all(&self, hay: &[u8]) -> Vec<usize> {
        let n = self.0.len();
        let mut hits = Vec::new();
        if n == 0 || hay.len() < n {
            return hits;
        }
        for i in 0..=(hay.len() - n) {
            if self.matches_at(hay, i) {
                hits.push(i);
            }
        }
        hits
    }
}

pub const CHUNK: usize = 1 << 20;

/// Bölge okuma arayüzü: `[base, base+size)` içinden dilim verir.
pub trait ByteSource {
    fn base(&self) -> u64;
    fn size(&self) -> u64;
    fn read(&self, addr: u64, len: usize) -> io::Result<Vec<u8>>;
}

/// Bölgesel tarama; VA mutlak adresleri döner. `limit` ilk N eşleşmede durur
/// (0 = sınırsız).
pub fn scan<S: ByteSource>(src: &S, pat: &Pattern, limit: usize) -> io::Result<Vec<u64>> {
    let (base, size) = (src.base(), src.size());
    let n = pat.0.len() as u64;
    if size < n {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    let overlap = (n - 1) as usize;
    let mut off = 0u64;
    while off + n <= size {
        let want = ((size - off) as usize).min(CHUNK);
        let buf = match src.read(base + off, want) {
            Ok(b) => b,
            // okunamayan dilim atlanır (sızıntılı/guard bölge)
            Err(_) => {
                off += want as u64;
                continue;
            }
        };
        for rel in pat.find_all(&buf) {
            hits.push(base + off + rel as u64);
            if limit != 0 && hits.len() >= limit {
                return Ok(hits);
            }
        }
        // parça sınırındaki yarım eşleşmeleri yakala: overlap kadar geride kal
        off += want.saturating_sub(overlap) as u64;
    }
    Ok(hits)
}

// Modül aralığı sarmalayıcısı (ToolHelp) — tarama hedefini `mod+0x1000` gibi
// daraltmak için; yalnız sınır çağrısı.
pub fn module_range(pid: u32, module: &str) -> io::Result<(u64, u64)> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
    };

    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid) }
        .map_err(|e| io::Error::from_raw_os_error(e.code().0))?;
    let mut me = MODULEENTRY32W {
        dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
        ..Default::default()
    };
    let want: Vec<u16> = OsStr::new(module).encode_wide().collect();
    let mut ok = unsafe { Module32FirstW(snap, &mut me) }.is_ok();
    while ok {
        let len = me.szModule.iter().position(|&c| c == 0).unwrap_or(me.szModule.len());
        if me.szModule[..len].eq_ignore_ascii_case(&want) {
            let base = me.modBaseAddr as u64;
            let range = (base, base + me.modBaseSize as u64);
            unsafe {
                let _ = CloseHandle(snap);
            }
            return Ok(range);
        }
        ok = unsafe { Module32NextW(snap, &mut me) }.is_ok();
    }
    unsafe {
        let _ = CloseHandle(snap);
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "E_MODULE_NOT_FOUND"))
}