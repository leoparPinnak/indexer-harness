# `kinput` — sınıf girdi enjeksiyonu

Yetki: `kernel` · Ateşleme gömme: `code+guide` · Kod: [`kinput.c`](kinput.c)

## Görev

Pencere sınıfı odaklı girdi enjeksiyonu: verilen sınıf adına (`NtUserFindWindowEx`) pencereyi bulur, öne alır (`NtUserSetForegroundWindow`) ve win32k servis katmanına doğrudan `NtUserSendInput` çağrısıyla ham `INPUT` paketlerini iletir. win32k çağrıları sürücü iş parçacığından yapıldığından `PreviousMode = Kernel` olur; win32k kullanıcı işaretçisi ön-süzgeçleri devreye girmez, paketler ham geçer (x64'te `sizeof(INPUT) = 40` bayt).

## Giriş

| IOCTL | Alan | Tip | Açıklama |
| --- | --- | --- | --- |
| `IOCTL_KINPUT_BIND` (`0x840`) | `idx_send_input`, `idx_find_window`, `idx_set_fg` | `u32` | win32kfull servis indisleri |
| `IOCTL_KINPUT_CLASS_SEND` (`0x841`) | `gui_pid` | `u32` | oturum donörü GUI süreci |
| | `class_name` | `UTF-16[64]` | pencere sınıfı adı |
| | `input_count`, `input_cb` | `u32` | `INPUT` adedi / tekil boyut |
| | `inputs[]` | `u8[]` | ham `INPUT` dizisi (istemcide kurulmuş) |

### İndis getirme (BIND)

İstemci kendi win32k eşlemesinde `win32kfull!NtUserSendInput` vb. çağrı yongalarını çözüp ilk baytları (`B8 xx xx xx xx 0F 05` = `mov eax, idx; syscall`) okur; `idx` üçlüsünü BIND ile sürücüye verir. Sürücü gölge SSDT'deki (win32k servis tablosu, `KeServiceDescriptorTable` çevresi) karşılık gelen fonksiyon işaretçilerini çözümleyip kullanır.

## Çıkış

| Durum | Şema |
| --- | --- |
| ok | `{"hwnd": u64, "sent": u32}` — bulunan pencere + kabul edilen olay sayısı |
| pencere yok | `{"hwnd": 0, "sent": 0}` (sınıf bulunamadı; ret değil, boş sonuç) |
| hata | NTSTATUS: `STATUS_INVALID_PARAMETER` (indeks dışı), `STATUS_INVALID_ADDRESS`, `STATUS_DEVICE_CONFIGURATION_ERROR` (gölge SDT bulunamadı) |

Kullanım sırası: `BIND` bir kez, ardından `CLASS_SEND` istenen kadar. Sınıf eşleşmesi birden çok pencere tutuyorsa `NtUserFindWindowEx` sıradaki adayı döndürür; seçim için pencere başlığı zinciri ayrı çağrı turunda `readvm`/UI katmanından beslenebilir.