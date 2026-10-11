# `readvm` — süreç sanal bellek okuma

Yetki: `kernel` · Ateşleme gömme: `code` · Kod: [`readvm.rs`](readvm.rs)

## Görev

Verilen süreçte (PID) verilen sanal adres aralığını okur. Ham blok okumanın üzerine iki çözücü katman sunar: tipli değer kod çözme (tam sayı/kayan nokta/pointer) ve `taban+offset₀+offset₁+…` zincirleriyle dinamik taban adresi takibi. Tek çağrıda en fazla `MAX_BULK` (4 MiB) okur.

## Giriş

| Alan | Tip | Açıklama |
| --- | --- | --- |
| `pid` | `u32` | hedef süreç |
| `addr` | `u64` | başlangıç sanal adresi |
| `len` | `usize` | bayt uzunluğu (`≤ MAX_BULK`) |
| `kind` | `ValueKind` | nokta değeri okuması için: `U8/U16/U32/U64/I32/I64/F32/F64/Ptr` |
| `ptr_width` | `4 \| 8` | hedef pointer genişliği (Wow64 hedeflerde 4) |
| `chain` | `i64[]` | opsiyonel pointer zinciri offset'leri |

IPC karşılığı: `{"cmd":"read","pid","addr","len"}` (blok), `{"cmd":"peek","pid","addr","kind","chain"}` (nokta/zincir).

## Çıkış

| Durum | Şema |
| --- | --- |
| ok | `{"ok":true,"data":{"bytes":"<hex>"}` veya `{"value": <sayı>, "resolved": <u64>}}` |
| hata | `{"ok":false,"error":{"code":"E_SHORT_READ\|E_RANGE_TOO_LARGE\|E_NULL_HOP\|E_ACCESS_DENIED\|E_NOT_FOUND","detail","win32"}}` |

Zincir çözümünde ara hop null ise `E_NULL_HOP` döner; hangi indeste koptuğu `detail` içindedir.