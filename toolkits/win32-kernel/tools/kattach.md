# `kattach` — çekirdek süreç kolu üretimi

Yetki: `kernel` · Ateşleme gömme: `code` · Kod: [`kattach.c`](kattach.c)

## Görev

Verilen PID'e çekirdek süreç kolu (`PEPROCESS` + `KERNEL_HANDLE`) üretir ve sürücü içi yuvaya bağlar. Üretim `ObOpenObjectByPointer` ile `KernelMode` erişim kipinde yapılır; kullanıcı ACL'leri değerlendirme dışı kalır, süreç PPL olsa da kol açılır. Yanıt olarak sürüm içi `attach_id` döner (kolun kendisi kullanıcı moduna geçmez); `kapc` gibi diğer araçlar bu kimliğe başvurur. Aynı geçişte koruma sınıfı yoklaması (`PsGetProcessProtection`) yapılır ve `TargetClass` sözleşmesiyle birebir aynı sınıfla raporlanır.

## Giriş

| IOCTL | Alan | Tip | Açıklama |
| --- | --- | --- | --- |
| `IOCTL_KATTACH_OPEN` (`0x820`) | `pid` | `u32` | bağlanılacak süreç |
| `IOCTL_KATTACH_PROBE` (`0x821`) | `pid` | `u32` | yalnız sınıf yoklaması (kol açılmaz) |
| `IOCTL_KATTACH_CLOSE` (`0x822`) | `attach_id` | `u32` | yuvayı boşaltır, kolu kapatır |

## Çıkış

`{"attach_id": u32, "klass": "..."}` — `klass` değerleri: `Normal`, `ProtectedProcessLight`, `ProtectedProcess`, `ProtectedUnknown`, `Gone`.

Ölü/silinmiş hedef `Gone` ile raporlanır ve `OPEN` yanıtı `attach_id: 0` taşır; ret ayrıca NTSTATUS ile bildirilir (yutma yok). Sistem genelinde en fazla 32 eşzamanlı kol; aşımda `STATUS_INSUFFICIENT_RESOURCES`. `DriverUnload` açık yuvaların tamamını kapatır.