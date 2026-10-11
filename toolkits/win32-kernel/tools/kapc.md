# `kapc` — payload yerleştirme + kullanıcı APC çalıştırma başlatma

Yetki: `kernel` · Ateşleme gömme: `code+guide` · Kod: [`kapc.c`](kapc.c)

## Görev

Payload'ı hedef süreçte yeni ayrılan sanal adrese (VA) yerleştirir ve hedefin bir iş parçacığına **kullanıcı APC** kuyruklar; payload olağan rutin (`NormalRoutine`) olarak çalıştırılır. Üç aşama tek IOCTL'de:

1. `ZwAllocateVirtualMemory` — hedefte `PAGE_EXECUTE_READWRITE` VA (`payload_len` yuvarlanmış sayfa sayısı).
2. `MmCopyVirtualMemory` — payload IOCTL arabelleğinden (çekirdek havuzu) hedef VA'ye.
3. `KeInitializeApc` + `KeInsertQueueApc` — `UserMode` olağan rutin = payload VA, `KernelRoutine`/`RundownRoutine` APC bloğunu geri alır.

Teslim kuralı (mekanik): Win10 1803+ özel kullanıcı APC'leri uyarı (`alertable`) beklemeden kullanıcı dönüşünde yürür; daha eski yapılarda hedef iş parçacığının uyarılabilir olması gerekir. Payload bittiğinde `RET` ile kesilmiş kullanıcı bağlamına dönülür.

## Giriş

| IOCTL | Alan | Tip | Açıklama |
| --- | --- | --- | --- |
| `IOCTL_KAPC_RUN` (`0x830`) | `pid` | `u32` | hedef süreç |
| | `tid` | `u32` | 0: süreçteki ilk iş parçacığı (`SystemProcessInformation` yürüyüşü) |
| | `payload_len` + `payload[]` | `u8[]` | PIC x64 kod |
| `IOCTL_KAPC_CLEAN` (`0x831`) | `pid`, `va`, `size` | — | ayırmayı `MEM_RELEASE` ile geri alır |

## Çıkış

| Durum | Şema |
| --- | --- |
| ok | `{"alloc_va": u64, "tid": u32, "queued": 1}` |
| hata | NTSTATUS: `STATUS_NOT_FOUND` (iş parçacığı yok), `STATUS_UNSUFFICIENT_RESOURCES`, `STATUS_UNSUCCESSFUL` (APC kuyruğa girmedi) |

Başarısızlıkta VA geri alınır (yarım ayırtma kalmaz). İşlem sonrası VA kalıcıdır; temizlik `IOCTL_KAPC_CLEAN` sorumluluğundadır.

## Payload ABI

x64 pozisyondan bağımsız kod; olağan rutin çağrısı `f(NormalContext=NULL, A1, A2)`. Global/RIID yok, sıfırla başlamalı koda güvenmemeli. `alloc_va` yanıtta döner; ikinci aşamalı kod için `kcopy` ile oradan yazım sürdürülür.