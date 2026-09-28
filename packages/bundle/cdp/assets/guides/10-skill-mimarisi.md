# Skill Mimarisi — Ağ Haritası, Akışlar ve Polimorfizm

Bu rehber **katalog değildir**. Katalog zaten var: `09-scraping-master.md` §2
39 aracın tamamını parametreleri, çıktıları ve hata sinyalleriyle anlatır;
SKILL.md §3 ise her araç için tek satırlık bir karar satırı taşır.

Bu rehber, o ikisinin **arasında kalan boşluğu** doldurur:

> **"Şimdi hangi aracı kullandım — bundan sonra hangisine geçmeliyim, ve aynı işi
> yapmanın başka bir yolu varsa neden onu tercih etmedim?"**

Üç bölüm:

- **§1 Araç → sonraki araç tablosu** — 39 aracın her biri için *öncesi* ve
  *sonrası*. Spiderweb'in kenarıdır: model nereye çıktığını bilir.
- **§2 Akış haritası (14 iş akışı)** — hangi araçlar **birlikte** bir iş yapar,
  sırayla ve hangi rehberde. Spiderweb'in örgüsüdür.
- **§3 Polimorfizm kümeleri (9 küme)** — aynı amaca çıkan birden çok yol,
  **hangi durumda hangisine geçilir**. (§3.1–§3.5 rehber 09'un kazıma odaklı
  kollarıyla örtüşür; burada hepsi tek yerde toplanır.)

---

## 1. ARAÇ → SONRAKİ ARAÇ (39/39)

**`öncesi`** = o aracı besleyen araç. **`sonrası`** = çağrıdan sonra mantıklı olan
tek adım. **`◦`** = zorunlu, **`·`** = olası.

