# Win32 Çekirdek Müdahale Motoru — Set Kılavuzu (`win32-kernel`)

## Set tanımı

Çekirdek düzeyinde süreç müdahalesi seti. Bir WDM sürücüsünün IOCTL yüzeyi (`METHOD_BUFFERED`, `\Device\DshKbr`) üzerinde dört araç: `MmCopyVirtualMemory` ile süreçler arası sanal bellek kopyası, PPL dahil çekirdek süreç kolu üretimi, pencere sınıfı odaklı girdi enjeksiyonu (win32k servis katmanı) ve kullanıcı APC ile çalıştırma başlatma.

## Yetenek kümesi ve yetki

- `capabilitySet`: `kernel-intervention`
- Set yetkisi: `kernel` — tüm üyeler `kernel` kademesindedir.
- Kademe BİLGİdir, kapı değil: tanımdır, onay değil.

| Araç | Yetki | IOCTL |
| --- | --- | --- |
| `kcopy` | `kernel` | `0x810` |
| `kattach` | `kernel` | `0x820`–`0x822` |
| `kapc` | `kernel` | `0x830`–`0x831` |
| `kinput` | `kernel` | `0x840`–`0x841` |

## Setteki araçların görevi

- **`kcopy`** — İki süreç (kaynak PID, hedef PID) arasında sanal bellek bloğu kopyalar. Yönlüdür (her iki okuma/yazma tek işlemde); `MmCopyVirtualMemory` dönüş sayısı `done` olarak raporlanır.
- **`kattach`** — Verilen PID'e çekirdek süreç kolu (kernel handle) üretir ve sürücü içi yuvaya bağlar; müşteri `attach_id` ile bu kolu kullanır. Aynı geçişte koruma sınıfı yoklaması yapar ve sonucu `Normal` / `ProtectedProcessLight` / `ProtectedProcess` / `ProtectedUnknown` / `Gone` sınıfıyla raporlar.
- **`kinput`** — Sınıf girdi enjeksiyonu: verilen pencere sınıfı adına (`NtUserFindWindowEx`) pencereyi bulur, öne alır (`NtUserSetForegroundWindow`) ve win32k servis katmanından `NtUserSendInput` ile ham `INPUT` paketlerini iletir.
- **`kapc`** — Payload'ı hedef süreçte ayrılan VA'ya yerleştirir (ayrıca `kcopy` ile de doldurulabilir), hedefin bir iş parçacığına kullanıcı APC kuyruklar (`KeInitializeApc` + `KeInsertQueueApc`); payload olağan rutin olarak çalışır. `CLEAN` işlemi ayrılan VA'yi geri alır.

Her aracın ayrıntısı `tools/<tool-id>.md`; ateşlemede gömülen ham kod `tools/<tool-id>.c`.

## IOCTL yüzeyi

| Kod | İstek | Hizmet ettiği |
| --- | --- | --- |
| `IOCTL_KCOPY_COPY` | `{src_pid, dst_pid, src_va, dst_va, length, direction}` | `kcopy` |
| `IOCTL_KATTACH_OPEN` | `{pid}` → `{attach_id, class}` | `kattach` |
| `IOCTL_KATTACH_PROBE` | `{pid}` → `{class}` | `kattach` |
| `IOCTL_KATTACH_CLOSE` | `{attach_id}` | `kattach` |
| `IOCTL_KAPC_RUN` | `{pid, tid, payload[]}` → `{alloc_va, tid, queued}` | `kapc` |
| `IOCTL_KAPC_CLEAN` | `{pid, alloc_va, size}` | `kapc` |
| `IOCTL_KINPUT_BIND` | `{idx_send_input, idx_find_window, idx_set_fg}` | `kinput` |
| `IOCTL_KINPUT_CLASS_SEND` | `{gui_pid, class_utf16[], inputs[]}` → `{hwnd, sent}` | `kinput` |

`kinput` bağlayıcı indisleri istemciden alır: win32kfull servis indisleri kullanıcı istemcinin kendi win32k çağrı yongalarından (`mov eax, idx; syscall`) okunur; sürücü gölge SSDT'deki karşılık gelen fonksiyon işaretçilerini çözümleyip oturum bağlamına `KeStackAttachProcess` ile bağlanarak çağırır.

## Kullanım örüntüleri

1. **Yoklama → kopya**: `kattach PROBE` ile sınıfı gör → `kcopy` ile çekirdek üzerinden iki yönlü blok kopyası (VM_READ kolu olmadan da kaynaktan okuma). Kolu ayrıca `kattach OPEN` ile kalıcılaştır; `kcopy` PID tabanlı çalıştığından bağımsız da kullanılabilir.
2. **Sınıf girdisi**: `kinput BIND` indisleri iliştir → `CLASS_SEND` ile sınıf adı + `INPUT` paketleri. Oturum donörü (`gui_pid`) hedef oturumda herhangi bir GUI süreci olabilir.
3. **Çalıştırma başlatma**: `kattach PROBE` ile sınıfı gör → `IOCTL_KAPC_RUN` payload'ı hedef VA'ye yerleştirip APC'yi kuyruklar → bitişte `IOCTL_KAPC_CLEAN`; payload verisini sonradan büyütmek için `kcopy` hedef VA'ye yazar.

## Meta-geliştirme (register_tool estetiği)

Yeni araç üretimi açıktır: `tools/<tool-id>.md` + `tools/<tool-id>.<ext>` yaz, `manifest.json`'a kaydet; `fireEmbed` ateşleme gömmesini seçer. Kayıtlı araç `toolkit/tool-registered` olayından itibaren bu kılavuzun araçlarıyla aynı biçimde iş görür.