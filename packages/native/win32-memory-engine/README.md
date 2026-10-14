# win32-memory-engine

English | [中文](README.zh.md)

Win32 bellek/gözlem/girdi motoru. `packages/host/win32-memory-bridge` için düz C-ABI + JSON satır IPC çekirdeği: `observer` (OpenProcess + ReadProcessMemory + AOB + pointer zinciri), `writer` (WriteProcessMemory, yalnız `MemoryActuator` üzerinden, çağrı-başı onay kancası), `hwnd` (Direct HWND Mapping + UI cache), `input` (ham Scan Code `SendInput`, adanmış OS thread), `policy` (yetenek yoklaması + düşüş merdiveni), `lib` (FFI yüzeyi).

Sıcak döngüler hiçbir zaman async yürütücüye girmez; kalıcı OS thread'ler + kanallar kullanılır (`tokio` yok).

## Yetenek yoklaması ve düşüş merdiveni

Her hedef, yalnız ölçüm sonuçlarına göre bir yeteneğe yerleşir (`policy.rs`):

| Yetenek | Kanıt | İzin verilen |
| --- | --- | --- |
| `MEMORY_ALLOWED` | `OpenProcess(VM_READ\|QUERY_INFORMATION)` başarılı | bellek okuma/yazma denemesi + girdi + UI |
| `INPUT_ONLY` | VM kapalı, hedefe ait görünür HWND var | ham scan-code girdi + UI |
| `VISION_ONLY` | VM kapalı, HWND yok, süreç yaşıyor (`QUERY_LIMITED`) | yalnız dışarıdan görüntüleme + UI kaydı |
| `REFUSED` | süreç yok (`Gone`) | süreç bulunamadı hatası |

Merdiven yalnız aşağı iner; erişim kaybı bir üst yeteneğe sıçramaz. `OpenProcess` reddi `ERROR_ACCESS_DENIED` ise motor süreç korumasını yoklar (`GetProcessInformation` / `ProcessProtectionLevelInfo`) ve sonucu `TargetClass`'a yazar: `Normal`, `ProtectedProcessLight` (PPL), `ProtectedProcess`, `ProtectedUnknown`, `Gone`. Yutma yok: her yoklama `ProbeAttempt` olarak raporda durur, retler şifreli hatayla (`E_PROTECTED_TARGET`, `E_NOT_FOUND`, `E_ACCESS_DENIED`) döner. Koruma etiketi (`TargetClass`) BİLGİDİR, engel değildir: PPL/ProtectedProcess/anti-cheat hedefler de dahil her hedefte her erişim vektörü denenir; her yoklama `ProbeAttempt` olarak rapora yazılır, yalnızca işletim sisteminin fiilen reddettiği çağrı `denied` olarak raporlanır. Yedek/denetim dışı vektör denenmesi zorunludur; önden vazgeçiş yoktur.

## SeDebugPrivilege ve yükseltilmiş başlatma

`wme_enable_debug_privilege` (ya da `enable_debug_privilege` komutu) çağrışı `AdjustTokenPrivileges` ile `SeDebugPrivilege` etkinleştirir ve sonucu dürüstçe raporlar (ayrıcalık verilmediyse `enabled: false`, `ERROR_NOT_ALL_ASSIGNED` açıklamasıyla).

Not: `SeDebugPrivilege` yalnız ayrıcalığın tanındığı bir token'da etkinleşir; pratikte motorun **yükseltilmiş (administrator)** başlatılması gerekir. Yükseltilmemiş bir motorda yardımcı sessizce başarı göstermez, `enabled: false` döner.

## UIPI kapsamı

Ham scan-code girdisi `SendInput` ile sisteme enjekte edilir; UIPI gereği **elevated bir hedef pencereye girdi ancak motor da elevated ise ulaşır**. Motor yükseltilmemişken elevated hedefe gönderilen girişler işletim sistemi tarafından sessizce atılır — motor bunu raporlayamaz (çünkü atma hedef tarafında olur). Kullanım kuralı: hedef elevated ise motoru da elevated başlat.

## Destek notu

- **Wow64 (32-bit hedef) pointer genişliği**: `observe` üzerinde `pointer_width: 4|8` ile desteklenir; 4-byte zincirler ayrı süreç doğrulaması gerektirir, karışık mod senaryoları desteklenmez.

Katman ayrımı: `win32-kernel-bridge` IOCTL erişimi motor politikasından bağımsızdır; köprü her hedefte tüm vektörleri (handle, `MmCopyVirtualMemory`, sınıf girdisi) dener ve sonucu ham raporlar. Politika bir izin kapısı değil, ölçüm cetvelidir.

## FFI yüzeyi (JSON satır IPC)

Her çağrı tek satır JSON ister, tek satır JSON yanıt (`{"ok":true,"data":…}` ya da `{"ok":false,"error":{"code","detail","win32"}}`) üretir.

- `wme_request(line) -> char*` — satır istek (`{"cmd":"attach|detach|modules|observe|unobserve|read|peek|poll|status|scope_allow|scope_clear|actuate|send_scancode|ui_attach|ui_detach|enable_debug_privilege", …}`).
- `wme_reply_free(ptr)` — `wme_request` çıktısını serbest bırakır.
- `wme_set_confirm_hook(cb, ctx)` — yazım onay kancası; `actuate` yalnız kancadan `1` (onay) dönerse yazar. Kanca yoksa tüm yazım `E_REJECTED` ile reddedilir.
- `wme_enable_debug_privilege() -> char*` — `SeDebugPrivilege` etkinleştirme raporu (JSON satır).
- `wme_version() -> char*` — statik sürüm dizesi (serbest bırakılmaz).

## Testler

`cargo test` saf çözücüleri mock bellek yığınıyla çalıştırır: AOB ayrıştırma/tarama (chunk sınırı dahil), pointer zinciri (4/8 bayt), değer kod çözme, yazım kapsamı + onay kancası mantığı, UI kirli-damga/TTL, girdi zamanlaması planlama, JSON istek ayrıştırma. Win32 sınır çağrıları yalnız ince sarmalayıcılarda `unsafe`; sınanabilir mantık `ByteSource`/`ByteSink` arkasında saf.
