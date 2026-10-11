# Win32 Bellek Motoru — Set Kılavuzu (`win32-memory`)

## Set tanımı

Win32 kullanıcı uzayı bellek / gözlem / girdi motoru. Tek bir native motora (`win32-memory-engine`) binen beş araç: süreç belleği okuma, kapsam-onay kontrollü yazma, AOB desen tarama, Direct HWND eşleme ve ham scan-code girdi. Sıcak döngüler kalıcı OS thread'leri + kanallarla yürür; arayüz tek satır JSON IPC'dir.

## Yetenek kümesi ve yetki

- `capabilitySet`: `hardware-control`
- Set yetkisi: `kernel` — üyelerin en yükseği.
- Kademe BİLGİdir, kapı değil: her aracın yetkisi neye dokunduğunu tanımlar.

| Araç | Yetki |
| --- | --- |
| `readvm` | `kernel` |
| `writevm` | `kernel` |
| `aobscan` | `kernel` |
| `hwndmap` | `observe` |
| `scancode` | `input` |

## Setteki araçların görevi

- **`readvm`** — PID + sanal adres aralığını okur. Blok okumanın yanında tip kod çözme (u8…u64, i32/i64, f32/f64, pointer) ve `taban+offset₁+offset₂+…` biçimindeki pointer zinciri çözümü içerir.
- **`writevm`** — Sanal adres aralığına yazar. Yazım yalnız `MemoryActuator` üzerinden yapılır; önce yazım kapsamı (`scope_allow` aralıkları), sonra çağrı-başı onay kancası geçilmelidir. Kanca yoksa ya da ret verirse yazım olmaz (`E_REJECTED`).
- **`aobscan`** — Wildcard'lı byte desenini (`48 8B ?? 90`) modül aralığı ya da serbest VA aralığı içinde parçalı taramayla arar; parça sınırında örtüşme ile eksiksiz eşleşme üretir.
- **`hwndmap`** — Sürece ait pencereleri doğrudan HWND eşlemesiyle çıkarır: sınıf, başlık, geometri, sahiplik, görünürlük. Kirli-damga + TTL önbelleği ile tazeleme maliyetini düşürür.
- **`scancode`** — Ham scan-code klavye/fare girdisini `SendInput` ile enjekte eder. Adanan bir OS thread üzerinde yürür; bas/bırak zamanlaması önceden planlanır (deterministik zamanlama planlayıcı).

Her aracın ayrıntılı tanımı `tools/<tool-id>.md` dosyasındadır; ateşlemede gömülen ham kod `tools/<tool-id>.<ext>` dosyasıdır.

## Kullanım örüntüleri

1. **Keşif → sabitleme**: `modules` + `hwndmap` ile hedefi konumla → `aobscan` ile kod içinde kararlı bir imza bul → işaretçiyle erişilen değişkenlerin tabanını pointer zinciriyle (`readvm`) izle → canlı değeri düzenle oku.
2. **Yazım döngüsü**: `scope_allow` ile yazılabilir aralıkları tanımla → onay kancasını kur → `actuate` ile yaz → `readvm` ile geri okuyarak teyit et.
3. **Girdi akışı**: `ui_attach` ile pencere durumunu eşle → `send_scancode` ile planlanmış tuş/fare akışı gönder; UIPI gereği girdi, motor ve hedef aynı bütünlük seviyesindeyken hedefe ulaşır (ulaşmama hedef tarafında sessizce olur; motor bunu raporlayamaz).
4. **Durum yoklaması**: `status` hedefin yerleştiği yeteneği bildirir — `MEMORY_ALLOWED` → `INPUT_ONLY` → `VISION_ONLY` → `REFUSED`. Merdiven yalnız aşağı iner; erişim kaybı üst yeteneğe sıçramaz. `OpenProcess` reddi korumalı süreç işaretçisi taşır (`TargetClass`).

## IPC biçimi

Her çağrı tek satır JSON ister, tek satır JSON üretir:

- İstek: `{"cmd": "<cmd>", ...}`
- Yanıt: `{"ok": true, "data": ...}` ya da `{"ok": false, "error": {"code", "detail", "win32"}}`

Komutlar: `attach`, `detach`, `modules`, `observe`, `unobserve`, `read`, `peek`, `poll`, `status`, `scope_allow`, `scope_clear`, `actuate`, `send_scancode`, `ui_attach`, `ui_detach`, `enable_debug_privilege`.

Mekanik notlar: bellek erişimi `SeDebugPrivilege` etkinleştirilmiş (yükseltilmiş) token gerektirir — `enable_debug_privilege` sonucu dürüstçe raporlar (`enabled: false` + `ERROR_NOT_ALL_ASSIGNED` dahil). Yazım onayı yalnız `wme_set_confirm_hook` ile kurulan kanat `1` döndüğünde geçer.

## Meta-geliştirme (register_tool estetiği)

Set içinde yeni araç üretimi açıktır: yeni bir araç `tools/<tool-id>.md` (tanım + yetki + giriş/çıkış) + `tools/<tool-id>.<ext>` (ham kod bloğu) olarak yazılır, `manifest.json`'a kaydedilir; ateşleme gömmesi `fireEmbed` alanı ile seçilir. Kayıtlı araç `toolkit/tool-registered` olayından itibaren bu kılavuzun araçları ile aynı biçimde iş görür (`toolkit/loaded` okuması dahil).