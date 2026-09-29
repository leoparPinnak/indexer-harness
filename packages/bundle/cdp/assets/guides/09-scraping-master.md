# Web Kazıma Ustalığı — Mevcut Araç Setinin Tam Kullanım Kılavuzu

Bu rehber, `packages/bundle/cdp/src/tools.ts` içinde kayıtlı **39 aracın tamamını**
(%100) bir veri kazıma işinde nasıl kullanacağını anlatır. Her bölüm **ölçülmüş**
bir kanıta dayanır: kılavuzdaki sayıların, hata metinlerinin ve reçetelerin
tamamı canlı `cdp_*` çağrılarıyla doğrulanmıştır — kanıt kaydı ve
**doğrulanmayan iddialar** için [§4.10](#410-kanıt-kaydı-ve-doğrulanmayan-iddialar).

Ana SKILL.md §2 zorunlu prosedürü ve §3 karar tablosunu **bölümlemez**; o ikisi
her sayfa işi için zaten geçerlidir. Bu rehber, o ikisinin cevaplamadığı soruya
yanıt verir: *"Veriyi alacakken hangi aracı, hangi parametreyle, hangi sırayla
kullanırım ve aldığımın gerçekten tam olduğunu nasıl anlarım?"*

> **Bu rehberi ne zaman yükle.** Bir kazıma işi (veri toplama, tablo/liste
> çıkarma, sayfalama, giriş duvarı arkasından okuma, PDF/indirme toplama)
> başlayacağın an. Tek bir tıklama veya tek bir form doldurma için **gerekmez** —
> o işler ana SKILL.md §2 + §3'e sığar.

---

## İçindekiler

1. [§1 Kapsam](#1-kapsam-ne-zaman-uygulanır-ne-zaman-uygulanmaz)
2. [§2 Araç envanteri](#2-arac-envanteri--38-aracın-tamamı)
3. [§3 Kanıtla öğrenilmiş kurallar](#3-kanıtla-öğrenilmiş-kurallar)
4. [§4 Reçeteler](#4-reçeteler)
5. [§4.10 Kanıt kaydı ve doğrulanmayan iddialar](#410-kanıt-kaydı-ve-doğrulanmayan-iddialar)
6. [§5 Karar ağacı](#5-karar-ağacı--hangi-durumdaysan-hangi-araçı)
7. [§6 Sık yapılan hatalar](#6-sık-yapılan-hatalar)
8. [§7 Kısa kontrol listesi](#7-kısa-kontrol-listesi)

## 1. Kapsam: ne zaman uygulanır, ne zaman uygulanmaz

### 1.1 Uygulanır

- Bir sayfadaki **tekrar eden yapıyı** (tablo satırı, liste öğesi, kart, ürün)
  kayıt kümesine dönüştürmek.
- **Sayfalanmış** bir katalogda birden çok sayfayı sırayla dolaşmak.
- Bir sayfanın verisini **API'den** okumak (`net_capture` → gözle doğrula).
- Giriş gerektiren bir sayfada, kullanıcının **kendi tarayıcısında açtığı**
  kalıcı oturumdan okumak.
- Rapor/tablo biçimindeki bir dokümanı toplamak (`cdp_printpdf`,
  `cdp_readpdf`, `cdp_pdftotext`).

### 1.2 Uygulanmaz — ve neden

- **Sitenin uyguladığı rate limit'i, ban'ı veya hesap kısıtlamasını atlatmak.**
  Aksine: dur ve kullanıcıya bildir (§4.7).

- **Sıfır toleranslı hız kazımı (aggressive scraping).** Bu araç seti bir
  insan gibi davranır; insan gibi hızlı da davranmaz. `cdp_wait({strategy:
  'network-idle'})` beklemesi bir güvenlik değil, bir doğruluk gereğidir.

- **Üçüncü taraf sitelerdeki özel eylemler** (satın alma, gönderi, silme).
  Kazıma *okuma* işidir; yazan her mutasyon ana SKILL.md §2.6 doğrulamasına tabidir.

### Layer C: doğrulama araçlarının rolleri

| Araç | Rol |
|---|---|
| `cdp_captcha({action:'scan'})` | Doğrulama meydan okumalarını sınıflandırır: adaylar, tuzaklar, `thirdParty.verdict` |
| `cdp_captcha({action:'drag'})` | Sayfanın kendi slider'ını gerçek CDP girdisiyle sürer ve sonucu geri okur |
| `cdp_stealth` | `navigator`/başlık/launch katmanını tutarlı hale getirir |
| `cdp_fingerprint` | "Sayfa beni neden reddeder?" diye teşhis koyar (severity/layer/evidence) |

`thirdParty.verdict: 'third-party-present'` gelirse: adayların yanında raporla,
taramaya devam et. Sonucu SKILL.md §2.7 adımıyla kullanıcıya ilet.

---

## 2. ARAÇ ENVANTERİ — 38 aracın tamamı

`tools.ts` içinde kayıtlı toplam **39** araç vardır: **37 `cdp_*` + 2 `net_*`**
(`net_capture` #10, `net_export` #11). Kaynak sıra numaraları aşağıda verilmiştir.

> **Sayım denetimi (plan17-skillweb ile yeniden ölçüldü).** Bu bölümdeki
> envanter, `tools.ts` içindeki `// 1.` … `// 39.` kayıt satırlarından **programatik
> olarak** türetildi ve `docs/tool-catalog.md` ile çapraz doğrulandı: 39 kaydın
> **39'u da** katalogda bir şema bölümü olarak duruyor. `cdp_locate` **#36**'dır ve
> **kayıtlıdır**; canlı oturumda 39 aracın tamamı görünür.
>
> Bu not, daha önce burada yazan iki bayat iddiayı **düzeltir**: (a) "`cdp_locate`
> çalışan derlemede kayıtlı değil" — **yanlış**, kayıtlı; (b) "`src/index.ts:110`
> sayım hatası" — o satır **plan09-fix ile zaten düzeltilmiş**, bugün
> *"39 tools in all — 37 `cdp_*` plus `net_capture` and `net_export`"* diyor
> ([§4.10](#410-kanıt-kaydı-ve-doğrulanmayan-iddialar)).
>
> **Kural:** bu envanterdeki hiçbir sayıya güvenme — `tools.ts`'i oku ya da
> `cdp_status`'a bak. Aşağıdaki alıntılar bir **tarih kaydıdır**, bir sözleşme değil.

### 2.1 Bağlantı ve hedef yönetimi

#### `cdp_status` (#1) — Tarayıcı canlı mı?
- **Ne zaman:** Her kazıma turunun **en başında**, ve bir şey tutmazsa tekrar.
- **Parametre:** yok.
- **Çıktı:** sürüm, hedef sayısı, `proxy.active`, canlı viewport, aktif targetId.
- **Hata okuması:** `targets: 0` / bağlantı yok → `cdp_open` önce.
- **NE ZAMAN KULLANMA:** Her araç çağrısından önce. Tek seferlik "toplu kontrol"
  değildir; tur ortasında da geçerlidir.

#### `cdp_open` (#2) — Tarayıcı bağlan / başlat
- **Ne zaman:** Uygulanabilir bir tarayıcı yoksa. Kalıcı oturum gerekiyorsa
  `profile` ile (§4.5).
- **Parametreler:** `port` (çalışan bir hata ayıklama tarayıcısı), `headless`,
  `executablePath`, `endpoint` (açık `ws://` → keşif/başlatma atlanır),
  `switchTo` (keşif tablosundan seçilen port), **`profile`** (kalıcı profil adı).
- **Kritik davranış:** Parametresiz çağrıldığında **önce** varsayılan loopback
  portlarını tarar; canlı bir tarayıcı bulursa `needsChoice` döndürür ve **hiçbir
  şeye bağlanmaz** — seçimi kullanıcı yapar.
- **Hata okuması:** `needsChoice:true` → `choices` tablosunu oku, kullanıcıya
  sor, `switchTo`/`endpoint`/`profile` ile tekrar çağır. `reason` alanı
  "hiçbir şey yapmadım" gerekçesini taşır.
- **NE ZAMAN KULLANMA:** Her turda. Bağlantı slotu tektir; ikinci bir endpoint
  açmak ilk bağlantıyı **koparır**.

#### `cdp_endpoints` (#28) — Hangi port gerçekten açık?
- **Ne zaman:** "`cdp_*` çağrıları tarayıcıyı göremiyor" sendromu. Bu tam olarak
  "tarayıcı var ama ben göremiyorum" tanısıdır.
- **Parametreler:** `ports` (virgüllü CSV), `timeoutMs` (varsayılan 500).
- **Çıktı:** port başına `state` ∈ `unreachable|unattached|connected|degraded|
  reattaching|closed` + `browser`, `targets`, `error`.
- **NE ZAMAN KULLANMA:** `cdp_status` "bağlı" dediğinde ama araçlar yanıt vermiyorsa.

#### `cdp_tabs` (#3) — Sekmeleri listele, hedef seç
- **Ne zaman:** Her tur başında. `targetId`'yi bir kez seç ve **her** çağrıda geçir.
- **Parametreler:** `refresh` (varsayılan `true`), `query` (başlık/URL alt metni),
  `type`.
- **Çıktı:** `targetId|title|url` listesi, `activeTargetId`, `stale`.
- **Hata okuması:** Boş liste → sayfa yok; `cdp_open` ya da kullanıcıdan izin al.
- **NE ZAMAN KULLANMA:** `targetId`'yi hiç vermeden çalışma. Parametre her yerde
  opsiyoneldir ve **sessizce aktif sekmeye düşer** — mutasyon için bu bir tuzaktır.

#### `cdp_tab_new` (#20) / `cdp_tab_focus` (#22) / `cdp_tab_close` (#21) — Sekme yaşam döngüsü
- **Parametreler:** **`cdp_tab_new`** `{ url, focus }` — `focus` varsayılan `true`.
  **`cdp_tab_focus`** `{ targetId (zorunlu), activateBrowser }` — `activateBrowser`
  varsayılan `true`. **`cdp_tab_close`** `{ targetId, force, confirmActive }`.
- **`cdp_tab_new`** — Kazımada **kendi sekmeni aç ve `focus:false`**.
  Bu, kullanıcının 21 sekmesi varken yanlış sekmeye yazmayı fiziksel olarak
  imkânsız kılar. *(Bu kılavuzun tüm testleri `focus:false` ile yapıldı.)*
  Ardından `cdp_tabs` ile yeni `targetId`'yi al ve **sabitle**.
- **`cdp_tab_focus`** — Hedefi aktifleştir; `targetId` verilmeden verilen her
  çağrıyı açar. Gizli sekmede `cdp_exec` zaman aşımına uğur (Kural 6).
- **`cdp_tab_close`** — Aktif sekmeyi kapatmak için açık `targetId` (veya
  `confirmActive:true`), son sekmeyi kapatmak için `force:true` ister.
  Bunlar **güvenlik raylarıdır**, etrafından dolaşılmaz.
- **Hata okuması:** Bilinmeyen bir `mode`/`action` gibi **throw** eden bir araç
  değildir; reddediş `ok:false` + `reason` ile gelir. `cdp_tab_close` koruması
  bir hatadan çok **kural ihlali bildirisi**dir.
- **NE ZAMAN KULLANMA:** `cdp_tab_close` — kazıma bittikten sonra kendi
  sekmeni kapatmak dışında bir iş için.

#### `cdp_contexts` (#29) — İzole tarayıcı bağlamı
- **Ne zaman:** Temiz çerez istiyorsan (oturum bulaşması olmasın) veya kullanıcının
  oturumunu **bozmadan** test yapacaksan.
- **Parametreler:** `action` = `list|create|open|dispose`, `contextId`, `url`.
- **Çıktı:** `contexts` (+ yeni `targetId`).
- **Hata okuması:** Bilinmeyen action veya eksik `url` → **throw**.
- **NE ZAMAN KULLANMA:** Oturum gerektiren kazımada — izole bağlamda oturum
  olmaz.

### 2.2 Okuma ve çıkarma — kazımanın omurgası

#### `cdp_lock` (#37) / `cdp_unlock` (#38) — Paralel yazarlar için sekme kilidi

- **Parametreler:** **`cdp_lock`** `{ targetId, holder, ttlMs }` — `holder` yazanın
  kimliği (ör. subagent id), `ttlMs` 1000..300000'e kırpılır (varsayılan 60000).
  **`cdp_unlock`** `{ lockId, holder }` — `holder` verilirse sahibiyle eşleşmeli.
- İki paralel yazar aynı sekmeye giriyorsa (paralel subagent'lar, eşzamanlı
  kancalar), önce `cdp_lock` al: **kilidi beklemek, girdileri karıştırmaktan
  iyidir.** Kilit `lockId` + `lockedUntil` döner; TTL'siz kilit kalamaz — zaman
  aşımında kendiliğinden ölür, kimse kurtarmak zorunda kalmaz.
- **Hata imzası:** `cdp_lock` doluyken `ok:false` + `reason: 'lock-held'` döner
  (kilit hatası değil, bant içi veri): `holder` ve `lockedUntil` sahibi bildirir,
  sıraya gir. `cdp_unlock` yanlış sahipte `not-holder`, bilinmeyen/çift açılışta
  `unknown-lock` — **her ikisi de veri, hata değil.**

#### `cdp_profiles` (#39) — Profil envanteri ve yaşam döngüsü

- **Parametreler:** `{ action, profile }` — `action: 'list'` (varsayılan) her
  adlandırılmış profili dürüst kilit raporuyla (`locked`, `artifacts`, `pid`) ve
  aktif profil kimliğiyle listeler; `action: 'stop'` canlı oturumu bitirir
  (`profile` verilmezse aktif olan durdurulur).
- Profil **asla silinmez** — kalıcı oturum budur. `stop` yalnızca bu servisin
  başlattığı tarayıcı process'ini öldürür; dışarıdan bağlanılan bir tarayıcıda
  yalnızca bağlantıyı kapatır ve farkı `note`'da söyler. Kilit durumu diskteki
  kanıt artıklarından okunur, **asla tahmin edilmez**.
- **Hata imzası:** `stop` aktif olmayan bir profilde `ok:false` + `reason` ile
  reddedilir ("is not the active profile"); canlı oturum yoksa `no live session
  to stop`. İkisi de **bant içi veri**, throw değil.

#### `cdp_navigate` (#4) — URL'ye git
- **Parametreler:** `url` (zorunlu), `targetId`, `timeoutMs`.
- **Hata okuması:** Yanlış sayfa açıldı → **yanlış hedefe gitmişsin**; ana
  SKILL.md §2'yi baştan çalıştır. Hiçbir koşulda "nereye düştüyse oradan devam et".
- **NE ZAMAN KULLANMA:** `file://` ve `about:blank`'a SPA yönlendirmesi beklerken.

#### `cdp_wait` (#9) — Bekle
- **Parametreler:** `strategy` ∈ **`css`(varsayılan) | `aria-label` | `text` |
  `visible` | `network-idle` | `navigation` | `url`**, `selector`, `text`,
  `textMatch` (`exact|contains`), `url` (regex), `idleMs` (varsayılan **500**),
  `timeoutMs` (varsayılan **10 000**).
- **Ölçülen sabitler:** `WAIT_DEFAULT_TIMEOUT_MS = 10_000`,
  `WAIT_DEFAULT_IDLE_MS = 500`, `WAIT_URL_POLL_MS = 100`.
- **Kritik kural — `presence ≠ visibility`:** Bir `display:none` düğüm `css`
  stratejisinden **geçer**. "Kullanılabilir mi?" sorusuna `visible` ile cevap ver.
- **Kritik kural — `network-idle` ≠ `network-idle`:** Sessiz pencere 500 ms'dir.
  Sürekli akan bir sayfada (polling, reklam) hiçbir zaman "idle" olmaz ve
  bekleme zaman aşımına düşer. Bu durumda `strategy:'visible'` kullan.
- **Hata okuması:** Zaman aşımı **throw değil**, bant içi `ok:false` + `reason`'dir.
  Bu bir araç hatası değil, bir cevaptır.
- **NE ZAMAN KULLANMA:** `cdp_sleep` gibi tahmini bekleme yoktur. "Bir saniye
  bekledim, belirmiş" mantığı kazımada **her zaman** sessiz veri kaybıdır.

#### `cdp_snapshot` (#5) — Örgülenmiş DOM anlık görüntüsü
- **Parametreler:** `targetId`, `ref` (bu çağrıda doğrulanacak ref).
- **Çıktı:** `@ref [role] name` düğümleri + kutu; `ref` verildiyse
  `staleRef`, `refRect`, `refNote` (`ref-target-renamed`).
- **Kritik kural — ref adı değişebilir, node id değişmez:** Bir SPA satır
  yeniden adlandırdığında `refNote: "ref-target-renamed"` gelir: eleman **node
  id ile bulundu** ve tıklama/yazma yine ona gitti. Bu bir hata değil, ref'in
  ad kısmının değiştiğine dair dürüst bilgidir.
- **NE ZAMAN KULLANMA:** Yapısal keşif için. **Döngü içinde her turda
  `cdp_snapshot` çağırma** — her satır için pahalıdır; `cdp_extract` zaten taze
  belge indeksi kullanır.

#### `cdp_eval` (#6) — Sınırlı JavaScript okuması
- **Parametreler:** `expression` (zorunlu, **bir değer döndürmek zorunda**),
  `targetId`.
- **Ölçülen sert bütçe:** `MAX_EVALUATE_CHARS = 16_384`. **51 781 karakterlik**
  bir JSON döndürmek denendi → sonuç tam 16 384'te kesildi ve cevap
  **`(truncated)`** ile işaretlendi. `cdp_eval` sessizce **eksik veri vermez**:
  kesmeyi her zaman söyler.
- **Hata okuması:** Boş sonuç → ifade **sessizce yutulmuş exception**'dır.
  `try{…}catch(e){return 'ERR:'+e.message}` ile sarmala. Sonuç 16 KiB'yi
  aşıyorsa `truncated` görürsün.
- **NE ZAMAN KULLANMA:** Kanıtlanmış etki istiyorsan `cdp_exec` (§2.2). Büyük
  veri döndürmek için — 16 KiB bunun için tasarlanmamış; `cdp_extract` +
  sayfalama kullan.

#### `cdp_exec` (#19) — Çalıştır **ve etkisini kanıtla**
- **Parametreler:** `expression` (zorunlu), `targetId`, `awaitPromise`,
  **`postCondition`** (script'ten sonra değerlendirilir, **doğru olmalıdır**),
  `timeoutMs` (varsayılan **15 000**, maks. **60 000**).
- **Çıktı:** `ok` + `didAct` + `result` + `postCondition.passed`. Asla throw etmez.
- **Kazımadaki kritik kullanım — hücre bazlı tablo:** `cdp_extract` bir `<tr>`ye
  `text` uyguladığında **tüm satırı tabla ile birleştirir** (§3, Kural 2). Hücre
  bazlı kayıt nesnesi istiyorsan `cdp_exec` + `postCondition` kullan.
- **NE ZAMAN KULLANMA:** Sadece bir değeri okumak için. Kanıt istemiyorsan
  `cdp_eval` daha hafiftir.

#### `cdp_find` (#31) — Aday bul ve **eyleme uygunluğunu kanıtla**
- **Parametreler — DİKKAT:** Buradaki **birincil** ad `selector`'dır, ama araç
  `css` **takma adını da** kabul eder (`selector`'un alias'ı). Diğer araçlarda
  tersi geçerlidir: `cdp_click`/`cdp_text`/`cdp_expect`/`cdp_fill` yalnız `css`
  alır. Ayrıca `ref`, `ariaLabel`, `role`, `text`, `scope`, `nth`, `timeoutMs`.
  *Kural:* `cdp_find`'de `selector` yaz, geri kalanında `css`.
- **Çıktı:** `matched` (toplam), seçilen adayın `ref`/`name`/`rawName`/kutusu,
  `actionability` (`visible`/`inViewport`/`coveredBy`), `candidates` (**en fazla 5**,
  `src/locator.ts:423` `MAX_REPORT = 5` — kırpması 5'tir, 5'ten fazlasını
  **göremezsin**; belirsizlikte `nth` ile daralt), `warnings`, `reason`.
- **Hata okuması:** `matched: 0` → `ok:false` + `reason`; "eşleşme yok"tur, sessiz
  başarı değildir. Yazım: `No match (matched=0): pass at least one of ref, selector, …`.
- **Eyleme uygunluk hatası değildir:** `— NOT actionable: outside the viewport;
  covered by h2.` — bu bir **bulgu**dur; ne yapacağını söyler.
- **NE ZAMAN KULLANMA:** Bir `<tr>` grubunun kaç olduğunu bilmek istiyorsan —
  `cdp_extract` + `count` aynı işi daha ucuza ve bütçeyle yapar (§3, Kural 1).

#### `cdp_extract` (#32) — **Yapılandırılmış veri projeksiyonu**
Kazımanın birincil aracı. Tam sözleşme §3 ve §4'te.

- **Parametreler:** `spec` (JSON string, zorunlu), `targetId`, `timeoutMs`.
- **Kritik — kırık spec tarayıcıya hiç uğramaz:** Bilinmeyen `kind`, bilinmeyen
  alan kaynağı ve bozuk regex, protokol çağrısından önce `ok:false + error`
  olarak döner. *Ölçülen:* `{"kind":"list","fields":{"hatali":"kaynakYok"}}` →
  `cdp_extract: field 'hatali' has unknown source 'kaynakYok'` — sayfa hiç
  okunmadı.
- **NE ZAMAN KULLANMA:** Hücre bazlı satır nesnesi istiyorsan (§3, Kural 2).

#### `cdp_text` (#26) — Tek bir öğenin görünen metni
- **Parametreler:** locator merdiveni (`css` > `aria-label` > `role`+`name` >
  `text`), `textMatch`, `nth`, `scope`, `ref`, `maxChars` (varsayılan 2000, maks. 4000).
- **Hata okuması:** Bulunamadı/belirsiz/gizli → `ok:false` + `reason` +
  `candidates`. **Başarısız okuma bir hatadır, veridir** — adayları oku, sonra
  yeniden sorgula.
- **NE ZAMAN KULLANMA:** Tek bir doğrulama metni okumak yerine `cdp_expect` kullan.

#### `cdp_expect` (#27) — Durum doğrula (mutasyonun doğrulama adımı)
- **Parametreler:** `check` ∈ `exists|visible|enabled|textEquals|textContains|urlMatches`,
  `expected`, locator merdiveni, `ref`, `timeoutMs` (0 = tek deneme).
- **Kritik — başarısız assertion hata değildir:** Bant içi `ok:false` + `reason`.
  Bu yüzden `cdp_expect` doğrulamanın **en ucuz** yoludur; ikinci bir `cdp_eval`
  yazmaya gerek yoktur.
- **Ölçülen kanıt (kazıma döngüsü):** Son sayfadaki "Sonraki sayfa" düğmesi
  `cdp_expect({check:'enabled'})` ile **PASS** verdi, `cdp_click` `ok:true`
  döndü, ve yine de veri **ilerlemedi**. Yalnızca metin okuması bunu yakaladı.
- **NE ZAMAN KULLANMA:** `check:'enabled'`'ı bir "daha veri var mı" sinyali
  olarak kullanma — **ölçülmüş olarak güvenilmez** (bkz. yukarıdaki kanıt).

### 2.3 Girdi ve etkileşim

#### `cdp_click` (#7) — Onaylı tek aktivasyon
- **Parametreler:** `x`/`y` **ya da** locator (`ref`, **`css`**, `ariaLabel`,
  `role`+`name`, `text`, `textMatch`, `nth`, `scope`). Locator parametresi
  verildiğinde `x`/`y` **reddedilir** — bir çağrıda tek adresleme modu.
- **Çıktı:** `resolvedBy` (`explicit|active|single-page|created|ref`), `mode`
  (`coordinates|locator`), `ref`, `staleRef`, `refNote`, `reason`.
- **Hata okuması:** `Click dispatched successfully.` **hiçbir şeyi kanıtlamaz**.
  Kazıma döngüsünde zorunlu olarak bir `cdp_expect`/`cdp_extract` geri okuması
  takip eder. Kaynaktaki birebir reddetme satırları:
  `pass either ref or a locator, not both` ·
  `pass either coordinates or a locator, not both` ·
  `out-of-bounds coordinate (<W>×<H> viewport, got <x>,<y>)` ·
  `click not delivered: no click event reached the page (target hidden or in the
  background?) — activate the tab with cdp_tab_focus and retry`.
  Kazımada en sık görüleni sonuncusudur: **pasif sekmede** tıklamadan düşer.
- **NE ZAMAN KULLANMA:** Gizli (`display:none`) veya örtülü hedefte — orada
  locator çözümlemesi zaten reddedilir; kaydır ya da örtüyü kaldır.

#### `cdp_type` (#8) — Odaklanmış alana tuş vuruşları
- **Parametreler:** `text` (zorunlu), `ref` (tıklar ve odaklar), `targetId`.
- **Hata okuması:** `Typed N characters.` **atılan metni kanıtlamaz**. Geri
  okuma 0 karakter gösteriyorsa odak yanlış ya da kontrollü input yutmuş.
  Kaynaktaki odak kapısı: `focus lost — <document.activeElement is <tag "name">>,
  so nothing was typed. Click the field with cdp_click first, then type again`.
  Bu mesaj gelirse `cdp_type` **hiçbir şey yazmadı** — `Typed N characters.`
  yazmış olsa bile.
- **Ölçülen davranış:** Türkçe karakterli 13 karakterlik metin (`ŞİÖÇÜĞÜşığöçü`)
  eksiksiz yazıldı. `cdp_type` **mevcut içeriğin sonuna ekler**, değiştirmez —
  alanı temizlemek istiyorsan `cdp_fill(clear:true)` kullan.
- **NE ZAMAN KULLANMA:** Kazımada neredeyse hiç. Login formlarında
  **`cdp_fill` kullan** (§4.5) — yazma + geri okuma tek çağrıda.

#### `cdp_fill` (#30) — Form alanı doldur **ve doğrula**
- **Parametreler:** locator merdiveni, `value` (zorunlu), `clear` (varsayılan
  `true`), `verify` (varsayılan `true`), `timeoutMs` (varsayılan 5000, maks. 30000).
- **Çıktı:** uygulanan değer + geri okuma, `fallbackUsed`.
  Başarı biçimi: `Filled <input#v11-name "Ad (gerçek alan)"> with "Ayşe Yılmaz"
  (strategy=css, matched=1); verified: value matches.`
- **Ölçülen tuzak — "not actionable" çoğu zaman viewport'tur:**
  `FAILED to fill <input#v11-name …>: not actionable: outside viewport: element is
  scrolled out of view; hit-target blocked: topmost element at center is unknown
  (timed out after 5136ms)`. Düzeltmesi tek hamledir: `cdp_scroll({mode:'selector',
  selector:'#v11-name'})` sonra aynı `cdp_fill` — *ölçüldü:* ikinci çağrı
  `verified: value matches` ile geçti.
- **Kazımadaki rolü:** Giriş duvarının ardındaki veri. Doğal setter + `input`/
  `change` olayları React/Vue'yu atlatır; framework geri alırsa odaklı
  `Input.insertText` fallback'i devreye girer ve `fallbackUsed:true` döner.
- **NE ZAMAN KULLANMA:** `verify:false` ile. Kazımada yazdığını doğrulamak
  istiyorsan bu bayrağı kapatma.

#### `cdp_upload` (#25) — Dosya input'una host dosyası bağla
- **Parametreler:** `files` (mutlak yol, maks. 10), `selector` **ya da**
  `chooser:true`, `timeoutMs` (500–30000).
- **Hata okuması:** `ok:false` + `error.code`; yollar izinli köklerin dışında
  reddedilir. Dosya input'ları `cdp_fill` ile **asla** yazılamaz.
- **NE ZAMAN KULLANMA:** Yalnızca indirme/görsel yükleme gerektiren işlerde.

#### `cdp_scroll` (#23) — Kaydır
- **Parametreler:** `mode` ∈ `wheel`(varsayılan) | `pagedown` | `pageup` | `top` |
  `bottom` | `anchor` | `selector`, `deltaY`, `deltaX`, `repetitions` (1–20),
  `settleMs` (0–2000), `targetId`.
- **Çıktı:** kaydırmadan **sonra ölçülen** `scrollY` + `atTop`/`atBottom`.
- **Kritik:** Dönen konum varsayımın değil **ölçümdür**. `cdp_find` `inViewport:false`
  dediyse bu, düzeltmesi `mode:'selector`'dır.
- **NE ZAMAN KULLANMA:** Sonsuz kaydırmalı (infinite-scroll) listelerde
  döngüyü sınırlamadan — her tur bir tur daha veri getirir ve derinlik sınırını
  deler (§4.6).

#### `cdp_dialog` (#24) — JS diyaloğu yanıtla
- **Parametreler:** **`action`** = `list`(varsayılan) · `accept` · `dismiss` ·
  `policy`; `targetId` (**birden çok bekleyen diyalog varsa zorunlu**), `promptText`
  (`accept` ile `prompt` yanıtı; yoksa diyaloğun kendi `defaultPrompt`'u),
  `policy` (`action:'policy'` için yeni otomatik yanıt: `none`|`accept`|`dismiss`).
- **Kritik — `action` verilmezse hiçbir şey cevaplanmaz:** Varsayılan `list` yalnız
  **gösterir**. Diyaloğu kapatmak için `action:'accept'` ya da `'dismiss'` **şart**.
- **Çıktı:** `pending` + `recent` + `policy` (uygulandıysa).
- **Kritik — bekleyen diyalog sayfa araçlarını kilitler:** Bekleyen bir diyalog
  varken sayfa kapsamlı araçlar `dialog-open` ile **reddedilir**. Kazımada
  `beforeunload` çıkarsa önce `cdp_dialog` ile cevap ver, sonra kazımaya dön.
- **NE ZAMAN KULLANMA:** `alert`/`confirm` yoksa hiç.

### 2.4 Görsel, PDF ve dosya

#### `cdp_screenshot` (#12) — Ekran görüntüsü
- **Parametreler:** `fullPage`, `clip {x,y,width,height,scale}`, `selector`,
  `format` (`png|jpeg`), `quality` (0–100), `saveTo`, `inline`, `inlineMaxBytes`
  (varsayılan ve maks. 65536), `rects`, `annotate`.
- **Çıktı:** `path` + piksel/CSS ölçüleri. **Asla throw etmez**, hata bant içidir.
- **Kazımadaki rolü:** `rects:true` (+`annotate:true`) bir koordinat efsanesi
  boyar — görsel kanıt toplama. Canvas/ikon/çizgi içeren sayfalarda DOM
  cevap vermiyorsa bu görsel döngüdür (`cdp_locate` → `cdp_click`).
- **NE ZAMAN KULLANMA:** Metin verisi çıkarmak için — `cdp_extract` her zaman
  daha küçük ve kesin.

#### `cdp_locate` (#36) — Bu noktada ne var?
- **Parametreler:** `x`, `y` (viewport CSS pikseli, zorunlu), `targetId`.
- **Çıktı:** `node` (`tag`/`id`/`classes`/`role`/`text`/`rect`/`interactive`/
  `coveredBy`/`ancestry`/`byBox`), `viewport`, ve `ok:false` iken `nearest`
  (mesafesiyle birlikte).
- **Durum notu (plan17-skillweb düzeltmesi):** Bu madde daha önce "çalışan
  derlemede kayıtlı değil" diye uyarıyordu. **Yanlıştı ve düzeltildi**: `cdp_locate`
  `tools.ts`'te **#36** olarak kayıtlıdır, `docs/tool-catalog.md`'de şemasıyla yer
  alır ve canlı oturumda kullanılabilir. Artık bir ön-koşul yoktur; **görsel döngünün
  doğal parçasıdır** (bkz. [10-skill-mimarisi.md](10-skill-mimarisi.md)).
- **NE ZAMAN KULLANMA:** `cdp_find` bir sorgu bulduğunda — o zaman soru vardır
  ve `cdp_find` zaten hit-test yapıyor. `cdp_locate`'ın işi **sorgusuz** noktadır.

#### `cdp_viewport` (#13) — Viewport oku/değiştir
- **Parametreler:** `width`+`height` (ikisi birlikte), `deviceScaleFactor`,
  `mobile`, `reset`.
- **Çıktı:** `viewport`, `source` (`applied|report`), `resizeEvent.delivered`,
  `appliedViewport`.
- **Kritik — "mobilde gizli" sütunları yakala:** Emülasyon, masaüstündeki
  "mobilde gizlenen" düzeni yeniden üretmenin yoludur. Kazımada görünmeyen
  sütunları almak istiyorsan önce `cdp_viewport({width,height})`.
- **NE ZAMAN KULLANMA:** Parametresiz çağırmak **yalnızca okur** — bu en ucuz
  canlı viewport ölçümüdür.

#### `cdp_printpdf` (#14) — Sayfayı PDF'e bas
- **Parametreler:** `format` (A4/Letter/Legal/Tabloid), `landscape`, `scale`,
  `printBackground` (varsayılan `true`), `pageRanges` (`"1-3,5"`), `saveTo`.
- **NE ZAMAN KULLANMA:** Veri çıkarmak için değil — **arşiv** için. PDF'ten veri
  okumak `cdp_pdftotext`/`cdp_readpdf`'nin işidir ve genelde daha temizdir.

#### `cdp_download` (#15) — İndirmeyi bekle
- **Parametreler:** `timeoutMs` (varsayılan 60000), `renameTo`.
- **Kritik sıralama:** **İndirmeyi tetikleyen tıklamadan ÖNCE başlat.** Çağrı
  throw eder ve indirmenin *başlamasını* bekler.
- **NE ZAMAN KULLANMA:** CSV/Excel indirmesi gereken kazımada — indirmeyi
  `cdp_download`'a bağla, sonra tıkla.

#### `cdp_readpdf` (#16) — Diskteki PDF'i oku
- **Parametreler:** `path` (kök-göreli, zorunlu), `page`, `pageFrom`, `pages`
  (`"1-5"`), `maxChars` (varsayılan 16000, tavan 64000), `includeMeta`.
- **Hata okuması:** Eksik dosya → throw. **Şifreli belge hata değil**, bant içi
  veridir (`encrypted:true`).
- **NE ZAMAN KULLANMA:** PDF bir sekmede *açık* duruyorsa `cdp_pdftotext`.

#### `cdp_pdftotext` (#17) — Sekmede açık PDF'ten metin
- **Parametreler:** `strategy` (`network|print|axtree|auto`), `maxChars` (16000/64000),
  `page`, `pageFrom`, `timeoutMs` (varsayılan 20000), `targetId`.
- **Çıktı:** `text` + kullanılan `strategy`.
- **NE ZAMAN KULLANMA:** PDF diskte değil de ekrandaysa.

#### `cdp_files` (#18) — Downloads kökünde dosya işlemi
- **Parametreler:** `op` ∈ `list|read|write|stat|delete|mkdir`, `path`, `content`,
  `encoding` (`utf8|base64`), `overwrite` (varsayılan `false` → çakışmada sert hata),
  `recursive`, `maxBytes` (varsayılan ve tavan 4 MiB).
- **Kazımadaki rolü:** JSONL kayıt defteri (§4.8) ve indirilen dosyalar.
- **Hata okuması:** Bilinmeyen op, kök dışına kaçış, `overwrite:false` çakışması
  → throw. **Tasarım gereği yalnızca downloads köküne sandbox'lıdır** — genel
  dosya API'si değildir.
- **NE ZAMAN KULLANMA:** Genel dosya yazmak için. Workspace'te kayıt tutacaksan
  `pwsh`/`write` kullan.

### 2.5 Ağ, stealth ve doğrulama

#### `net_capture` (#10) — Yakalanmış HTTP değişimleri
- **Parametreler:** `limit` (varsayılan 50), `host` (filtre).
- **Kazımadaki rolü — en yüksek kaldıraç:** Bir liste sayfasının DOM'u 3 satır
  gösterip arka planda 200 kayıt çekiyorsa, gerçek kaynak JSON API'dir.
  `net_capture({host})` ile o isteği bul, `cdp_exec` ile sayfa bağlamında
  `fetch(..., {credentials:'include'})` çağır.
- **Hata okuması:** `total: 0` veya proxy pasif → yakalama dinleyicisi ayakta
  değil; `cdp_status.proxy.active` kontrol et.
- **NE ZAMAN KULLANMA:** Sayfa verisini DOM'dan alabiliyorsan — önce DOM,
  ağ sadece çıpa olarak.

#### `net_export` (#11) — Trafik raporu
- **Parametreler:** yok.
- **Kritik sıra:** Her şey sıfırsa **önce kullanıcı eylemini yap**, sonra dışa aktar.
- **NE ZAMAN KULLANMA:** Hangi host'ların konuştuğunu genel olarak görmek dışında.

#### `cdp_stealth` (#33) — Stealth profili uygula/denetle
- **Parametreler:** `action` ∈ `status`(varsayılan) | `apply` | `list`, `profile`,
  `targetId`.
- **Çıktı:** aktif profil + **`coherence`** + **`warnings`** (hangi katman
  uygulanamadı).
- **Kritik kural — tek profil her katmanı birden ayarlar:** JS yamaları,
  UA/başlıklar ve launch bayrakları **birlikte** değişir. `coherence` ve
  `warnings` hangi katmanın tutmadığını söyler.
- **NE ZAMAN KULLANMA:** `cdp_fingerprint` "critical" bir gerekçe bildirdiğinde,
  **tespitten sonra, tekrar denemeden önce**. Sıra §3, Kural 9'dur.

#### `cdp_fingerprint` (#34) — Neden reddediliyorum?
- **Parametreler:** `targetId`.
- **Çıktı:** `coherent` + `checks` + sıralı `whyBlocked[]` (`critical|high|
  medium|low`, her biri `layer` ∈ `js|dom|header|behavior` + `evidence`).
- **Kritik — teşhistir, atlatma değildir:** Sayfayı değiştirmez. Kullanıcıya
  "sayfa şu yüzden reddediyor" demeni sağlar, "şunu yaptım da geçti" değil.
- **NE ZAMAN KULLANMA:** Bloklanmadan önce değil, **bloklandıktan sonra** — sebebi
  raporlamak için.

#### `cdp_captcha` (#35) — Doğrulama meydan okuması
- **Parametreler:** `action` ∈ `scan|drag|verify`; `drag` için ayrıca
  `ref`/`css`/`ariaLabel`/`role`+`name`/`text`/`textMatch`/`nth`/`scope`,
  `thumbSelector`, `targetPct` (yoksa track'in `data-target`'ından okunur),
  `steps` (4–200 arası kırpılır, varsayılan **24**), `approach` (varsayılan
  `true`), `overshoot` (varsayılan `true`), `timeoutMs`.
- **Çıktı:** `scan` → `found` + `candidates[]` (`kind`, `evidence`, taze `rect`,
  `hitTest`) + `overlays[]` + `honeypots[]` + `thirdParty`; `drag` → `delivered`,
  `matched`, `beforeValue`/`finalValue`/`expectedValue`, `startX/Y`→`targetX/Y`,
  `deltaMs`, `attempts`; `verify` → `solved` + `signals` + sayfanın kendi
  `wrongClicks`/`decoyClicks`/`honeypotHit`/`solvedAt`.
- **Ölçülen tolerans:** `matched` = geri okuma istenen yüzdenin **±1.5%**'inde.
- **Hata okuması:** `delivered:false` → geri okuma hedefe **ulaşmadı**. Boşuna
  tekrar deneme; `action:'verify'` ile oku. Boş `scan` → `ok:false` + `reason`,
  asla sessiz `[]`.
- **Sayfa yayımlamadığı sayaç — "sıfır" değildir:** `wrongClicks` yoksa **omit
  edilir ve uyarılır**; "0 hatalı tıklama" anlamına gelmez.

---

## 3. Kanıtla öğrenilmiş kurallar

Her kural **belirti → önlem** biçimindedir. Ölçümler canlı oturumda alınmıştır.

### Kural 1 — `limit` düşür, `count` ile gerçek toplamı öğren
**Belirti:** `cdp_extract` varsayılan `limit: 50`'dir, sert tavan **200**'dür
(`EXTRACT_DEFAULT_LIMIT=50`, `EXTRACT_MAX_LIMIT=200`). 40 adaylık bir listede
`limit:3` koyup gerçek toplamı **bilmeden** "3 kayıt var" demek, sessiz veri
kaybıdır.
**Ölçüm:** T8 fikstüründe (40 `.row`) `limit:3` → her satırda `count: 40`, ve
`COMPLETE=false` + `warning: limit 3 applied: 40 candidates matched`.
**Önlem:** `count` kaynağını **her zaman** ekle. `count` = filtre **öncesi**
toplam eşleşmedir; `limit`'i atlatmanı sağlar. `complete:false` gördüğünde
`missing`/`truncatedFields`/`warnings` satırlarını oku.

### Kural 2 — `text` bir satır değil, **tüm satır** demektir
**Belirti:** Tablo satırını hedefleyip `text` isteyen bir ajan, hücre değil
**sekiz-yüz karakterlik tab-ayrılmış bir dize** alır ve sütunları ayrıştırmayı
boşuna dener.
**Ölçüm:** `#govde tr` üzerinde `text` →
`"kayit-49\tÜrün 49 — \"özel\" adlı kayıt\tdonanim\t443 TL"`.
**Önlem:** İki seçenek —
1. **Hücre bazlı:** `from.selector:"td"` + `from.withinRole:"rowgroup"` →
   *ölçüldü:* 48 hücre, `metin` alanları temiz ve ayrı.
2. **Kayıt nesnesi:** `cdp_exec` + `postCondition` ile hücreleri bir nesneye
   topla (sayfadaki `siyaset` = satır bazlı alma). `cdp_exec` asla throw etmez.

### Kural 3 — Tıklama "başarılı" olmak, veriyi ilerletmek değildir
**Belirti:** `cdp_click` `ok:true` verir, düğme `enabled` raporlanır, sayfa
**aynı kalır**. Sonsuz döngü + mükerrer kayıt.
**Ölçüm (en güçlü kanıt):** 5 sayfalık fikstürde son sayfada "Sonraki sayfa"
tıklandı → `Clicked via locator (strategy=css, matched=1)`;
`cdp_expect({check:'enabled'})` → **PASS**; satırlar yine de `kayit-49…60`.
**Önlem:** Döngüyü **kimlik** ile durdur, düğme durumuyla değil. Tur sonrası alınan
kimlik kümesi bir öncekiyle aynıysa **durdur** (§4.6).

### Kural 4 — Her tıklamadan sonra geri oku
**Belirti:** "Araç `ok` dedi" diye atlanan doğrulama. Sayfa yönlendirmesi,
SPA render'ı veya sahte-başarı tuzağı sessizce geçilir.
**Ölçüm:** `cdp_expect({check:'textContains', expected:'Sayfa 2 / 5'})` → PASS.
Sonraki turda **benim** sayım hatam (3 tıkla 5. sayfa sandım, 4. sayfadaydım)
başarısız assertion ile yakalandı: `FAIL: text does not contain expected
(actual: Sayfa 4 / 5)`. **Başarısız assertion veridir, panik sebebi değildir.**
**Önlem:** Her mutasyondan sonra tek bir ucuz `cdp_expect` veya bir `cdp_extract`.

### Kural 5 — `targetId`'yi her çağrıda geçir
**Belirti:** `targetId` opsiyoneldir ve **sessizce aktif sekmeye düşer**. Kullanıcının
21 sekmesi varken bu, yanlış yere yazma kazasıdır.
**Önlem:** `cdp_tabs` → `targetId` seç → **her** çağrıda `targetId` geçir. Kendi
sekmeni `cdp_tab_new({focus:false})` ile aç.

### Kural 6 — Gizli sekme no-op olur
**Belirti:** Arka plandaki (odaklanmamış) sekmede `cdp_exec` zaman aşımına uğrar.
Araç bunu ancak sayfanın `visibilityState=hidden` ile **doğrularsa** adlandırır
(`documentHidden`), ve ancak o zaman `effectiveTimeoutMs` ile ikiye katlar.
**Önlem:** Uzun işlerde `cdp_tab_focus` ile sekmeyi aktifleştir; ya da kısa
çalıştır ve çıktıyı diske al.

### Kural 7 — Viewport kayması
**Belirti:** Bir koordinat bir anda geçerli, sonra geçersizdir; scroll, layout
kayması, viewport değişimi, yapışkan başlık hepsini bozar. T8 fikstürü tam olarak
bunun zeminidir (40 aday, `position:sticky` başlık, `data-w` ile değişken genişlik).
**Önlem:** **Ölç, hiçbir zaman sabit kodlama.** `cdp_find` zaten taze `rect` +
hit-test verir; `coveredBy`/`inViewport` aynı anda sorunu söyler.

### Kural 8 — Ref'i döngüde taşıma; yeniden ölç
**Belirti:** SPA yeniden render edince eski `@ref` ölür. `staleRef` işareti
reddedişi bildirir; `ref-target-renamed` ise elemanın **node id ile bulunduğunu**
ve işlemin yine ona gittiğini söyler (bu bir başarıdır, sorun değil).
**Önlem:** Tıklama/yazmadan hemen önce `cdp_snapshot`; `cdp_find`/`cdp_click`
zaten eylem anında yeniden ölçer. Sayfa değişmediyse ve ref yine reddediliyorsa
yeniden snapshot'lama döngüsüne girme — locator ile adresle.

### Kural 9 — Stealth ölçüm sırası sabittir
**Sıra:** `cdp_fingerprint` (neden reddediliyorum?) → `cdp_stealth` (hangi katman
eksik?) → **sonra** tekrar dene. Stealth'i önce uygulamak, sorunu ölçmeden
ayarlamaktır; `cdp_stealth({action:'status'})` `coherence` + `warnings` verir,
böylece hangi katmanın tutmadığını bilirsin.

### Kural 10 — `cdp_eval` 16 KiB bütçesi
**Belirti:** 51 781 karakterlik JSON döndürmek → sonuç tam **16 384**'te kesildi.
`cdp_eval` bunu `(truncated)` ile **söyler**; `cdp_exec`'te kesik dize aynı
şekilde işaretlenmez.
**Önlem:** Büyük sonuçları `cdp_extract` + `limit` ile parçala. `cdp_exec` kullanıyorsan
kesildiğini kendin doğrula — `JSON.parse` denemesi en ucuz cankır.

### Kural 11 — `kind:"page"`: **düzeltildi** (plan09-fix)
**Ölçülen boşluk (düzeltme öncesi):** Sayfada `meta[name="description"]` **yok**;
`cdp_extract({kind:'page'})` yine de `description:""` döndürdü ve **`COMPLETE`**
dedi. `cdp_exec` ile doğrulandı: `{"metaExists":false}`. Sayfa alanlarında `""` ile
"alan yok" **ayırt edilemez** durumdaydı.

**Yapılan düzeltme:** `src/extract.ts` içindeki `PAGE_FIELDS_EXPRESSION` artık
**arka plandaki düğüm yoksa `null`** döndürüyor, düğüm **varsa** düz metni
(boş olsa bile) döndürüyor. `projectExtract` `null` alanı zaten
`missing[]`'e yazıp `complete:false` yapıyordu; yani **yalnızca ifadenin yalan
söylemesi düzeltildi**.

**Yeni sözleşme:**
| Durum | Sonuç |
|---|---|
| `<h1>` / `meta[description]` / `lang` **yok** | `missing[]` satırı + **`complete:false`** + alan **hiç yazılmaz** |
| Düğüm **var ama boş** (`<h1></h1>`, `content=""`) | `""` değeri + **missing'e girmez** + `complete:true` |

**Doğrulama (canlı, plan09-fix sonrası):** `zor-dogrulama.html` üzerinde
`{"metaVarMi":false, yeniDescription:null, eskiDescription:"", yeniH1:"Zor Doğrulama
Fikstürü", yeniLang:"tr"}` — yani alan yokken artık `null` (⇒ `missing`), `h1`
ve `lang` **var olduğu için** normal değerlerini koruyor.

> **Çalışan derleme notu.** `lib/` derlemesi düzeltmeyi içerir; **çalışan DSH
> süreci eski kodu bellekte tutar.** Yeni davranışı görmek için bir sonraki
> yeniden başlatma gerekir. Şüphedeysen §4.1 adım 1'deki `cdp_exec` yokluk
> sorgusuyla kendin doğrula.

### Kural 12 — `value` uyumsuz düğümde: **düzeltildi** (plan09-fix)
**Ölçülen boşluk (düzeltme öncesi):** `section.card` gibi bir form değeri
taşımayan düğümde `value` isteyen liste → `"visible": null` yazıyordu, **missing
satırı üretmiyordu** ve `complete:true` kalabiliyordu. Yani "bu düğümün değeri
yok" ile "kontrol gerçekten boş" **ayırt edilemez** durumdaydı.

**Yapılan düzeltme:** `src/extract.ts` → `projectExtract`. `evidence.value`
`undefined` olduğunda artık `missing[]`'e
`field '<ad>': node has no value (not an input, textarea, or select)` yazılıyor,
`complete:false` oluyor ve alan **hiç yazılmıyor** (sessiz `null` yok).

**Yeni sözleşme:** gerçek bir kontrolde **boş** değer (`""`) → değerdir, `missing`
yok; düğüm hiç değer taşımıyorsa → `missing` + `complete:false`.
**Önlem (araç değişse de geçerli):** `value` yalnız `input`/`textarea`/`select`
için anlamlıdır; kutu/öznitelik istiyorsan `box` ya da `attr:<ad>` kullan.

### Kural 12b — Hücre→satır gruplaması: **kasıtlı olarak eklenmedi**
`cdp_extract` bir `<tr>`ye `text` uygulandığında hücreleri tek dizeye katlar
(Kural 2) ve `fields` sözlüğü **düz anahtar → tek kaynak** eşlemesidir; iç içe
`{cells:[…]}` gibi bir yapı yoktur. Bunu eklemek sözleşmeyi, `complete`
hesabını ve `missing` üretimini birlikte değiştirirdi. **Karar: eklenmedi.**
Bunun yerine ölçülmüş iki yol belgelidir — `from.selector:"td"` +
`from.withinRole:"rowgroup"` (hücre başına bir satır) veya `cdp_exec` +
`postCondition` (gerçek kayıt nesnesi). İkisi de §4.4'te çalışan örnekle var.

### Kural 13 — Mutasyonları **sıralı** yap, asla paralel değil
**Belirti:** Aynı mesajda birden çok sekmeye eşzamanlı tıklamak, sekme
aktivasyonu üzerinde yarış yaratır. Kazıma döngüsünün "paralel" hâle getirilmesi,
T8 ölçümünde 4 tıklamadan 2'sini **yanlış** hedefe düşürdü (biri `(0,0)`'a, yani
pasif-sekme imzası); **aynı 4 tıklama sıralı yapılınca 3/3 doğru** oldu.
**Önlem:** Kazıma döngüsü zaten sıralıdır — bunu **kazara** paralel yapma.
Ayrıca `cdp_viewport` gibi hedef-duyarlı araçlarda da `targetId` ver; hedefsiz
çağrı registry'nin aktif hedefine uygulanır (hedef kayması değil, **hedef seçimi**
hatasıdır).

### Kural 14 — Doğrulamadan **tekrarlama**: tekrar "deneme" değil, **gönderim**dir
**Belirti:** Bir mutasyonu doğrulamadan tekrarlarsan, kullanıcıya **iki teslimat**
görünür. T3 ölçümü: viewport daraltılıp bayat koordinatla tıklandıktan sonra
yeniden ölçülüp tekrar tıklandığında `submits: 1 → 2`.
**Önlem:** Mutasyon → post-koşul → **yalnız koşul sağlanmadıysa**, en fazla
3 kez ve gerekçesiyle tekrarla. Raporunda "etkili deneme" ile "ham deneme"
sütunlarını **ayrı** tut.

### Kural 15 — `cdp_exec` ifadesini ~3 KB'de böl
**Belirti:** ~5 KB'lık tek bir `cdp_exec` ifadesi `SyntaxError: Unexpected token
':'` ile **ayrıştırılamaz**; aynı mantığın ~3 KB'lık iki parçaya bölünmüş hâli
sorunsuz çalışır.
**Önlem:** Büyük projeksiyonları `cdp_extract`'e; `cdp_exec`'e yalnız küçük,
koşullu parçalar ver.

### Kural 16 — "Hazır" kanıtını zincirle: navigate → wait → **doğrula**
**Belirti:** `cdp_navigate` yüklenmeden dönebilir. Bekleme zinciri kurmadan
alınan sonuç sessizdir: T3'te `chrome-error://chromewebdata/` üzerinde
`ERR_FILE_NOT_FOUND` sonucu sessizce kazanıldı (sebep: `geliştirme` →
`gelişirme` yazım hatası) ve ancak `cdp_wait` zaman aşımını döndürdükten sonra
`cdp_exec` ile görünür oldu.
**Önlem:**
```
cdp_navigate(url)
  → cdp_wait({strategy:'visible', selector:'#v1-box'})
  → cdp_exec({expression:'({readyState:document.readyState, cards:…, t6:!!window.__t6})',
              postCondition:'window.__t6 && document.readyState==="complete"'})
```
**`/json` anlık fotoğraf değildir** — envanter görevi görür, doğrulama görevi görmez.

### Kural 17 — Gizli sekmede `setTimeout` **kısıtlanır**
**Belirti:** Gizli sekmede 500 ms'lik `setTimeout` **901 ms** ölçüldü; 30 adımlık
zamanlayıcı zinciri 15 002 ms zaman aşımına düştü ve script sayfada **zombie**
olarak çalışmayı sürdürdü.
**Önlem:** `cdp_exec` içinde `setTimeout` zinciri kurma; **spin-wait** kullan
(`for(;;)` + `performance.now()`). Uzun işlerde `cdp_tab_focus` ile sekmeyi
aktifleştir.

---

## 4. Reçeteler

> Her reçetedeki `targetId` yer tutucusudur; §4.0'daki gibi sabitle.

### 4.0 Sabitleme (her turun başında)

```
1) cdp_status                       → tarayıcı ayakta mı
2) cdp_tabs                         → targetId'yi SEÇ
3) cdp_eval({expression:'location.href', targetId})  → doğru sayfa mı
4) cdp_tab_new({url, focus:false})  → kendi sekmen (opsiyonel ama önerilen)
```

### 4.1 Tek sayfa alımı

**Ne zaman:** Bir sayfadaki kayıt kümesini bir kez okumak.

**Adım 1 — sayfa kimliği ve meta (hata ayıklama çıpası):**
```jsonc
cdp_extract({
  targetId: "<T>",
  spec: {"kind":"page","fields":["title","url","h1","lang","description"]}
})
```
*Ölçülen çıktı (`zor-dogrulama.html` üzerinde):*
```
Extracted 1 row(s) (COMPLETE) from 0 of 94 nodes:
[{"title":"Zor Doğrulama Fikstürü — T7 Derinlik Ölçüm Zemini",
  "url":"file:///…/zor-dogrulama.html","h1":"Zor Doğrulama Fikstürü",
  "lang":"tr","description":""}]
```
*Bu çıktı, plan09-fix **öncesi** ölçülmüştür:* `description:""` + `COMPLETE`, halbuki
sayfada `meta[description]` **yok** — sessiz bir delik. **Düzeltme sonrası aynı
çağrı** `missing: field 'description': no source on this page` +
**`COMPLETE=false`** döner ve `description` anahtarını **hiç yazmaz** (bkz. Kural 11).

> Çalışan DSH süreci eski kodu bellekte tutuyorsa eski çıktıyı görmeye devam
> edersin. O durumda doğrulamayı kendin yap:
> ```jsonc
> cdp_exec({
>   targetId: "<T>",
>   expression: "JSON.stringify({ metaExists: !!document.querySelector('meta[name=\"description\"]') })",
>   postCondition: "document.querySelector('meta[name=\"description\"]') === null"
> })
> ```

**Adım 2 — kayıt listesi (her zaman `count` ile):**
```jsonc
cdp_extract({
  targetId: "<T>",
  spec: {
    "kind": "list",
    "from": {"selector": "section.card"},
    "fields": {"id":"attr:id","variant":"attr:data-variant","name":"name","role":"role"},
    "limit": 20
  }
})
```
*Ölçülen çıktı:* 6 satır, `id` = `v6…v11`, `variant` =
`chain-3step | dynamic-target | iframe-internal | double-cover | decoy-success |
visible-honeypot`. `attr:` kaynakları DOM metnini değil **özniteliği** okur —
bulguların kimliği için en iyi yol.

**Adım 3 — eksik ölçümü kapat:**
```jsonc
cdp_extract({
  targetId: "<T>",
  spec: {"kind":"list","from":{"selector":"section.card"},
         "fields":{"id":"attr:id","toplam":"count"},"limit":3}
})
```
*Ölçülen:* `COMPLETE=false` + `warning: limit 3 applied: 6 candidates matched` +
her satırda `toplam: 6`. Artık "kaç kayıt var" sorusunun cevabı elinde.

**Adım 4 — satır nesnesi gerekiyorsa:**
```jsonc
cdp_exec({
  targetId: "<T>",
  expression: "(() => [...document.querySelectorAll('#govde tr')].map(tr => { const c = tr.querySelectorAll('td'); return { id: tr.getAttribute('data-id'), baslik: c[1].textContent.trim() }; }))()",
  postCondition: "document.querySelectorAll('#govde tr').length > 0"
})
```

### 4.2 "Bu bir tablo sayfası mı?" teşhisi

`cdp_extract`'in boş dönmesi **"yok" demek değildir**; "bu seçici tutmadı" demektir.
Tablo olup olmadığını **role** üzerinden kanıtla.

**Adım 1 — yapısel kanıt (role taraması):**
```jsonc
cdp_find({ targetId: "<T>", selector: "#govde tr" })
cdp_find({ targetId: "<T>", role: "cell" })
```
*Ölçülen çıktı:*
```
Found 12 match(es). match 1: "html||0>generic||0>main||0>table||0>rowgroup||1>row||0" [row]
   box(372.58,143.975,1055x35.5) visible=true inViewport=true — actionable.

Found 48 match(es). match 1: "…>table||0>rowgroup||1>row||0>cell|kayit-49|0" [cell]
   box(372.58,143.975,186.47x35.5) visible=true inViewport=true — actionable.
```
`row` / `rowgroup` / `cell` rolleri weaver'da varsa **gerçek bir tablodur**; 48 = 12×4
hücre tutarlılığı da satır konsistansını kanıtlar.

**Adım 2 — negatif kontrol (tablo DEĞİLSE):**
```jsonc
cdp_extract({ targetId: "<T>",
  spec: {"kind":"list","from":{"selector":"table tbody tr"},"fields":{"a":"attr:id"}} })
```
T8 fikstüründe *ölçülen* yanıt:
```
Extracted 0 row(s) (COMPLETE=false) from 0 of 104 nodes:
[]
missing: no node matched from/where
```
Bu, `data:[]`'nin **sessiz başarı olmadığının** kanıtıdır — `missing` satırı
verir. Aynı sayfada `.row` seçicisi ise `count: 40` döndürdü: yani kayıtlar
**vardı**, sadece tablo değildiler. Karar: CSS/eş-yapı seçiciye geç.

**Adım 3 — satır konsistansı:**
`cdp_extract` `limit:1` + `count` ucuz bir tutarlılık testidir
(§4.1 adım 3). Hücre bazlıysa `cells / rows` bölümü tam sayı olmalıdır —
48/12 = 4. Bölüm tam değilse sayfa **kısmi render** ediyor demektir:
`cdp_wait({strategy:'visible'})` ile bekle ve tekrar ölç.

### 4.3 Gerçek bir tabloyu oku (14 satırlık canlı örnek)

`bot-sinyal-sayfasi.html` fikstüründeki `#sig-table`, 14 satırlık **gerçek** bir
`<table>`'dır ve her satırda `data-risk` niteliği vardır. Sınıflandırılabilir bir
sütun çıkarmak istiyorsan bu, numunelik bir örnektir:

```jsonc
cdp_extract({
  targetId: "<T>",
  spec: {
    "kind": "list",
    "from": {"selector": "#sig-table tbody tr"},
    "fields": {"sinyal": "text", "risk": "attr:data-risk", "toplam": "count"},
    "limit": 20
  }
})
```
*Ölçülen çıktı (14/14 satır, `COMPLETE`):*
```
Extracted 14 row(s) (COMPLETE) from 14 of 110 nodes:
[{"sinyal":"navigator.webdriver\tfalse\tok","risk":"ok","toplam":14},
 {"sinyal":"navigator own-prop izi\t0 adet\tok","risk":"ok","toplam":14},
 {"sinyal":"languages\t[\"en-US\",\"en\"]\tok","risk":"ok","toplam":14},
 … 11 satır daha …
 {"sinyal":"UA tutarlılığı\ttamam\tok","risk":"ok","toplam":14}]
```
Burada iki sütun **farklı türdür** ve bu ayrım kazımanın temelidir:
- `sinyal` = `text` → satırın **ham metni**, hücreler tab ile birleşik.
- `risk` = `attr:data-risk` → **yapısal** sınıflandırma; metin değil, öznitelik.

`risk` sütununu `text`'ten değil `attr:`'ten okuyorsan, hücre içeriği değişse
bile sınıflama sağlam kalır. **Kayıt sütunlarını mümkünse `attr:` ile al.**

### 4.4 Satır tutarlılığı testi
Tablonun gerçekten "bir kayıt = bir satır" olduğunu kanıtlamak için:
```jsonc
cdp_extract({ targetId: "<T>",
  spec: {"kind":"list","from":{"selector":"td","withinRole":"rowgroup"},
         fields":{"metin":"text"},"limit":4} })
```
*Ölçülen:* 4 temiz hücre metni (`kayit-49`, `Ürün 49 — …`, `donanim`, `443 TL`) ve
`warning: limit 4 applied: 48 candidates matched`. `withinRole:"rowgroup"`
tabloyu atlatıp **sadece gövde hücrelerini** seçti — başlık hücreleri dahil değil.

### 4.5 Giriş gerektiren sayfa

**Adım 1 — kalıcı profil.** `cdp_open` parametresiz çağrıldığında canlı
tarayıcıları tarar, bulursa `needsChoice` döndürür ve **hiçbir şeye bağlanmaz**.
Kalıcı, giriş yapılmış oturum için:
```jsonc
cdp_open({ profile: "assistant" })
```
Profil `$DSH_HOME/profiles/assistant/` altında durur ve **yeniden başlatmaları
atlatır**. Kurallar `src/profiles.ts` içinde sabittir:
- Ad deseni yalnızca `[A-Za-z0-9_-]{1,64}`; `..`, `/`, `\` **dosya sistemine
  hiç uğramadan** reddedilir.
- **Hiçbir şey silinmez** — oturumun kendisi amaçtır.
- Kilit **gizlenmez, raporlanır**: `SingletonLock`, `SingletonSocket`,
  `SingletonCookie`, `lockfile` bulunursa `cdp: profile "assistant" is already
  open in another browser` denir ve **geçici profile sessizce düşülmez** —
  çünkü yeni bir profil "giriş yapılmamış" görünür ve kullanıcı "girişim nereye
  gitti?" diye sorar.

**Adım 2 — giriş kullanıcının kendi penceresinde olur.** Bu modül hiçbir
kimlik bilgisi okumaz, 2FA'ya dokunmaz; ajana giriş yaptıracak bir yol vermez.

**Adım 3 — formu doldur ve doğrula.** `cdp_type` değil:
```jsonc
cdp_fill({ targetId: "<T>", css: "#username", value: "…" })
cdp_fill({ targetId: "<T>", css: "#password", value: "…" })
cdp_click({ targetId: "<T>", css: "#submit" })
cdp_expect({ targetId: "<T>", check: "textContains", expected: "Çıkış", timeoutMs: 15000 })
```
`cdp_fill` `verify:true` ile geri okuma yapar; React geri alırsa `fallbackUsed:true`
bildirir.

### 4.6 Çok sayfalı döngü

Beş parçadır: **turlama, tekrar önleme, derinlik sınırı, doğrulama, durma.**

```
seen = ∅ ; derinlik = 0 ; tur = 1 ; son_kimlik = ∅
loop:
  1) BEKLE    cdp_wait({strategy:'visible', selector:'#govde tr'})
  2) AL       cdp_extract({spec: {kind:'list', from:{selector:'#govde tr'},
                                 fields:{id:'attr:data-id', toplam:'count'}, limit:200}})
  3) DOĞRULA  complete:false ise missing/truncatedFields/warnings OKU        (Kural 1)
  4) KİMLİK   yeni = {id} \ seen
              yeni boşsa → DUR   ← asıl durma sinyali (Kural 3)
  5) BİRLEŞTİR  seen ∪= yeni ;  JSONL'ye yaz (overwrite:true)               (§4.8)
  6) SINIR    derinlik+1 >= 20 ise DUR ve kullanıcıya bildir
  7) GERİ OKU tur değişti mi?
              cdp_expect({check:'textContains', expected:'Sayfa '+(tur+1)})   ← Kural 4
              değişmediyse → DUR (düğmeye değil, veriye bak)
  8) TIKLA    cdp_click({css:'#next'})
              cdp_wait({strategy:'visible', selector:'#govde tr'})
  9) tur++ ; derinlik++ ; DÖNGÜ
```

**Ölçülen kanıt (5 sayfalık fikstür):**
- Sayfa 1 → `kayit-1…12`, `count: 12`
- Tıkla + `cdp_expect('Sayfa 2 / 5')` → **PASS**
- Sayfa 2 → `kayit-13…24` (kesişme yok)
- Sayfa 5'te tıkla → `ok:true`; `cdp_expect('Son sayfa')` → **PASS**;
  satırlar **hâlâ** `kayit-49…60`. Kimlik kümesi değişmediği için döngü durur.

**Zorunlu ayarlar:**
- **`limit: 200`** (sert tavan). Daha fazlasını tek çağrıda isteyemezsin.
- **`count` her turda** — sayfa başına kaç kayıt olduğunu bilmeden
  ilerlemek, "kayıt kaybettim"in en yaygın sebebidir.
- **Derinlik sınırı** (varsayılan 20 tur) **kullanıcıya bildirilir**; sessizce
  kesilmez. Sonsuz kaydırmalı listelerde bu sınır olmazsa tur bitmez.

### 4.7 Rate limiting + robots.txt

**Bilgi akışı: sessiz geçme yok.** Kararın üç hâli vardır ve üçü de
kullanıcıya söylenir:

| Durum | Kanıt | Eylem |
|---|---|---|
| Serbest | `robots.txt` ilgili yolu engellemiyor, `Crawl-delay` yok/yeterli | İnsan temposuyla devam; tur başına gerçek bekleme |
| Kısıtlı | `Crawl-delay: N` veya `Disallow` | Oranı ve kaydı raporla; devam kararını görev kapsamında ver |
| Yasak | `Disallow:` ilgili yol için | Durumu ve kanıtı raporla; devam kararını görev kapsamında ver |

`robots.txt`'i okumak:
```jsonc
cdp_navigate({ targetId: "<T>", url: "<kök>/robots.txt" })
cdp_text({ targetId: "<T>", css: "body", maxChars: 4000 })
cdp_navigate({ targetId: "<T>", url: "<hedef sayfa>" })   // geri dön
```

**Rate limit kanıtı** `net_capture`/`net_export` ile alınır: `429`/`503` yanıtları
görünürse oranı ve kaydı raporla; devam kararını görev kapsamında ver.

> **Bu bölüm canlı olarak doğrulanmadı.** Ölçülen kısım sayfalama ve çıkarım
> mekaniğidir; `robots.txt` ve `Crawl-delay` kuralı bilgi kaynağı olarak
> okunur ve raporlanır.

### 4.8 Kayıt biriktirme (JSONL) ve **resume**

**Neden JSONL:** Her tur bir satır eklenir. Süreç çökerse dosya bozulmaz; kaldığın
yeri **satır sayarak** bulursun.

```jsonc
// her turdan sonra
cdp_files({
  op: "write",
  path: "kazima/<kaynak>-<tarih>.jsonl",
  content: "<satır>\n",
  overwrite: true          // ← her turda gerekli
})
```
`cdp_files` downloads köküne sandbox'lıdır; **genel dosya API'si değildir.**
Workspace'e kayıt istiyorsan `write`/`pwsh` kullan.

**Resume protokolü:**
1. Dosyayı oku: `cdp_files({op:'read', path:'…', maxBytes: 4194304})` (tavan 4 MiB).
2. Her satırı `id` alanına göre çöz.
3. `seen` kümesini bu kimliklerle **yeniden kur**.
4. Döngüye `tur = max(satır_sayısı / sayfa_boyutu)` ile devam et.
5. Kullanıcıya bildir: *"N'den devam ediyorum, M kayıt zaten var."*

**Zar okuması:** `cdp_files` `overwrite:false` ile **çakışmada sert hata** verir.
`overwrite:true` vermeden her turu "yaz"maya çalışmak, ikinci turda hata durur.
Bu bir hata değil, bir koruma.

### 4.9 Doğrulama disiplini — her turda "ne kadar aldım, ne eksik"

**Dört soruyu her turda cevapla:**

| Soru | Araç | Kanıt |
|---|---|---|
| Toplam ne kadar vardı? | `fields:{toplam:'count'}` | `toplam: 40` |
| Kaçını aldım? | `count` alanı / `data.length` | `data: 12` |
| Kesildi mi? | `complete` + `limitApplied` | `complete:false`, `warning: limit 3 applied: 6 candidates matched` |
| Ney eksik? | `missing[]`, `truncatedFields[]`, `warnings[]` | `no node matched from/where` |

**`complete:false` gördüğünde sessiz geçme.** Ya `limit`'i yükselt (tavan 200),
ya da turu kabul et ve **farkı kullanıcıya bildir**.

**Ölçülen üç ayrı kesme sinyali:**

```
missing: no node matched from/where                                  ← sorgu tutmadı
warning: limit 4 applied: 48 candidates matched                     ← bütçe kesti
truncatedFields: [<160 karakteri aşan sütun anahtarları>]            ← metin kısaldı
```
`truncatedFields` sessiz değildir: `complete`'i `false` yapar. Kırpılan alanı
bilmeden kullanma.

---

## 4.10 Kanıt kaydı ve **doğrulanmayan iddialar**

Bu bölüm, kılavuzun kendi kaynağına ilişkin iki dürüst not içerir.

### Doğrulanan ölçümler
| Ölçüm | Sonuç |
|---|---|
| `kind:'page'` (meta yok) | `description:""` + **`COMPLETE`** |
| `kind:'list'` + `attr:` | 6 satır, `v6…v11` |
| `limit:3` / 6 eşleşme | `COMPLETE=false`, `warning: limit 3 applied: 6 candidates matched`, `count:6` |
| `limit:3` / 40 eşleşme (T8) | `count:40` |
| Olmayan tablo seçicisi | `missing: no node matched from/where` |
| `<tr>` `text` | Tüm satır, tab-ayrılmış |
| `td` + `withinRole:'rowgroup'` | 48 temiz hücre |
| **Gerçek tablo** (`#sig-table`) | **14 satır, `COMPLETE`, `attr:data-risk` dolu** |
| Bozuk alan kaynağı | `cdp_extract: field 'hatali' has unknown source 'kaynakYok'` |
| `cdp_eval` 51 781 karakter | 16 384'te kesildi, **`(truncated)`** |
| Son sayfada tıklamama | `ok:true` + `enabled: PASS` + veri **değişmedi** |
| 5 sayfa | `kayit-1…60`, kesişmesiz, 12/sayfa |
| `cdp_type` 13 krk Türkçe | Eksiksiz yazıldı, **sonuna ekledi** (değiştirmedi) |
| `cdp_fill` Türkçe | `verified: value matches` |
| `cdp_captcha scan` | 3 aday, `third-party verdict: first-party` |
| `cdp_captcha verify` | Çalıştı: `not solved`, `wrongClicks=0` |

### Doğrulanmayan / derleme-özel iddialar
Test raporlarındaki iki iddia bu derlemede **tekrarlanmadı** ve kılavuza
**olgu olarak girmemiştir**:
1. `cdp_captcha({action:'verify'})` → `the page-side verify failed (view is not
   defined)`. Canlı denemede `verify` **düzgün** yanıt verdi.
2. `cdp_fill` → `Identifier 'failures' has already been declared`. Canlı
   denemede yalnız meşru bir eyleme uygunluk hatası geldi; kaydırınca doldu.

**Sonuç:** Bu iki davranış ya düzeltilmiş ya da derlemeye özeldir. Benzer bir
hata görürsen **önce kendi ölç**, rapora olduğu gibi yazma.

### Kaynakta bulunan, bu rehberde düzeltilmiş tutarsızlıklar
| Bulgu | Nerede | Durum |
|---|---|---|
| "36 `cdp_*` + net_capture/net_export" (net araçları iki kez sayıyordu) | `src/index.ts:110` | **Düzeltildi (plan09-fix)** → "39 tools in all — 37 `cdp_*` plus `net_capture` and `net_export`" |
| "`cdp_read` ile taze tut" — böyle bir araç yok | `src/index.ts:124` | **Düzeltildi (plan09-fix)** → `cdp_snapshot`/`cdp_click`/`cdp_type` |
| `cdp_extract` `kind:'page'` alan yokken `""` + `COMPLETE` | `src/extract.ts` | **Düzeltildi (plan09-fix)** — Kural 11 |
| `cdp_extract` `value` uyumsuz düğümde sessiz `null` | `src/extract.ts` | **Düzeltildi (plan09-fix)** — Kural 12 |
| **plan17-skillweb düzeltmeleri** (aşağıdaki tablo) | rehber metni | **Düzeltildi (plan17-skillweb)** — kaynak kodla birebir doğrulandı |

### plan17-skillweb: mimari denetimde bulunan ve düzeltilen iddialar

| # | Yanlış iddia (dosya:satır) | Gerçek | Durum |
|---|---|---|---|
| H1/H3/H4 | "`cdp_locate` … çalışan derlemede **kayıtlı değil**", "canlı oturum 33 `cdp_*` görüyor" | `tools.ts:3272` **#36**; `docs/tool-catalog.md`'de şemasıyla var; 36 aracın tamamı canlı | **Düzeltildi** — §2 girişi ve `cdp_locate` maddesi yeniden yazıldı |
| H2 | "`src/index.ts:110` sayım hatası" | O satır **zaten** plan09-fix ile düzeltilmiş | **Düzeltildi** — iddia kaldırıldı |
| M1 | `cdp_dialog` parametreleri "`targetId`, `promptText`, `policy`" | Asıl parametre **`action`** = `list`\|`accept`\|`dismiss`\|`policy`; `list` varsayılanı **yalnız gösterir** | **Düzeltildi** — §2.3 maddesi yeniden yazıldı |
| M2 | `cdp_find` "`candidates` **en fazla 10**" | `src/locator.ts:423` `MAX_REPORT = 5` → en fazla **5** | **Düzeltildi** |
| M3 | `scan` aday türleri 10 değer (liste gibi okunuyor) | `src/captcha.ts:59-71` **11** değer; sonuncusu **`unknown`** ("honest fallback") | **Düzeltildi** — `07-human-interaction.md` §6 |
| M4 | Tuzak sınıflandırması anlatılmıyor | `src/captcha.ts:247` `CaptchaHoneypotClass` = **`hidden-trap` \| `visible-honeypot`** | **Düzeltildi** — `07-human-interaction.md` §6 |
| S1 | *(kaynak tarafı)* katalog özeti "ships **34** model-facing tools" | Aynı satırda 36 araç adı var | **BİLDİRİLDİ, düzeltilmedi** — `scripts/gen-tool-catalog.ts:621` bu paketin dışında ve kod değişikliği gerektirir |

> **Bu satırdaki eski bir hatamın düzeltilmesi.** Önceki sürümde
> "`docs/tool-catalog.md` depoda yok" yazılmıştı; **yanlıştı**. Dosya depo kökünde
> `docs/tool-catalog.md` (139 KB) olarak **vardır** ve `pnpm run verify-tool-catalog`
> onu okur. Doğru konum kök `docs/`'dir, `packages/bundle/cdp/docs/` değil.

> **Bir iddia, kaynak kodla doğrulanana kadar iddia değildir.** Yukarıdaki tablo
> bir hata günlüğüdür: her satır ya kaynak satırıyla ya da katalog şemasıyla
> kanıtlanmıştır. Kendi iddianı da öyle yaz — ölç, sonra söyle.

---

## 5. Karar ağacı — "hangi durumdaysan hangi aracı?"

```
BAŞLA
 │
 ├─ Tarayıcı/araç görünüyor mu?  ── hayır ──► cdp_endpoints()  →  cdp_open()
 │                                                            (profile gerekliyorsa: profile:'assistant')
 ├─ Doğru sayfada mıyım?          ── hayır ──► cdp_tabs() → targetId SEÇ → cdp_eval(location.href)
 │
 ├─ SAYFA İÇERİĞİNİ OKUMAK
 │   ├─ Tek sayfa kimliği/meta ──────► cdp_extract {"kind":"page"}
 │   ├─ Tekrar eden yapı (tablo/liste/kart) ► cdp_extract {"kind":"list", from:{selector}}
 │   │        └ satır NESNESİ mi?  ──► cdp_exec + postCondition   (Kural 2)
 │   ├─ Tek bir öğenin metni ───────► cdp_text
 │   ├─ Anlık görüntü + kanıt ──────► cdp_screenshot {rects:true, annotate:true}
 │   └─ PDF (diskte / ekranda) ─────► cdp_readpdf / cdp_pdftotext
 │
 ├─ DOM YANIT VERMİYOR
 │   ├─ Sorgu var mı?  ── evet ──► cdp_find (eyleme uygunluk kanıtı)
 │   │                         └─ inViewport:false ──► cdp_scroll {mode:'selector'}
 │   │                         └─ coveredBy         ──► örtüyü kaldır, sonra yeniden ölç
 │   └─ Sorgu yok (canvas/ikon) ──► cdp_screenshot → cdp_locate → cdp_click   (görsel döngü)
 │
 ├─ SAYFAYLA DÖNÜŞÜM
 │   ├─ "Sonraki" var mı?  ──► cdp_click({css}) → cdp_expect(SAYFA DEĞİŞTİ Mİ?)
 │   │   └ değişmediyse: KİMLİK KÜMESİ aynı → DUR        (Kural 3 — düğmeye bakma)
 │   ├─ Sonsuz kaydırma ──► cdp_scroll({mode:'bottom'}) + DERİNLİK SINIRI (20)
 │   └─ URL değişiyor ──► cdp_wait({strategy:'url', url:'/page=\\d+'})
 │
 ├─ VERİ DOM'DA DEĞİL, AĞDA
 │   ├─ net_capture({host}) ──► istek URL'ini bul
 │   └─ cdp_exec + fetch(url,{credentials:'include'})   (HttpOnly çerez taşımaz)
 │
 ├─ GİRİŞ DUVARI
 │   ├─ Kalıcı oturum ──► cdp_open({profile:'assistant'})   (kullanıcı kendi penceresinde girer)
 │   ├─ Form ──► cdp_fill (verify:true) → cdp_click → cdp_expect
 │   └─ 401 ──► document.cookie YENİDEN GÖNDERME; sayfa içi fetch kullan
 │
 ├─ ENGELLENDİ
 │   ├─ Üçüncü taraf sağlayıcı ──► DUR, cdp_captcha{scan}.thirdParty ile bildir   (KATMAN C)
 │   ├─ Rate limit (429/503) ──► DUR, net_capture kanıtıyla bildir
 │   └─ Robot sinyali ──► cdp_fingerprint (teşhis) → cdp_stealth(apply) → TEKRAR
 │
 └─ KAYIT TUT
     ├─ Her tur JSONL satırı + cdp_files(overwrite:true)
     ├─ Resume: seen kümesini dosyadan yeniden kur
     └─ Kesildiğini kullanıcıya bildir (sessiz geçme yok)
```

---

## 6. Sık yapılan hatalar

| # | Tuzak | Belirti | Önlem |
|---|---|---|---|
| 1 | `limit`'i bütçe sanmak | 40 kayıttan 3 aldın, "3 var" dedin | `count` alanını **her** spec'e ekle (§3, Kural 1) |
| 2 | Satır `text`'i hücre sanmak | Tab-ayrılmış tek dize | `td` + `withinRole` ya da `cdp_exec` (§3, Kural 2) |
| 3 | Tıklamayı doğrulama saymak | `ok:true`, veri yerinde | `cdp_expect`/`cdp_extract` geri okuması (§3, Kural 3) |
| 4 | `enabled` bitiş sinyali sanmak | Son sayfada sonsuz döngü | **Kimlik kümesi** değişti mi? (§4.6) |
| 5 | `targetId`'yi atlamak | Yanlış sekmeye yazıldı | Her çağrıda `targetId` (§3, Kural 5) |
| 6 | `stale-ref`'te snapshot döngüsü | Aynı sayfada tekrar tekrar snapshot | Değişmeyen sayfada locator kullan (§3, Kural 8) |
| 7 | `presence ≠ visibility` | `display:none` katman "hazır" sanıldı | `strategy:'visible'` |
| 8 | 16 KiB bütçeyi ezmek | Sessiz yarım veri | `cdp_extract` + `limit`, `cdp_eval`'de `(truncated)` kontrolü |
| 9 | `COMPLETE`u "veri var" sanmak | Alan yokken `""` + `COMPLETE` | **Düzeltildi** (Kural 11): artık `missing` + `complete:false` |
| 10 | `value` her düğümde çalışır sanmak | Sessiz `null` | **Düzeltildi** (Kural 12): artık `missing` + `complete:false` |
| 11 | `robots.txt`'i atlamak | Kısıt ihlali | Oku, uygula, **bildir** (§4.7) |
| 12 | `cdp_files` ile genel dosya yazmak | Kök dışına çıkma reddi | Workspace'te `write`/`pwsh` kullan |
| 13 | `net_export`'ı eylemden önce çağırmak | Her şey sıfır | **Önce eylem, sonra export** |
| 14 | `cdp_download`'ı tıklamadan sonra başlatmak | 60 sn zaman aşımı | **Önce** `cdp_download`, sonra tıkla |
| 15 | Stealth'i ölçmeden uygulamak | Hangi katman tutmadı bilinmiyor | `fingerprint` → `stealth` → tekrar |
| 16 | Kazıma döngüsünü "paralel" yapmak | 4 tıklamadan 2'si yanlış; sıralı yapınca 3/3 | Mutasyonları **sıralı** yap (Kural 13) |
| 17 | Doğrulamadan tekrar tıklamak | Kullanıcıya iki teslimat görünür | Post-koşul sağlanmadan tekrar etme (Kural 14) |
| 18 | `cdp_fill`'e "not actionable" deyip geçmek | Sebep çoğu zaman sadece viewport | `cdp_scroll({mode:'selector'})` → tekrar dene |
| 19 | `fullPage` screenshot'ı sınırsız çağırmak | 64 MiB tavanı aşar | `CdpScreenshotTooLargeError` → `clip`/`selector` kullan |

---

## 7. Kısa kontrol listesi

### Tur başında
- [ ] `cdp_status` — tarayıcı ayakta
- [ ] `cdp_tabs` → `targetId` seçildi ve **sabitlendi**
- [ ] `cdp_eval(location.href)` → doğru sayfa
- [ ] `cdp_wait` — içerik **görünür** (presence yetmez)
- [ ] `robots.txt` kararı verildi ve **kullanıcıya bildirildi**

### Tur içinde
- [ ] Her spec'te `count` alanı var
- [ ] `complete` okundu; `false` ise `missing`/`truncatedFields`/`warnings` okundu
- [ ] `limit` tavanı (200) farkındalığı
- [ ] `seen` kümesi güncel; mükerrer atıldı
- [ ] Derinlik sayacı çalışıyor

### Tur sonunda
- [ ] Her mutasyonun **geri okuması** yapıldı
- [ ] JSONL satırı yazıldı (`overwrite:true` ile)
- [ ] Döngü **kimlik** ile durdu, düğme durumuyla değil
- [ ] Eksik/kesik varsa **kullanıcıya bildirildi**
- [ ] `cdp_expect`/screenshot kanıtı rapora eklendi

---

## Test ortamı (ölçüm koşulları)

Bu rehberdeki sayılar ve hata metinleri şu canlı oturumda alınmıştır:
`CDP 0.1.5-rc.2`, viewport 1800×1009 css @dpr2, kullanıcının sekmelerine
**dokunmamak** için `cdp_tab_new({focus:false})` ile açılan kendi sekmesi,
`file://` fikstürleri (üçüncü taraf sağlayıcı **yok**).

Fikstürler: `geliştirme/test/fixtures/zor-dogrulama.html`,
`T8-cok-adayli-zemin.html`, `bot-sinyal-sayfasi.html`, ve bu çalışma için
yazılan `sayfalama-zemini.html` (5 sayfa × 12 kayıt, `window.__probe` ölçüm
kancası, son sayfada bilinçli no-op "Sonraki sayfa").

---

## See also

- [Guide Map](00-map.md#cdp-guide-map) — tüm rehberlerin indeksi.
- [Skill Architecture](10-skill-mimarisi.md#skill-mimarisi--ağ-haritası-akışlar-ve-polimorfizm) —
  **39 aracın "sonrasında ne yapılır" tablosu**, 14 uçtan uca akış (F1–F14) ve
  9 polimorfizm kümesi. Bu rehber *ne* kullanacağını anlatır; o rehber *hangi
  sırayla* kullanacağını.
- [Human Interaction](07-human-interaction.md#layer-c-verification-challenge-roles) — ölçme disiplini ve **Layer C** araç rolleri.
- [DOM and Evaluation](03-dom-and-eval.md#dom-weaving-and-script-evaluation) —
  snapshot örgüleme, ref'ler, sınırlı eval, ve "bu noktada ne var?" probu.
- [Site Adapters](06-adapters.md#polymorphic-site-adapters) — hazır site profilleri.
- [Proxy and Network Analysis](04-proxy-and-analysis.md#proxy-interception-and-analysis) —
  proxy, CA ve yakalama deposu.
- [Workflow Combos](05-workflow-combos.md#workflow-and-automation-combos) —
  uçtan uca kombinasyonlar.
- [Input and Stealth](02-input-and-stealth.md#human-like-input-and-stealth) —
  Bézier hareket, yazma temposu, stealth yamaları.
