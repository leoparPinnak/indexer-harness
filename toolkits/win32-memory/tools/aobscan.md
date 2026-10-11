# `aobscan` — AOB desen taraması

Yetki: `kernel` · Ateşleme gömme: `code` · Kod: [`aobscan.rs`](aobscan.rs)

## Görev

Wildcard'lı byte desenini (`48 8B ?? 89 ?` — `??`/`?` joker) sanal adres bölgesinde arar. Tarama 1 MiB'lık parçalara bölünür; parçalar arası `pattern.len()-1` örtüşme sayesinde parça sınırını aşan eşleşmeler kaybolmaz. Okunamayan dilim atlanır, tarama devam eder. Arama alanı serbest VA aralığı ya da `modules` ile bulunmuş modül aralığı olabilir.

## Giriş

| Alan | Tip | Açıklama |
| --- | --- | --- |
| `pid` | `u32` | hedef süreç |
| `pattern` | `string` | hex baytlar + `??`/`?` joker |
| `range` | `[u64, u64]` | taranacak `[base, size)` bölgesi |
| `module` | `string?` | verilirse `module_range(pid, module)` bölgesi kullanılır |
| `limit` | `usize` | ilk N eşleşmede dur (0 = sınırsız) |

## Çıkış

| Durum | Şema |
| --- | --- |
| ok | `{"ok":true,"data":{"hits":["<hex va>", ...]}}` |
| hata | `{"ok":false,"error":{"code":"E_BAD_PATTERN\|E_MODULE_NOT_FOUND","detail","win32"}}` |

Başka örüntü: `aobscan` ile kararlı kod imzası bul → bulunan VA yanındaki `lea/mov` pointer'ı → `readvm` zincir takibi ile dinamik veri tabanına ulaş.