| # | araç | öncesi | sonrası |
|---|---|---|---|
| 1 | `cdp_status` | — (giriş noktası) | `cdp_tabs` |
| 2 | `cdp_open` | `cdp_status` · `cdp_endpoints` | `cdp_status` |
| 3 | `cdp_tabs` | `cdp_status` | `cdp_eval(location.href)` · `cdp_tab_focus` |
| 4 | `cdp_navigate` | `cdp_tabs` | `cdp_wait` |
| 5 | `cdp_snapshot` | `cdp_tabs` | `cdp_click(ref)` · `cdp_text(ref)` · `cdp_find` |
| 6 | `cdp_eval` | `cdp_tabs` | `cdp_exec` (kanıt gerekiyorsa) |
| 7 | `cdp_click` | `cdp_find` · `cdp_locate` · `cdp_snapshot` | `cdp_expect` ◦ · `cdp_screenshot` |
| 8 | `cdp_type` | `cdp_click` (odak için) | `cdp_expect` ◦ · `cdp_text` |
| 9 | `cdp_wait` | `cdp_navigate` · `cdp_click` · `cdp_scroll` | `cdp_snapshot` · `cdp_exec` · `cdp_expect` |
| 10 | `net_capture` | — (kullanıcı eylemi) | `cdp_exec(fetch)` · `net_export` |
| 11 | `net_export` | `net_capture` | — (rapor) |
| 12 | `cdp_screenshot` | `cdp_snapshot` | `cdp_locate` ◦ (görsel döngü) |
| 13 | `cdp_viewport` | `cdp_status` | `cdp_find` · `cdp_click` (yeniden ölç) |
| 14 | `cdp_printpdf` | `cdp_wait` | `cdp_readpdf` · `cdp_pdftotext` |
| 15 | `cdp_download` | **`cdp_click`ten ÖNCE** | `cdp_files` · `cdp_readpdf` |
| 16 | `cdp_readpdf` | `cdp_printpdf` · `cdp_download` | `cdp_files` |
| 17 | `cdp_pdftotext` | `cdp_wait` (PDF sekmesi) | — (okuma) |
| 18 | `cdp_files` | `cdp_download` · `cdp_printpdf` | `cdp_readpdf` |
| 19 | `cdp_exec` | `cdp_eval` · `net_capture` | `cdp_expect` · `cdp_extract` |
| 20 | `cdp_tab_new` | `cdp_tabs` | `cdp_tabs` (yeni id'yi sabitle) |
| 21 | `cdp_tab_close` | `cdp_tabs` | `cdp_tabs` |
| 22 | `cdp_tab_focus` | `cdp_tabs` · `cdp_dialog` | `cdp_exec` · `cdp_click` |
| 23 | `cdp_scroll` | `cdp_find` (`inViewport:false`) | `cdp_find` · `cdp_click` · `cdp_expect` |
| 24 | `cdp_dialog` | `dialog-open` reddi | `cdp_expect` (diyalog sonrası) |
| 25 | `cdp_upload` | `cdp_dialog` (chooser açıksa) | `cdp_expect` |
| 26 | `cdp_text` | `cdp_find` · `cdp_snapshot` | `cdp_expect` |
| 27 | `cdp_expect` | **her mutasyon** | (biter) · `cdp_screenshot` (kanıt) |
| 28 | `cdp_endpoints` | "araçlar tarayıcıyı görmüyor" | `cdp_open` |
| 29 | `cdp_contexts` | `cdp_open` | `cdp_tabs` |
| 30 | `cdp_fill` | `cdp_find` · `cdp_scroll` | `cdp_click` (gönder) |
| 31 | `cdp_find` | `cdp_snapshot` | `cdp_click` ◦ · `cdp_scroll` · `cdp_expect` |
| 32 | `cdp_extract` | `cdp_wait` | `cdp_expect` · `cdp_files` |
| 33 | `cdp_stealth` | `cdp_fingerprint` | `cdp_navigate` (tekrar dene) |
| 34 | `cdp_fingerprint` | engellenme belirtisi | `cdp_stealth` · `cdp_captcha(scan)` |
| 35 | `cdp_captcha` | `cdp_fingerprint` · şüpheli sayfa | `cdp_expect` · (üçüncü taraf ise **raporla**) |
| 36 | `cdp_locate` | `cdp_screenshot` | `cdp_click` |
| 37 | `cdp_lock` | `cdp_tabs` (hedef seç) | yazma sırası → `cdp_unlock` |
| 38 | `cdp_unlock` | `cdp_lock` (iş bitti) | serbest oturum |
| 39 | `cdp_profiles` | `cdp_status` (envanter) | `cdp_open` (profile:…) ◦ · `cdp_status` |

> **Kural:** Tablodaki `sonrası` sütunu **isteğe bağlı bir öneridir**, zorunlu bir
> adım değil — ama "şimdi ne yapacağım" sorusunun cevabıdır. Boş bırakılan tek
> hücreler terminal araçlardır (`net_export`, `cdp_pdftotext`, `cdp_tabs`).

### 1.1 Sekme güvenliği (her turun başı ve sonu)

```
cdp_tab_new({ url, focus: false })   →  cdp_tabs → yeni targetId'yi SABİTLE
                                       →  her sonraki çağrıda targetId
```

---

## 2. AKIŞ HARİTASI — 14 iş akışı

Her akış **gerçek bir iş** için, gereken araç zinciriyle. `◦` = doğrulama adımı.

### F1 · Tarayıcıyı bul / bağlan
```
cdp_endpoints({ ports })   → hangi port gerçekten açık?
cdp_status                 → bağlı mıyım?
cdp_open                   → needsChoice:true gelirse DUR, tabloyu kullanıcıya göster
```
**Ne zaman:** "`cdp_*` çağrıları tarayıcıyı göremiyor", ilk çağrıda hata.
**Rehber:** 09 §2.1 · **Meydan okuma içermez** — sadece bağlantı.

### F2 · Hedef sabitleme (her turun başında, ZORUNLU)
```
cdp_status                 → ayakta mı
cdp_tabs                   → targetId'yi SEÇ (her çağrıda geç)
cdp_eval({ expression: 'location.href', targetId })   → doğru sayfa mı
cdp_tab_new({ url, focus: false })  → kendi sekmen (opsiyonel ama önerilen)
```
**Ne zaman:** her tur, sıfırdan.
**Rehber:** 09 §4.0 · **Atlanırsa:** yanlış sekmeye yazma (SKILL.md §2.2).

### F3 · Sayfaya git ve "hazır" olduğunu KANITLA
```
cdp_navigate({ url, targetId })
  → cdp_wait({ strategy: 'visible', selector: '#ana-kutu' })   ◦
  → cdp_exec({ expression: 'document.readyState',
               postCondition: 'document.readyState === "complete"' })   ◦
```
**Ne zaman:** her `cdp_navigate` sonrası.
**Rehber:** 09 Kural 16 · **Atlanırsa:** `chrome-error://` üzerinde sessiz veri.

### F4 · Öğe bul → eyleme uygunluğunu kanıtla → tıkla → doğrula
```
cdp_snapshot({ targetId })                     → @ref kütüphanesi
cdp_find({ selector: '#v2-thumb', targetId })  → ref + taze kutu + coveredBy/inViewport
  ├─ inViewport:false → cdp_scroll({ mode:'selector', selector:'#v2-thumb' }) → cdp_find TEKRAR
  └─ coveredBy        → örtüyü kaldır (cookie banner, sticky header) → cdp_find TEKRAR
cdp_click({ ref: '…' , targetId })
cdp_expect({ check:'visible'|'textContains', expected:'…', targetId })   ◦
```
**Ne zaman:** DOM bir sorguya cevap veriyorsa — **varsayılan yol**.
**Rehber:** 07 §1 · 09 §4.2

### F5 · GÖRSEL DÖNGÜ — DOM cevap vermiyorsa
```
cdp_screenshot({ selector|clip, rects: true, annotate: true, inline: true })
  → görüntü + üzerine çizilmiş kutular + deviceScaleFactor
  → model bir nokta adlandırır (görüntü px → CSS px dönüşümü)
cdp_locate({ x, y, targetId })     ◦  ← BU ADIM ATLANMAZ
  ├─ ok:false + nearest + mesafe  → yeniden nişan al
  ├─ inViewport:false             → cdp_scroll({mode:'bottom'}) → tekrar cdp_locate
  └─ coveredBy                    → örtüyü kaldır → tekrar cdp_locate
cdp_click({ x, y, targetId })
cdp_expect({ … })   ◦
```
**Ne zaman:** `<canvas>`, ikon-only düğme, shadow-DOM, erişilebilir adı olmayan
kontrol, özel ızgara.
**Rehber:** 07 §1b · 03 "When the DOM has no name for it" · 09 §5
**Neden iki adım:** `cdp_click` isabet etmese bile `ok:true` der. Yanlış nişanın
bedeli **bir ucuz geri okuma** olsun, geri alınamaz bir tıklama değil.

### F6 · Form doldur ve doğrula
```
cdp_fill({ css:'#kullanici', value:'…', verify:true, targetId })
cdp_fill({ css:'#sifre',   value:'…', verify:true, targetId })
cdp_click({ css:'#gonder', targetId })
cdp_expect({ check:'textContains', expected:'Çıkış', timeoutMs:15000 })   ◦
```
**Ne zaman:** `<form>` gönderimi, arama kutusu, her metin alanı.
**Rehber:** 09 §4.5 · 07 §6
**Tuzak:** `not actionable` çoğu zaman **viewport'tur** → `cdp_scroll({mode:'selector'})`
sonra aynı `cdp_fill` (09 §2.3, ölçülmüş).

### F7 · Doğrulama meydan okuması — ÜÇ ADIM, SIRAYLA
```
cdp_captcha({ action:'scan', targetId })
  ├─ found:0 + reason → sayfada yok, normal devam
  ├─ thirdParty.verdict === 'third-party-present'  → *** RAPORLA, ADAYLARLA DEVAM ET ***  (üçüncü taraf)
  └─ found:true → kind + hitTest + blockedBy oku → SINIFLA
      ├─ checkbox        → cdp_click(kutu)              → cdp_captcha({action:'verify'})
      ├─ form-field      → cdp_fill(alan)               → cdp_captcha({action:'verify'})
      ├─ slider          → cdp_captcha({action:'drag'}) → cdp_captcha({action:'verify'})
      ├─ delayed-confirm → cdp_wait({strategy:'visible'}) → cdp_click → verify
      └─ decoy / visible-honeypot / unknown  → DOKUNMA, sınıfı raporla
```
**Ne zaman:** oturum açma, form gönderme, yorum/mesaj gönderme.
**Rehber:** 07 §6 (tam metin) · 09 §2.5
**Mekanizma:** cross-origin sağlayıcı frame'i sayfa bağlamından okunmaz; tarama same-origin adaylarla devam eder, üçüncü taraf bulgusu raporlanır (07 Layer C).

### F8 · Slider
```
cdp_captcha({ action:'scan' })                              → track'i ve thumb'ı tanı
cdp_captcha({ action:'drag', css:'#v2-track', targetPct:72, targetId })
   ├─ delivered:true  → geçti (matched:true ima edilir)
   └─ delivered:false → BOŞUNA TEKRAR ETME; cdp_captcha({action:'verify'}) ile oku
cdp_captcha({ action:'verify', targetId })                   ◦
```
**Ne zaman:** `input[type=range]`, özel slider widget'ları, "kaydır ve bırak" aşamaları.
**Rehber:** 07 §3 (K1–K6 sırası) · 09 §2.5
**`cdp_click` neden yetmez:** tek bas-kaç yapar; sürükleme ara basit hareket ister.
Sayfa içi `dispatchEvent` **asla**: `isTrusted:false` üretir.

### F9 · Yapılandırılmış veri çıkar
```
cdp_extract({ spec:{ kind:'page',  fields:['title','url','h1','lang'] } })
  ├─ complete:false → missing[] / truncatedFields[] / warnings OKU
  └─ devam:
cdp_extract({ spec:{ kind:'list', from:{selector:'#govde tr'},
                     fields:{ id:'attr:data-id', toplam:'count' }, limit:200 } })
cdp_expect({ check:'textEquals', expected:'Sayfa 2 / 5' })   ◦
```
**Ne zaman:** tekrarlı yapı, tablo, liste, kart — kazımanın omurgası.
**Rehber:** 09 §2.2 · 09 §4.1–4.4 · 09 §4.9
**İki zorunlu:** `count` alanını **her** spec'e ekle (Kural 1); `complete:false`
gördüğünde **sessiz geçme** (09 Kural 1 + 09 §4.9).

### F10 · Çok sayfalı döngü (9 parça — eksiksizini 09 §4.6'da oku)
```
cdp_wait(visible) → cdp_extract(count) → [kimlik farkı?] → cdp_files(JSONL)
  → [derinlik < 20?] → cdp_expect('Sayfa N+1') ◦ → cdp_click(#next) → TEKRAR
```
**Durma sinyali: düğme değil, KİMLİK.** Son sayfada `ok:true` + `enabled:PASS`
olmasına rağmen veri yerinde kalabilir (ölçülmüş kanıt, 09 Kural 3).
**Rehber:** 09 §4.6

### F11 · Veri DOM'da yok, ağda
```
net_capture({ host, limit:50 })   → gerçek veri kaynağını bul
cdp_exec({ expression: 'fetch("<url>", { credentials:"include" }).then(r=>r.json())',
           awaitPromise:true, postCondition:'…' })
```
**Ne zaman:** liste sayfası 3 satır gösterip arka planda 200 kayıt çekiyorsa.
**Rehber:** 09 §2.5, §5
**Asla:** `document.cookie`'yi yeniden göndermek (HttpOnly taşınmaz, 401 üretir).

### F12 · PDF / indirme zinciri
```
cdp_wait(visible) → cdp_printpdf({ pageRanges:'1-5', saveTo })   (arşiv)
   ya da
cdp_download({ timeoutMs:60000 })  ◦ ÖNCE başlat → cdp_click(indir)  → cdp_files({op:'list'})
   → cdp_readpdf({ path, pages:'1-5' })     (diskteki dosya)
   → cdp_pdftotext({ strategy:'auto' })    (sekmede AÇIK olan PDF)
```
**Rehber:** 09 §2.4, §4.8
**Sıra tuzağı:** `cdp_download` çağrısı indirmenin *başlamasını* bekler — **önce**
çağır, **sonra** tıkla. Tersi 60 sn zaman aşımıdır.

### F13 · Engellenme teşhisi
```
sayfa reddediyor
  → cdp_fingerprint({ targetId })        → whyBlocked[] (critical→low, layer + evidence)
     ├─ tutarlı görünüyor, yine de reddediliyor → kullanıcıya kanıtıyla BİLDİR
     └─ sapma var → cdp_stealth({ action:'apply', profile:'…' })
                    → cdp_navigate/tekrar dene
                       → hâlâ engellendiyse → DUR + cdp_screenshot kanıtı
```
**Sıra SABİTTİR:** `cdp_fingerprint` → `cdp_stealth` → tekrar (09 Kural 9).
Stealth'i önce uygulamak, sorunu ölçmeden ayarlamaktır.
**Rehber:** 07 §6 + Layer C · 09 §2.5

### F14 · Diyalog kilidi
```
bir sayfa aracı "dialog-open" ile reddedildi
  → cdp_dialog({ action:'list', targetId })      → pending hangi türde?
  → cdp_dialog({ action:'accept'|'dismiss', targetId, promptText? })
  → cdp_expect(…)   ◦  (diyalog gerçekten kapandı mı)
```
**Not:** `action` verilmezse varsayılan `list` yalnız **gösterir** — diyaloğu
cevaplamaz. `policy` ile gelecekteki diyaloglar için otomatik yanıt kurulabilir.
**Rehber:** 09 §2.3

---

## 3. POLİMORFİZM KÜMELERİ — aynı iş, birden çok yol

Her küme: **yollar** · **varsayılan** · **ne zaman geçersin**.

### 3.1 Bir öğeyi bulma — 9 yol

| # | Yol | Ne zaman tercih edilir |
|---|---|---|
| 1 | `cdp_snapshot` → `ref` | Yapıyı **keşfediyorsun**; sayfayı tanımıyorsun |
| 2 | `cdp_find({ selector })` | Bir CSS karşılığı **vardır** — en ucuz yol |
| 3 | `cdp_find({ css })` | `selector` ile aynı; `cdp_click`/`cdp_text` sözdizimiyle uyum istersen |
| 4 | `cdp_find({ role, name })` | Erişilebilirlik ağacı doğru (`button`, `link`, `cell`, `row`) |
| 5 | `cdp_find({ ariaLabel })` | Yalnız `aria-label` taşıyan ikon-only düğmeler |
| 6 | `cdp_find({ text, textMatch })` | Görünen metin tekil ayırt ediciyse (`contains` ile kısmi) |
| 7 | `cdp_find({ scope, nth })` | Aynı metin **birden çok** kez geçiyor — `scope` alt ağacı daraltır |
| 8 | `cdp_locate({ x, y })` | **Hiçbir sorgu yok** — noktadan noktaya |
| 9 | `cdp_screenshot` → model → `cdp_locate` | Canvas, gölge-DOM, çizgi-ikon, adı olmayan kontrol |

**Geçiş kuralları:**
- `matched: 0` → sorguyu **genişlet** (2→4→6→7). "Yok" demek, "bu seçici tutmadı"
  demektir.
- `>1 match` + `warnings` → `nth` veya `scope` ile daralt (7). Kırpması **5** adaydır;
  5'ten fazlasını bir seferde **göremezsin** (`src/locator.ts:423` `MAX_REPORT`).
- `inViewport:false` → `cdp_scroll({mode:'selector'})` → **yeniden ölç** (koordinat
  taşıma, 09 Kural 7).
- `coveredBy` → örtüyü kaldır, **sonra** yeniden ölç. `cdp_find`'in `coveredBy` ile
  `cdp_locate`'ın `coveredBy`'si **aynı alan adı ve aynı anlamdadır** — tek kural.
- Hiçbiri tutmuyorsa → **9'a geç.** Seçici tahmin etme.

**Rehber:** 07 §1 · §1b · 03 · 09 §2.2

### 3.2 Sayfayı bekleme — 5 yol

| # | Yol | Ne zaman |
|---|---|---|
| 1 | `cdp_wait({strategy:'visible'})` | **Varsayılan.** "Kullanılabilir mi?" |
| 2 | `cdp_wait({strategy:'css'})` | Yalnız DOM'da **var olması** yeterli (`display:none` de geçer!) |
| 3 | `cdp_wait({strategy:'text'})` | Belirli bir metin görünene kadar |
| 4 | `cdp_wait({strategy:'url'})` | URL kalıbı (`/page=\d+`) değişene kadar |
| 5 | `cdp_wait({strategy:'network-idle'})` | Trafik **dursun** — sürekli akan sayfada **asla** |
| 6 | `cdp_expect({ timeoutMs })` | Beklerken de doğrular: "bekle **ve** şunu doğrula" |
| 7 | `cdp_exec` ile elle polling | Son çare — `postCondition` ile kanıtlanır |
| 8 | `cdp_scroll({ settleMs })` | Kaydırma sonrası yerleşim otursun |

**Geçiş kuralları:**
- `presence ≠ visibility`: `css` bir `display:none` katmanı **geçirir**. "Kullanılabilir"
  sorusuna yalnız `visible` cevap ver (09 §2.2).
- `network-idle` sessiz penceresi **500 ms**; polling/reklam varsa hiç olmaz →
  `visible`'a geç.
- **Asla** tahmini uyku (`cdp_sleep` **yok**). "Bir saniye bekledim" = sessiz veri kaybı.

### 3.3 Kaydırma — 5 yol

| # | Yol | Ne zaman |
|---|---|---|
| 1 | `cdp_scroll({ mode:'selector', selector })` | **Varsayılan** — belirli bir öğeyi görünür yap |
| 2 | `cdp_click({ css })` | Locator çözümlemesi **kendi `scrollIntoView`'unu yapar**; hedef dışarıdaysa bile çalışır |
| 3 | `cdp_scroll({ mode:'bottom' })` | Sonsuz kaydırma — **derinlik sınırı ile** (09 §4.6) |
| 4 | `cdp_scroll({ mode:'wheel'\|'pagedown'\|'pageup' })` | İnsan temposu, davranış kalitesi |
| 5 | `cdp_scroll({ mode:'anchor' })` | `#çapa` atlama |

**Geçiş kuralı:** `cdp_find` `inViewport:false` dediyse → **1**. Dönen `scrollY`
bir **ölçümdür**, varsayımın değil.

### 3.4 Alana yazma — 4 yol

| # | Yol | Ne zaman |
|---|---|---|
| 1 | `cdp_fill` | **Varsayılan.** Doğrulamalı; React/Vue-safe; `fallbackUsed` bildirir |
| 2 | `cdp_type` | Odak **zaten** doğruysa ve tuş vuruşu istiyorsan; **mevcut içeriğin sonuna ekler** |
| 3 | `cdp_exec` + native setter | Toplu/yapılandırılmış yazma; `postCondition` ile kanıtla |
| 4 | `cdp_upload` | `input[type=file]` — `cdp_fill` dosya input'una **asla** yazmaz |

**Geçiş kuralı:** `cdp_fill` `not actionable` derse sebebi çoğu zaman **viewport**;
`cdp_scroll({mode:'selector'})` + aynı çağrı (ölçülmüş, 09 §2.3). Alanı
**değiştirmek** istiyorsan `cdp_type` değil `cdp_fill(clear:true)`.

### 3.5 Veri okuma — 8 yol

| # | Yol | Ne zaman |
|---|---|---|
| 1 | `cdp_extract` | **Varsayılan.** Tekrarlı yapı, tablo, liste, sayfa meta'sı |
| 2 | `cdp_text` | Tek bir öğenin görünen metni |
| 3 | `cdp_snapshot` | Yapıyı **keşfetmek** — okumak değil |
| 4 | `cdp_eval` | Hesap/okuma; 16 KiB bütçesine uyan küçük sonuçlar |
| 5 | `cdp_exec` | Oku **ve** etkisini kanıtla |
| 6 | `net_capture` | Sayfanın **kendi** veri kaynağı (API) |
| 7 | `cdp_readpdf` / `cdp_pdftotext` | PDF (diskte / ekranda) |
| 8 | `cdp_screenshot` | **Görsel** kanıt — metin değil |

**Geçiş kuralları:**
- Metin verisi istiyorsan `cdp_screenshot` **her zaman** daha büyük ve daha
  belirsiz; `cdp_extract` önce.
- `cdp_eval` boş döndüyse ifade **sessizce yutulmuş exception**'dır:
  `try{…}catch(e){return 'ERR:'+e.message}` ile sarmala.
- 16 KiB'yi aşıyorsa `truncated` görürsün — `cdp_extract` + `limit`e geç.
- PDF ekrandaysa `cdp_pdftotext`, diskteyse `cdp_readpdf`.

### 3.6 Tıklama adresleme — 7 yol

`x/y` · `ref` · `css` · `ariaLabel` · `role`+`name` · `text`(+`textMatch`) ·
`scope`+`nth`

**Kural:** bir çağrıda **tek adresleme modu**. `x/y` ile locator birlikte verilirse
`cdp_click` **reddeder** (`pass either coordinates or a locator, not both`).
**Tercih sırası:** `ref`/`css` > `role`+`name` > `ariaLabel` > `text` > `x/y`.
**`x/y` yalnız** F5 görsel döngüsünden sonra, `cdp_locate` doğrulaması geçtiğinde.

### 3.7 Hata teşhisi merdiveni — `ok:false` aldığında

```
1) Zarfı oku: ok:false + reason + candidates      ← çoğu cevap buradadır, HATA DEĞİLDİR
2) cdp_expect ile yeniden ölç                     ← başarısız assertion veridir, panik sebebi değil
3) cdp_status                                    ← bağlantı / proxy / hedef kayması
4) cdp_endpoints                                 ← "araç var mı, ben göremiyorum"
5) cdp_fingerprint                               ← "sayfa beni neden reddediyor"
6) cdp_stealth({ action:'status' })              ← coherence + hangi katman tutmadı
7) cdp_dialog({ action:'list' })                 ← dialog-open kilidi
8) cdp_captcha({ action:'scan' })                ← doğrulama meydan okuması mı
9) cdp_screenshot({ annotate:true })             ← görsel kanıt (rapor için)
```

> **Bant içi `ok:false` bir araç hatası değil, bir cevaptır.** `cdp_expect`'in
> başarısız assertion'ı, `cdp_find`'in 0 eşleşmesi, `cdp_locate`'ın boş noktası,
> `cdp_extract`'in `complete:false`'ı — hepsi **bilgi**. Önce **oku**, sonra tekrar dene.

### 3.8 Sekme izolasyonu — 4 yol

| Yol | Ne zaman |
|---|---|
| `cdp_tab_new({ focus:false })` | **Varsayılan** — kullanıcının sekmelerine dokunmadan kendi sekmen |
| `cdp_open({ profile:'assistant' })` | **Kalıcı, giriş yapılmış** oturum (`$DSH_HOME/profiles`) |
| `cdp_contexts({ action:'create'\|'open' })` | **Temiz çerez**; oturum bulaşması olmasın |
| `cdp_contexts({ action:'dispose' })` | İş bitti — sekmeleri kapat, depoyu sil |

**Kural:** İzolasyon seviyesini **yükselt** (yeni sekme → context → kalıcı profil);
gerektiğinden ağır olan seviye gereksiz gizlilik ve gereksiz sürektir.
Kilit `Singleton*` bulunursa `cdp_open` **sessizce geçici profile düşmez** —
çünkü yeni profil "giriş yapılmamış" görünür (09 §4.5).

### 3.9 Kanıt biçimi — 5 yol

| Yol | Ne zaman |
|---|---|
| `cdp_expect` | **En ucuz** — metin/durum iddiası |
| `cdp_screenshot` | Görsel kanıt (rapor, "gördüğünü kanıtla") |
| `cdp_readpdf`/`cdp_pdftotext` | Doküman kanıtı |
| `net_export` | Trafik kanıtı (kimin ne konuştuğu) |
| Rapor metni | Her zaman: *neyi yaptın, hangi gözlemle doğruladın* |

---

## 4. Model için tek sayfalık çalışma düzeni

```
1. cdp_status → cdp_tabs → targetId SABİTLE → cdp_eval(location.href)
2. İşi seç → akışı seç (§2, F1–F14) → araç zincirini izle
3. Her mutasyondan sonra: cdp_expect (en ucuz doğrulama)
4. Takıldıysan: ok:false reason → §3.7 teşhis merdiveni
5. Bitirdiğinde: kanıtı oku ve kullanıcıya söyle (§3.9)
```

---

## See also

- [Guide Map](00-map.md#cdp-guide-map) — tüm rehberlerin indeksi.
- [Scraping Master](09-scraping-master.md#web-kazıma-ustalığı--mevcut-araç-setinin-tam-kullanım-kılavuzu)
  — 39 aracın tam parametre/çıktı/hata envanteri ve kanıtla öğrenilmiş 17 kural.
- [Human Interaction](07-human-interaction.md#human-interaction-and-verification-challenges)
  — ölçme disiplini, görsel döngü, slider protokolü ve **Layer C** araç rolleri.
- [DOM and Evaluation](03-dom-and-eval.md#dom-weaving-and-script-evaluation) —
  snapshot örgüleme, ref'ler, sınırlı eval ve "bu noktada ne var?" probu.
- [Workflow Combos](05-workflow-combos.md#workflow-and-automation-combos) —
  uçtan uca kombinasyonların mimari arka planı.
- [Proxy and Network Analysis](04-proxy-and-analysis.md#proxy-interception-and-analysis) —
  proxy, CA ve yakalama deposu.
- [Input and Stealth](02-input-and-stealth.md#human-like-input-and-stealth) —
  Bézier hareket, yazma temposu, stealth yamaları.
- [Site Adapters](06-adapters.md#polymorphic-site-adapters) — hazır site profilleri.
- [Protocol Core](01-protocol-core.md#protocol-core-architecture) — taşıma katmanı.
