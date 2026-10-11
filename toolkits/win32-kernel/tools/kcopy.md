# `kcopy` — çekirdek süreçler arası bellek kopyası

Yetki: `kernel` · Ateşleme gömme: `code+guide` · Kod: [`kcopy.c`](kcopy.c)

## Görev

Kaynak PID + sanal adresinden hedef PID + sanal adresine blok kopyası yapar (`MmCopyVirtualMemory`). Her iki yönde çalışır (tek `direction` biti); süreç kolları her işlemde PID'lerden çözülür, işlem sonrası referanslar bırakılır. Kopyalanan bayt sayısı yanıtta döner.

## Giriş — `IOCTL_KCOPY_COPY` (`METHOD_BUFFERED`)

| Alan | Tip | Açıklama |
| --- | --- | --- |
| `src_pid` | `u32` | kaynak süreç |
| `dst_pid` | `u32` | hedef süreç |
| `src_va` | `u64` | kaynak sanal adres |
| `dst_va` | `u64` | hedef sanal adres |
| `length` | `u64` | bayt sayısı |
| `direction` | `u32` | `1`: `src_va→dst_va`, `0`: `dst_va→src_va` |

## Çıkış

| Durum | Şema |
| --- | --- |
| ok | `ULONG64 done` — kopyalanan bayt (ara belleğin başına yazılır) |
| hata | NTSTATUS: `STATUS_INVALID_PARAMETER`, `STATUS_UNSUCCESSFUL` (ölü PID), `STATUS_PARTIAL_COPY` (kısmi kopya) |

Not: `MmCopyVirtualMemory` kısmi kopyada `STATUS_PARTIAL_COPY` + gerçek `done` üretir; `done` her zaman dürüst değerdir.