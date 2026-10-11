# CDP PLUGIN PUAN KARTI — araçlar, klavuzlar, kod blokları

**Kapsam:** `packages/bundle/cdp` (sürüm `0.1.5-rc.2`) + onu süren `cdp-browser-control` skill seti (`assets/skill/SKILL.md` + `assets/guides/*.md`)
**Yöntem:** Her puan bir ölçüme dayanır; dayanağı olmayan puan verilmez. Skorlar `path:line` kanıtı taşır.
**Yarışan denetleyici:** `pnpm vitest run packages/bundle/cdp/tests` → **71 dosya / 1017 test, tamamı yeşil (5,22 sn)**.

> Bu, `SKILL-AUDIT-RAPORU.md` (manifesto ↔ eklenti denetimi) ve `SKILL-KIT-ANALIZI.md` (yöntem kiti denetimi) çalışmalarının devamıdır. O iki rapor **bulgu** üretti; bu rapor **puan** üretir. Aşağıdaki ölçümler o raporlardan farklıdır: yüzey o raporlar yazıldığından büyümüştü (36 → 42 araç, 11 → 12 dosya) ve puanlama bu güncel yüzey üzerinden yapılmıştır.

---

## 0. ÖLÇÜLEN YÜZEY (tazelenmiş)

| Ölçüm | Değer | Nasıl ölçüldü |
|---|---:|---|
| Kayıtlı model aracı | **42** (40 `cdp_*` + `net_capture` + `net_export`) | `src/tools.ts` + `src/status.ts` üzerinde `name: '...'` taraması |
| Çalışma zamanı kataloğu | **42** | `cdp_status` → `CDP 0.1.5-rc.2`; araç listesi oturum kataloğuyla birebir |
| Sistem istemi iddiası | **42** ("42 tools in all — 40 `cdp_*` plus `net_capture`/`net_export`") | `src/index.ts` prompt bölümü ↔ oturum araç listesi sayımı |
| Kaynak ↔ çalışma zamanı ↔ istem | **üçü de tutarlı** | yukarıdaki üç satır |
| Skill dosyası | 12 (1 gövde + 11 rehber) | `assets/**` envanteri |
| Araç başına karar-tablosu satırı | **42/42** | `SKILL.md` §3 tablosunda ada göre satır sayımı |
| SKILL.md'de adı geçmeyen araç | **0** | kesiksel arama |
| Hiçbir test dosyasında adı geçmeyen araç | **5** (`cdp_lock`, `cdp_unlock`, `cdp_profiles`, `cdp_raw`, `cdp_deep_click`) | 74 test dosyası taranmadan |

**Katalog ayak izi:** 42 kaydın toplam kaynak genişliği **217.523 karakter** — yani model her oturumda bu aracın ~217 KB şemasını taşıyor. Bu, klavuzun değerini belirleyen ana değişkendir: katalog zaten büyük, kılavuzun işi **katalogun söyleyemediğini** söylemek.

**Çalışma zamanı kayması (önceki raporun 9. maddesi) kapandı:** `cdp_locate` artık hem kaynakta hem çalışma zamanı kataloğunda var. `cdp_status` canlı yanıt verdi (`0 target(s), proxy active: true`) — eklenti bu oturumda gerçekten yüklü.

---

## 1. PULLAMA ÇERÇEVESİ

### 1.1 Araç eksenleri (her araç 0-10, ağırlıklı toplam /10)

| Eksen | Ağırlık | Ölçülen şey |
|---|---:|---|
| **A1 Açıklama netliği** | 20 | Ne yaptığı, **ne zaman** kullanılacağı (komşularından ayrımı), ne döndürdüğü, belirsiz sonucu nasıl okunur |
| **A2 Şema hijyeni** | 20 | Kardeş araçlarla parametre adlandırma tutarlılığı (`css`/`selector`, `ariaLabel`, `role`+`name`, `text`/`textMatch`, `nth`, `scope`, `ref`, `targetId`, `timeoutMs`), zorunlu/opsiyonel dürüstlüğü, varsayılanların yazılması, hayalet parametre yokluğu |
| **A3 Hata semantiği** | 20 | Başarısızlık `ok:false` + sebep + kurtarma yolu mu, yoksa throw mu; ret (guard) açıklanıyor mu |
| **A4 Kanıt/verifikasyon** | 20 | Dönen yük etkinin **gerçekten gerçekleştiğini kanıtlıyor mu** (read-back, `actionability`, `coveredBy`, hit telemetrisi, sayaç) |
| **A5 Kılavuz kapsamı** | 10 | SKILL.md'de kendi karar satırı + rehberden erişilebilirlik + belge/kod kayması |
| **A6 Test ve kapı desteği** | 10 | Kaç test bu aracı adıyla anıyor, hata yolları kapsanıyor mu, şema/ifade kelimesi guard'ı var mı |

### 1.2 Kılavuz eksenleri (her dosya 0-10)

| Eksen | Ağırlık |
|---|---:|
| **G1 Kaynağa göre doğruluk** (parametre/enum/çıktı iddiaları `src/tools.ts` ile uyuşuyor mu) | 30 |
| **G2 Karar değeri** (ne yapılacağını söylüyor mu, araç tanımını tekrar etmek yerine) | 30 |
| **G3 Gezinilebilirlik** (TOC, çalışan bağlantı/çapa, kısmi okunabilirlik) | 15 |
| **G4 Kanıt temeli** (kurallar olay/tarih/konumla mı bağlı) | 15 |
| **G5 Bütçe ve örtüşme** (her olgu tek yerde; 09 ile tekrar yok) | 10 |

### 1.3 Kod bloğu eksenleri

**C1 İmza doğruluğu (40)** — blokta geçen araç adı, parametre adı, enum değeri gerçekten var mı.
**C2 Çalıştırılabilirlik (30)** — kopyalanıp yapıştırılınca eksiksiz çalışır mı.
**C3 Değer (30)** — araç açıklamasının söylemediği bir şeyi öğretiyor mu.

---

## 2. DOĞRUDAN ÖLÇÜLEN BULGULAR (ana döngüde doğrulandı)

### 2.1 SKILL.md §1 niyet sınıflandırması 42 aracın yalnızca 20'sini kapsıyor — **en yüksek öncelikli kusur**

`SKILL.md:41-49` üç kova tanımlıyor: salt-okunur, koordinasyon, değiştirici. Kova sayısı ölçüldü:

| Kova | Satır | Araç sayısı |
|---|---|---:|
| Salt-okunur | `SKILL.md:41-44` | 12 |
| Koordinasyon (sayfa değiştirmez) | `SKILL.md:45-46` | 2 |
| Değiştirici | `SKILL.md:47-49` | 9 (bazıları koşullu) |
| **Kovasız kalan** | — | **22** |

Kovasız 22 araç: `cdp_contexts`, `cdp_deep_click`, `cdp_describe`, `cdp_dialog`, `cdp_download`, `cdp_endpoints`, `cdp_exec`, `cdp_expect`, `cdp_files`, `cdp_pdftotext`, `cdp_printpdf`, `cdp_raw`, `cdp_readpdf`, `cdp_screenshot`, `cdp_scroll`, `cdp_tab_close`, `cdp_tab_focus`, `cdp_tab_new`, `cdp_text`, `cdp_upload`, `cdp_viewport`, `cdp_wait`.

**Neden bu en yüksek kusur:** §2'nin zorunlu kuralı *"Every mutation requires §2 target confirmation + §4 verification"* (`SKILL.md:49`). Kural kapsamını "değiştirici" kovasıyla sınırlıyor, ama **kovada olmayan bir tıklama ve bir sekme kapatma var**: `cdp_deep_click` (gölge-DOM tıklaması — §2'nin tam da uygulanacağı eylem) ve `cdp_tab_close`/`cdp_contexts dispose` (yıkıcı eylemler) hiçbir kovada sayılmıyor. Talimatı harfi harfine uygulayan bir model, `cdp_deep_click` çağırırken §2'yi atlayabilir.

Not: §3 karar tablosunda bu araçların **tamamı** doğru biçimde belgeli (`cdp_tab_close` reddediş kurallarıyla birlikte). Kusur §3'te değil, **§1'in üç kovası ile §3'ün 42 satırı arasındaki tutarsızlıkta** — yani gövdenin kendi içinde iki farklı sınıflandırma var.

### 2.2 İki dosyada yanlış satır çapraz referansı

`guides/10-skill-mimarisi.md:472` → "§1'deki satır 40–42'nin arkasındaki tuzaklar: gölge körü merdiven, sahte tık, yazım bütçesi" diyor ve `11-derin-tarama.md`'ye bağlanıyor. `11-derin-tarama.md:169` aynı hatayı simetrik olarak tekrarlıyor ("§1 satırları 40–42").

Ölçüm: sözü edilen üç tuzak, `11-derin-tarama.md:16-18`'de (T1/T2/T3 tablosu). Rehber 11'in §1'i `:12-23` aralığında; **40–42. satırlar §2'nin (gölge-DOM gerçeği) içinde**. Rehber 10'un kendi §1'inin 40–42. satırları da (okudum: `10-skill-mimarisi.md:40-42`) akış zinciri tablosunun `cdp_tabs`/`cdp_navigate`/`cdp_snapshot` satırları — üç tuzakla ilgisi yok.

Yani iki okuma da yanlış. Bu, satır numarasıyla yapılan belge içi çapraz referansın ilk örneği; iki dosyada simetrik kopyalandığı için "bir yazım hatası" değil, **çapraz referans kuralının eksikliği**: hiçbir kapı belge-içi satır atıfını doğrulamıyor. `src/captcha.ts:59-71` gibi *kaynak* satır atıfları (`guides/09-scraping-master.md:1135`) ise doğru ve faydalı — sorun yalnızca Markdown-içi atıflarda.

### 2.3 Hiçbir test dosyasında adı geçmeyen 5 araç

74 test dosyası tarandı: `cdp_lock`, `cdp_unlock`, `cdp_profiles`, `cdp_raw`, `cdp_deep_click` hiçbir test dosyasında adı geçmiyor.

Bu beş aracın üçü (`cdp_lock`/`cdp_unlock`, `cdp_profiles`) kilit/yaşam döngüsü mutabakatı yapan araçlar; `cdp_raw` ev kuralını (S7) uygulayan araç. §2'ye göre her mutating araç §2+§4 altında olmalı — `cdp_profiles stop` bir süreç öldürür, `cdp_raw` kullanıcı tarayıcısını kapatmayı reddeder. **Kilitlenen politika ile onu doğrulayan test arasında boşluk var.** (Bu, kaynak-taraması sonucu; doğrulama adı geçmiyor olabilir, davranış adıyla test ediliyor olabilir — alt ajanların okuması sonrası kesinleşecek.)

### 2.4 Paket README'si 42 araçlı yüzeyi ve skill'i hiç anmıyor

`packages/bundle/cdp/README.md` (161 satır, 8.286 karakter): ölçüm — **`42` sayısı yok, `cdp_locate` yok, `cdp-browser-control` skill adı yok.** Depo geleneği (packages/AGENTS.md) paket README'sinin model/bağlam maliyetini belgelemesini ve "Known Limitations" bölümünü şart koşuyor; 42 model aracı taşıyan bir paket için en büyük bakım riski (yüzey büyüyor, README sabit) README'de görünmüyor. Bu, araç seti ile paket dokümantasyonu arasındaki tek ölçülebilir boşluk.

### 2.5 Repo seviyesindeki skill kapısı bu eklentinin skill'ini görmüyor (yeniden doğrulandı)

`scripts/verify-skill-invocation-metadata.ts:32` — kapı yalnız `resolve(root, '.agents/skills')` altını tarıyor, üstelik yalnız `agents/openai.yaml` taşıyan dizinleri. `packages/bundle/cdp/assets/skill/SKILL.md` bu ağacın dışında: onu yalnız paketin kendi beş test dosyası koruyor (`skill-packaging`, `skill-provider`, `skill-frontmatter`, `skill-web`, `skill-registration`).

Bunun pratik sonucu, bu raporun iki büyük bulgusuyla birebir örtüşüyor: **yanlış iddia yazan rehber satırları** (§5.1) ve **ölü bir talimatı üç kez tekrarlayan kılavuz cümleleri** (§3) — ikisi de paket içi kapılardan geçebiliyor, çünkü kapılar "rehber bir aracı **adlandırıyor mu**" sorusunu soruyor, "rehber aracın **davranışını doğru anlatıyor mu**" sorusunu değil. Önceki raporun 3. maddesi ("kapı dar") teyit edildi; bu kez satır referansıyla.

### 2.6 Rehber 11'in kendi puanı (ana döngüde okundu)
| Eksen | Puan | Kanıt |
|---|---:|---|
| G1 Doğruluk | 9,0 | `pierceShadow` bayrağının `cdp_click`/`cdp_fill` ile paylaşıldığı doğru (`:36-40`); tek sınır dürüstçe yazılmış (`:42-44`) |
| G2 Karar değeri | 9,5 | tuzak → kanun → çare üçlüsü (`:14-18`), akış reçetesi (`:136-143`) |
| G3 Gezinilebilirlik | 7,0 | "See also" bloğu iyi; §1'e **yanlış** satır atfı (bkz. 2.2) |
| G4 Kanıt temeli | 8,5 | `:155-163` vaka tablosu gerçek olaylara bağlı |
| G5 Bütçe/örtüşme | 8,0 | `:46-50` blok, kaynaktaki çekirdeğin **özeti** (`/* … */` elipsisli) — çalıştırılabilir değil, C2 düşük |
| **TOPLAM** | **8,4 / 10** | |

Kısa not: bu rehber, "rehber ne anlatmaz, tuzağı anlatır" (:6) dediği şeyi gerçekten yapıyor; SKILL.md'nin §1 görsel döngüsüyle (:55-64) örtüşen bir bölümü var ama farklı iş görüyor (kanun vs. akış).

---

## 3. 🔴 DOĞRULANMASI TEYİT EDİLMİŞ EN AĞIR KUSUR: spill (taşma) çıkışı ölü bir yol

**Bulguyu ben kaynak koddan bağımsız olarak yeniden ölçtüm — teyit edildi.**

`cdp_exec`, `cdp_text`, `cdp_extract` 12.000 karakteri aşan yükü diske yazıp modele bir *spill fişi* veriyor ve **her fişte aynı cümleyi söylüyor:**

> `spill.ts:73` — `[spilled N chars → <yol>; full content on disk — read focused sections with cdp_files]`
> `spill.ts:87` — `SPILLED: <yol> (N chars) — full content on disk; read focused sections with cdp_files.`

**O cümle hayır diyor, çünkü:**

| Ölçüm | Değer | Kanıt |
|---|---|---|
| spill'in yazdığı dizin | `os.tmpdir()/dsh-cdp-spill` | `spill.ts:45-47`, `:96-102` |
| `cdp_files`'ın okuyabildiği tek kök | `<cwd>/.dsh/cdp-downloads` | `downloads-dir.ts:16`, `:24-28` |
| Kökün tmpdir ile ilişkisi | "deliberately **never** under `os.tmpdir()`" | `downloads-dir.ts:7-8` (kodun kendi yorumu) |
| Kök dışına çıkan yol | `CdpPathEscapeError` — **her platformda**, sembolik bağ/junction dahil | `downloads-dir.ts:103-114` |

Yani **taşan içerik diskte duruyor ama modelin onu okuyacağı araç o dosyayı adresleyemiyor.** Kılavuzun kendi ifadesiyle: yük 12k'yı geçtiği anda, yani modelin veriye en çok ihtiyaç duyduğu anda, kılavuz "git ve oku" diyor ve çağrı `cdp: path escapes downloads root` ile reddediliyor.

**Yayılma alanı:** bu talimat tek bir yerde değil — `spill.ts:73`, `spill.ts:87`, `cdp_exec`/`cdp_text`/`cdp_extract` araç açıklamaları ve **SKILL.md'nin üç karar-tablosu satırında** tekrarlanıyor. Yani hata yalnız kodda değil, kılavuzda da; bir model önce kılavuzu okuyup sonra çağrıyı deniyor ve iki kez yanlış yöne gidiyor.

**Bunun puanlama anlamı:** "Kılavuz, aracın söyleyemediğini söyler" tezi bu noktada tersine dönüyor — kılavuz, **aracın ulaşamadığı** yeri okunur kılıyor. Aracın kendi ölçülen sözleşmesi (`cdp_files`: "Paths escaping the root are rejected") ile kılavuzun verdiği talimat çelişiyor.

**İkincil (alt ajan okuması, benim teyitim sınırlı):** `cdp_text`'te bu yol **iki kez** ölü — `maxChars` 4.000 ile sınırlanıyor (`locator.ts:32`, `:408-411`) ama spill eşiği 12.000 (`spill.ts:17`); yani `cdp_text` hiçbir zaman spill üretemez, açıklamasındaki "Text over 12k chars spills to disk" cümlesi yapısal olarak yanlıştır.

**Kapı neden kaçırdı (ölçtüm):** `tests/spill.spec.ts` yazıcıyı **enjekte ediyor** — sahte yazıcı `{ path: '/spill/<name>', chars }` döndürüyor (`:20`) — ve yalnız dosya adı/zarf matematiğini doğruluyor (`:25-56`) ile alan denetimini (`:58-94`). Gerçek yazıcıya (`writeSpillFile`) ve dolayısıyla **yolun `cdp_files` tarafından okunabilirliğine** hiç dokunulmuyor. Dikiş test edilmiş, **gidiş-dönüş** test edilmemiş. Yani bu bir "kapı yok" kusuru değil, "kapı yanlış yere baktı" kusuru — ve repo seviyesindeki skill kapısının da göremediği yer tam olarak burası (bkz. 2.5).

---

## 4. ARAÇ PUANLARI — OKUMA/ÇIKARMA KOLU (16 araç)

Kaynak: bağımsız alt ajan okuması; her puan `path:line` kanıtı taşır. Test sayıları **spec dosyalarından okundu, çalıştırılmadı** (koşumun kendisi §0'daki 1017/71 yeşil).

| Araç | A1 | A2 | A3 | A4 | A5 | A6 | **TOPLAM** | Tek cümlelik hüküm |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `cdp_locate` | 10 | 9 | 10 | 9 | 10 | 10 | **9,6** | Kolun en iyisi; tek leke: render Türkçe (`locate.ts:550-551`) |
| `cdp_viewport` | 10 | 8 | 9 | 10 | 9 | 10 | **9,3** | `unverified` ile "sıfır"ı ayırıyor; ama `/* plan15-viewport */` modele sızıyor (`tools.ts:1663`) |
| `cdp_extract` | 9 | 8 | 10 | 10 | 9 | 9 | **9,2** | Spec protokol öncesi doğrulanıyor; boş sonuç bile `complete:false` |
| `cdp_expect` | 9 | 9 | 9 | 9 | 9 | 9 | **9,0** | Doğrulamanın en ucuz yolu; enum disiplinli |
| `cdp_exec` | 8 | 8 | 10 | 10 | 9 | 8 | **8,9** | `postCondition` doğrulanmamış JS metni — şema dikişi yok |
| `cdp_find` | 9 | 7 | 9 | 8 | 10 | 9 | **8,5** | Kesilme bayrağı yok, `textMatch` yok, `nth` tamsayı değil |
| `cdp_screenshot` | 7 | 6 | 9 | 10 | 9 | 9 | **8,2** | Kanıt tarafı kusursuz; `saveTo` sınırsız ve sessizce üzerine yazıyor |
| `cdp_text` | 7 | 9 | 9 | 7 | 7 | 9 | **8,0** | Şeması temiz, ama spill vaadi ölü (bkz. §3) |
| `cdp_readpdf` | 8 | 6 | 7 | 9 | 9 | 9 | **7,8** | Şifreli belge dürüst veri; `ok` hayalet alan |
| `cdp_eval` | **3** | 5 | 9 | 9 | 9 | 5 | **6,6** | Tek cümlelik açıklama — kolun en kötü A1'i |
| `cdp_pdftotext` | 6 | 5 | **4** | 9 | 8 | 8 | **6,4** | Çıktı şemasında **hiç** hata kolu yok |
| `cdp_files` | 6 | 6 | **4** | 6 | 7 | 8 | **5,9** | Taşma dosyalarını okuyamıyor (§3) |
| `cdp_printpdf` | 6 | 4 | **4** | 7 | 9 | 6 | **5,7** | Bilinmeyen `format`ı **sessizce** düşürüyor |
| `cdp_snapshot` | 6 | 7 | **5** | **4** | 6 | 7 | **5,7** | Test edilmiş kesilme kanıtını **çıktıda atmıyor** |
| `cdp_scroll` | 6 | 6 | **4** | **4** | 7 | 7 | **5,4** | Ölçüm başarısızlığında sıfır'a düşüyor, bayrak yok |
| `cdp_describe` | 7 | 5 | **5** | **4** | 9 | **3** | **5,4** | 2 test / 2 vaka; araç düzeyinde şema-render-hata testi yok |

**Kolun ortalaması: 7,5 / 10.** Dağılım çift modlu: kanıt/verifikasyon tarafında (`cdp_locate`, `cdp_viewport`, `cdp_exec`, `cdp_extract`) çok iyi, **hata semantiği ve kesilme dürüstlüğü** tarafında zayıf. Kolda 6 araçta `ok` alanı **required** ilan edilmiş ama hiçbiri `false` olamıyor (`cdp_printpdf:1774`, `cdp_readpdf:1858`, `cdp_pdftotext:1980`, `cdp_files:2056`, `cdp_scroll:2383`) — yani modele "her zaman başarılı" diyen bir alan verilmiş.

### 4.1 Bu kolun taşıdığı ortak kusurlar (en önemli 5'i)

1. **Ölçülmüş kanıt atılıyor.** `cdp_snapshot` `truncated` / `nodeLimitTruncated` / `textLimitTruncated` / `sizeLimitTruncated` / `counts.totalNodes` alanlarını taşıyor ve `snapshot.spec.ts` bu sınırları test ediyor — ama `tools.ts:649-687` yalnız `nodeCount` raporluyor. 400 düğümü aşan bir sayfa **tam** gösteriliyor. A4 puanlarını çeken şey tam olarak budur.
2. **Uydurma ölçümler.** `cdp_scroll` değerlendirme hatasında sıfır döndürüyor (`service.ts:2709-2719`): `ok:true`, `scrollY:0`, hem `atTop:true` hem `atBottom:true`, bayrak yok. `cdp_describe` ise `.catch(() => undefined)` ile bozuk `targetId`'yi "page did not answer" mesajına çeviriyor (`tools.ts:4047`).
3. **Kesilme bayrağı disiplini yok.** `cdp_find` 10 adayla sınırlıyor (`tools.ts:3083`), `cdp_describe` 12 komşuyla (`locator.ts:767`) — ikisi de sessiz. Aynı sınıftaki kesilmede `cdp_locate` ve `cdp_screenshot` bayrağı **yayınlıyor**. Üç yaklaşım, tek kural yok.
4. **Kütüphane-içi sözcük modele sızıyor.** `tools.ts:1663` açıklamaya `/* plan15-viewport */` yazıyor; `packages/AGENTS.md` "model-facing contracts … only task-relevant concepts" diyor. Tek satırlık ama düzeltmesi bedava.
5. **Belge fazla vaat ediyor.** Araç açıklaması "`cdp_snapshot` … with stable element references and **bounding boxes**" diyor (`tools.ts:458`), rehber 09 da "+ kutu" diyor (`09-scraping-master.md:216`) — ama çıktı şemasında kutu alanı yok (`tools.ts:492-505`) ve render basmıyor (`tools.ts:600`). Yalnız `cdp_find` kutu döndürüyor.

---

## 5. ARAÇ PUANLARI — HEDEF/SEKME/KİLİT KOLU (15 araç)

Kaynak: bağımsız alt ajan okuması. **Ölçüm/tespit maddeleri koddan bağımsız olarak teyit edildi (aşağıda işaretli).**

| Araç | A1 | A2 | A3 | A4 | A5 | A6 | **TOPLAM** | Tek cümlelik hüküm |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `cdp_dialog` | 8 | 7 | 9 | 9 | 9 | 9 | **8,4** | Her hata kodu düzeltme adımı veriyor; kanıt okunabiliyor |
| `cdp_endpoints` | 7 | 9 | 7 | 9 | 9 | 8 | **8,1** | Port başına 9 ölçülmüş sütun; hiç throw etmiyor |
| `cdp_profiles` | 9 | 8 | 9 | 8 | 9 | **3** | **8,0** | En iyi açıklama ve bant içi hata; **tek testi bile yok** |
| `cdp_tab_focus` | 8 | 9 | 6 | 9 | 8 | 8 | **8,0** | `activated` tarayıcının gerçek onayı — kolun kanıt standardı |
| `cdp_open` | 8 | 6 | 9 | 9 | **6** | 8 | **7,8** | `needsChoice` mükemmel; §5 dokümanı artık gerçeği yansıtmıyor |
| `cdp_upload` | 6 | 7 | 9 | 8 | 8 | 9 | **7,7** | `input.verified` read-back güçlü; "izinli kökler" cümlesi varsayılan yanlış |
| `cdp_status` | 7 | 7 | 5 | 8 | 9 | 7 | **7,0** | Tek kaynaklı şema iyi; `ok` hep true, "bağlı değil" anlatılmıyor |
| `cdp_tabs` | 6 | 7 | 6 | 7 | 9 | 9 | **7,0** | `stale` dürüst; `type` enum'suz, yazım hatası boş listeye dönüşüyor |
| `cdp_unlock` | 6 | 5 | 8 | 7 | 9 | 6 | **6,7** | `lockId` required değil; iki reddediş de doğru veri |
| `cdp_download` | 6 | 9 | **3** | 8 | 9 | 7 | **6,8** | Şema temiz, **her hata throw** |
| `cdp_tab_new` | 6 | 8 | 5 | **5** | 8 | 7 | **6,3** | `focused` tarayıcı onayı değil, yerel inanç |
| `cdp_lock` | 5 | 5 | 7 | 6 | 9 | 6 | **6,1** | Kilitleme, varsayılan yolda **işlevsiz** (bkz. 5.2) |
| `cdp_tab_close` | 6 | 8 | **3** | 8 | **4** | 7 | **6,1** | İki guard da throw; **rehber tam tersini söylüyor** (teyitli) |
| `cdp_contexts` | 6 | **4** | **4** | 8 | 7 | 8 | **5,9** | `contextId` açıklaması dispose'da yalan; hiç hata bant içi değil |
| `cdp_navigate` | **3** | 6 | 5 | **3** | 8 | **4** | **4,6** | İstenen URL'i yankılıyor, load timeout yutuluyor, testsiz |

**Kolun ortalaması: 7,0 / 10.** Okuma kolundan (7,5) düşük; düşüşün tamamı iki yerde: **hata semantiği (A3)** ve **kanıt dürüstlüğü (A4)**.

### 5.1 ✅ TEYİTLİ: rehber kodu tersinden anlatıyor — `cdp_tab_close`

Rehber 09, `:146-148`:
> *"Bilinmeyen bir `mode`/`action` gibi **throw** eden bir araç değildir; reddediş `ok:false` + `reason` ile gelir. `cdp_tab_close` koruması bir hatadan çok **kural ihlali bildirisi**dir."*

Kod (`service.ts:2536-2547`) — **ben okudum, iki guard da `throw new Error`:**
- aktif sekmeyi açık `targetId` olmadan kapatma → `throw` (`:2537`)
- son sayfa sekmesini `force` olmadan kapatma → `throw` (`:2543`)

Yani model rehberi izleyip `ok:false` + `reason` beklerken istisna alıyor; rehberin "güvenlik rayı, etrafından dolaşılmaz" dediği korumanın **nasıl geldiğini** yanlış anlatıyor. (SKILL.md'nin §3 satırı bu konuda doğru ve nötr — kusur yalnız rehber 09'da, yani "bir olgu iki yerde, biri yanlış" durumu.)

### 5.2 Kilitleme, beyan ettiği işi varsayılan yolda yapmıyor — `cdp_lock`

`tools.ts:745` hedefi `'targetId' ya da literal '<active>'` olarak anahtarlıyor ve masa yalnız bu dizeye göre indeksliyor (`tab-lock.ts:67`). Açıklamadaki *"defaults to the active tab"* ifadesi gerçekte **aktif sekmenin çözümlenmesi** demek; kod literal bir dize kullanıyor. Sonuç: iki paralel işçi, biri `targetId` vermeden biri vererek lease alırsa **ikisi hiç çakışmaz** — yani "paralel yazıcıları sıraya sok" amacı, en sık kullanılan yolda sessizce tutmuyor. Aynı desen `tools.ts:626`'da ikinci kez.

Bu, "mutasyon kilidi" mekanizmasının varlığıyla yokluğu arasındaki fark değil: **yanlış varsayılanla var olma** farkı. Kilitli olan şey, hedef kimliği değil, verilen dize.

### 5.3 Kalan ortak kusurlar

1. **İnceleme politikası tek pakette üçe bölünmüş:** bant içi hata (`cdp_dialog`, `cdp_upload`, `cdp_lock`, `cdp_unlock`, `cdp_profiles`, `cdp_open`) ↔ yalnız `throw` (`cdp_tab_close`, `cdp_tab_new`, `cdp_tab_focus`, `cdp_contexts`, `cdp_navigate`, `cdp_download`). Tek kayıt dosyası, iki rakip sözleşme ailesi.
2. **Throw eden araçların çıktı şemasında `reason`/`error` alanı yok** (`cdp_contexts:2874-2897`, `cdp_download:1807-1818`, `cdp_tab_close:2297-2309`) — model makinesel-okunur hata kodu alamıyor.
3. **"İstenen" ile "okunan" arasındaki uçuruk:** `cdp_navigate` istenen URL'i yankılıyor (`tools.ts:444`), `cdp_tab_new` istenen URL'i raporluyor (`service.ts:2502`), `focused` yerel bir hesap (`service.ts:2504`). Karşılaştırma: `cdp_tab_focus`'in `activated` alanı gerçekten onaylanmış (`service.ts:2589-2591`). **Pakette kanıt standardı tek değil.**
4. **`cdp_upload` açıklaması ile gerçek yapılandırma çelişiyor:** `allowAnyPath` `true` varsayılan (`index.ts:102`) ve allow-list'i kısa devre ettiriyor (`upload.ts:78`), ama hemen üstündeki JSDoc hâlâ `@default false` diyor (`index.ts:73-77`).
5. **Enum disiplini eksik:** `cdp_dialog.action`, `cdp_contexts.action`, `cdp_profiles.action`, `cdp_tabs.type` — dördü de açık string; `cdp_dialog` ayrıca kontrolsüz `as` dönüşümü yapıyor (`tools.ts:2502`). Karşılaştırma: `cdp_status.connectionState` ve `cdp_endpoints.state` enum'lu.
6. **`cdp_open`'ta öncelik belgelenmemiş ve sessiz:** `switchTo` ile `port` birlikte verilirse `switchTo` düşüyor (`service.ts:975-977`); şema ikisini de ayrı listeliyor.

---

## 6. KOD BLOKLARI — ÖLÇÜM (ana döngü, `assets/**` üzerinde)

| Dosya | Karakter | Satır | Blok | `js/ts` etiketli | Etiketsiz (akış) |
|---|---:|---:|---:|---:|---:|
| `09-scraping-master.md` | 68.403 | 1.284 | 21 | 0 | ~30 |
| `SKILL.md` | 31.966 | 299 | **1** | 0 | 2 |
| `10-skill-mimarisi.md` | 24.514 | 473 | 17 | 0 | ~34 |
| `07-human-interaction.md` | 18.555 | 366 | 6 | 0 | 11 |
| `11-derin-tarama.md` | 7.682 | 174 | 5 | 1 | 9 |
| `03-dom-and-eval.md` | 3.713 | 57 | 1 | 0 | 2 |
| `00-map.md` | 2.962 | 26 | 0 | 0 | 0 |
| `02-input-and-stealth.md` | 1.805 | 23 | 0 | 0 | 0 |
| `01-protocol-core.md` | 1.597 | 21 | 0 | 0 | 0 |
| `05-workflow-combos.md` | 1.451 | 21 | 0 | 0 | 0 |
| `06-adapters.md` | 1.360 | 21 | 0 | 0 | 0 |
| `04-proxy-and-analysis.md` | 1.332 | 20 | 0 | 0 | 0 |
| **TOPLAM** | **165.340** | **2.785** | **51** | **1** | **~48** |

**Bu tablo, "kod bloklarını puanla" sorusunun asıl cevabı ve beklenmedik bir cevap:** 51 bloğun **50'si etiketsiz akış diyagramı**, yalnız **1'i** gerçek kod etiketi taşıyor. Yani bu kılavuz seti bir **kod korpusu değil, karar korpusu**. Doğru puanlama sorusu "blok çalıştırılabilir mi?" değil, **"blokta geçen araç/parametre gerçekten var mı ve akış doğru mu?"**.

Elle doğrulanan örnek (`11-derin-tarama.md:136-151`): `cdp_deep_click({ text: 'Kaydet' })`, `cdp_expect({ check: 'visible', … })`, `cdp_describe(x, y)`, `cdp_raw({ method: 'Network.getAllCookies', targetId })` — dördü de gerçek şemalarla birebir tutuyor. Yani C1 (imza doğruluğu) bu bloklarda yüksek; C2 (çalıştırılabilirlik) ise bu blokların **hedefi değil**, çünkü `…` gibi yer tutucular bir akış şemasında kasıtlı. Puanlama buna göre yapıldı.

**Altı ince rehber (`01,02,04,05,06` + `00-map`) toplam 9.545 karakter ve sıfır blok.** Bu, manifestonun "ince olsun ama boş olmasın" ilkesiyle uyumlu; §2'deki ölçüm, ince olanların gerçekten ince olduğunu gösteriyor.

### 6.1 Blok puanları ve kusur aileleri

| Dosya | Blok | C1 imza | C2 çalıştırılabilirlik | C3 değer | Ağırlıklı |
|---|---:|---:|---:|---:|---:|
| `07-human-interaction.md` | 6 | 9,2 | 9,0 | 6,3 | **8,3** |
| `10-skill-mimarisi.md` | 17 | 8,6 | 7,4 | 7,8 | **8,2** |
| `09-scraping-master.md` | 22 | 8,6 | 6,5 | 7,9 | **7,7** |
| `11-derin-tarama.md` | 5 | 8,4 | 6,4 | 7,0 | **7,4** |
| `03-dom-and-eval.md` | 1 | 9,0 | 7,0 | 5,0 | **7,2** |
| `SKILL.md` | 1 | 9,0 | 4,0 | 5,0 | **6,3** |

Kümeli ölçüm: **52 blok, 1 YAML frontmatter, sıfır kabuk bloğu, sıfır imza bloğu, 52 çitin 31'i dil etiketi taşımıyor** — yani depoda onları sözdizim denetimine sokacak bir şey yok. C1 (imza doğruluğu) ortalama **8,8**: bloklarda geçen araç/parametre adları doğru. C2 düşük çünkü akış şeması yer tutucuları kasıtlı — **bu bir kusur değil, doğru bir tercih**; puanlamayı burada düşük tutmak yanlış olurdu. Asıl sorun C1'in düştüğü iki yerde.

### 6.2 🔴 Blok kusurları — iki aile, ikisi de sistemik

**Aile 1 — `cdp_expect` hiçbir yerde konumlayıcıyla çağrılmıyor (7 yer, 3 dosya).**
`locator.ts:354-357` (okuyarak teyit ettim): konumlayıcı verilmezse `validateLocatorSpec` `'no locator given (pass css, ariaLabel, text, or role+name)'` döndürüyor; `urlMatches` dışındaki tüm kontroller bu doğrulamadan geçiyor. Yerler: `09:962`, `09:983`, `09:1174`, `10:134`, `10:162`, `10:205`, `11:140`.
**Neden bu en ağırı:** SKILL.md §2.6'ya göre doğrulama **zorunlu** adım; bu yedi çağrının her biri bir akışın **tek doğrulama adımı**. Yani kılavuzun "mutlaka doğrula" dediği yerde verdiği örnek, yazıldığı gibi kalıcı olarak başarısız.

**Aile 2 — `cdp_extract`'a nesne `spec` geçiliyor (9 yer) ve kök neden şemada.** ✅ teyitli
`tools.ts:3176-3179`: `spec` → `type: 'string', required: true`. Ama aynı kaydın açıklaması (`:3169-3173`) "`{"kind":"page"}` … `{"kind":"list"}`" biçiminde **çıplak nesneler** gösteriyor; execute string olmayanı boş dizeye çevirip "spec is required" reddi veriyor. Dokümanın dokuz yerini düzeltmek yerine **tek satırlık açıklama düzeltmesi** (`"a JSON **string** containing"`) dokuz yeri birden kurtarır. Yani bu bir doküman kusuru değil, **şema–prose uyuşmazlığı** ve ucuz çözülür.

**Diğer öne çıkanlar:**
- `09:1036-1041` — JSONL "biriktir + resume" reçetesi `cdp_files`'ın **append** yeteneğini varsayıyor; `cdp_files`'ta append yok (`tools.ts:2043-2049`, `files.ts:189-195`), yani reçete her turda defteri tek satıra düşürüyor. En düşük puanlı blok (C2 = 3).
- `10:174` — `found: true` yazıyor; `cdp_captcha.found` bir **tamsayı** (`tools.ts:3472`). F7 akışının kapısı olan yerde tip hatası.
- `09:751-752` — ifadede U+2026 üç nokta → kopyalayınca `SyntaxError`; ayrıca nesne sabiti yazılmış, `tools.ts:2158` string bekliyor.
- `SKILL.md:62` — `cdp_screenshot({ selector | clip, … })`: "|" bir değer değil; `clip`'in `x/y/width/height`'i zorunlu (`capture.ts:512`); `targetId` düşürülmüş — oysa SKILL.md:99-100 hedef belirtmemeyi bir mutasyon tehlikesi sayıyor.
- **`cdp_locate`'ta Türkçe render** (`locate.ts:550-551`) — 12 kardeş render'ın hepsi İngilizce.
- **`tools.ts:3083` kendisi yanlış:** "Up to 10 fresh-measured candidates" diyor, uygulama 5'te kesiyor (`locator.ts:435`). Rehber 09 ve 10 doğru olan **5**'i basıyor — yani **kılavuzlar araçtan daha doğru.**

---

## 7. KLAVUZ PUANLARI (12 dosya)

| Dosya | G1 doğruluk | G2 karar | G3 gezinme | G4 kanıt | G5 bütçe | **TOPLAM** | Tek cümlelik hüküm |
|---|---:|---:|---:|---:|---:|---:|---|
| `11-derin-tarama.md` | 8 | 9 | 7 | 8 | 8 | **8,2** | En iyi dosya: vaka tablosu kaynağa kadar izlenebiliyor |
| `SKILL.md` | 7 | 8 | 6 | 6 | 4 | **6,7** | En yüksek karar değeri, **en düşük bütçe disiplini** |
| `10-skill-mimarisi.md` | 7 | 8 | 6 | 5 | 5 | **6,7** | 42/42 "sonraki araç" + F1–F14 akış; polimorfizm kümeleri en değerli kısım |
| `00-map.md` | 7 | 6 | 9 | 5 | 7 | **6,7** | Doğru indeks, kanıt temeli yok |
| `03-dom-and-eval.md` | 7 | 8 | 8 | 4 | 6 | **6,9** | İnce ve ölçülü; "sanitized" diye bir şey yok |
| `07-human-interaction.md` | 8 | 7 | 5 | 7 | 4 | **6,7** | Ölç-tıkla disiplini iyi; görsel döngüsü SKILL.md'den **birebir kopya** |
| `09-scraping-master.md` | **5** | **9** | 7 | 4 | 6 | **6,5** | En yüksek karar değeri, **en düşük doğruluk** — 10 sert şema kusuru |
| `04-proxy-and-analysis.md` | 9 | 3 | 8 | 4 | 7 | **6,1** | Teknik olarak doğru, karar değeri yok |
| `01-protocol-core.md` | 7 | 4 | 8 | 4 | 7 | **5,8** | İnce; "`extensions` hedef türü" diyor, kodda dört tür var |
| `02-input-and-stealth.md` | 8 | 3 | 8 | 4 | 7 | **5,8** | Doğru, ama yalnız tanım |
| `05-workflow-combos.md` | 6 | **2** | 8 | 3 | 5 | **4,6** | Hiçbir araç adı içermiyor; orkestrasyon vaadi pakette karşılıksız |
| `06-adapters.md` | 6 | **1** | 8 | 3 | 5 | **4,3** | **Ulaşılamayan yüzeyi belgeliyor** (aşağıda) |
| **Set ortalaması** | | | | | | **6,5** | |

### 7.1 Üç yapısal bulgu

1. **✅ `06-adapters.md` var olmayan bir yüzeyi anlatıyor.** Dört gömülü adaptör gerçek (`adapters.ts:59,76,106,134`) ve kayıt defteri dışa açık (`index.ts:515`) — ama `tools.ts` içinde **"adapter" kelimesi hiç geçmiyor**. SKILL.md:284 ve 00-map modeli buraya yönlendiriyor; model gittiğinde karşılığı olan bir araç yok.
2. **Çapa kapısı, kırıkların olduğu yere bakmıyor.** 5 ölü çapa var (`07:18`, `09:24`, `09:28`, `10:26`, `10:27`) ve hepsi tek bir kökten: elle yazılmış TOC'larda Türkçe diyakritik dönüşümü. Kapı (`tests/guide-links.spec.ts:55`) bağlantının `#`'den önceki dosya kısmını boş olmayan ister — yani aynı sayfa içi `](#çapa)` bağlantıları hiç denetlenmiyor. 99 çapadan 94'ü canlı; **çapraz dosya çapalarında 0 kusur**, yani sorun yalnız aynı sayfa içi bağlantılarda.
3. **`09-scraping-master.md` kendi tezine ihanet ediyor.** Kanıt kaydı bölümünde **5 yanlış satır atfı** (`:1131,1134,1136,1137,1141`) ve adı geçen **4 ölçüm fixture'ı depoda yok** (`:1259-1262`) — yani "doğrulanmış ölçümler" başlığı altındaki 16 satırın hiçbiri yeniden üretilemiyor. Bir denetim yöntemi belgesinin kendi kanıt bölümü doğrulanamaz olduğunda, o bölümün varlığı zarar verir.

---

## 8. GENEL PUAN KARTI

### 8.1 Araçlar (42 araç, altı eksen)

| Eksen | Ortalama | Yorum |
|---|---:|---|
| **A5 Kılavuz kapsamı** | **8,4** | En yüksek eksen: 42/42 araç adı geçiyor, 42/42 karar tablosu satırı var |
| **A4 Kanıt/verifikasyon** | 7,5 | Genel olarak güçlü, ama "her zaman kanıt" sözünü tutmayan araçlar var |
| **A6 Test desteği** | 7,3 | Genel iyi; **5 araç sıfır** (`cdp_lock`, `cdp_unlock`, `cdp_profiles`, `cdp_raw`, `cdp_deep_click`) |
| **A3 Hata semantiği** | 7,1 | En büyük bölünme: pakette iki rakip sözleşme ailesi |
| **A2 Şema hijyeni** | 7,1 | Enum disiplini, hayalet parametre ve `ok` alanı sorunları |
| **A1 Açıklama netliği** | **6,8** | En düşük eksen: `cdp_navigate` 3, `cdp_eval` 3, `net_capture`/`net_export` 4 |
| **TOPLAM (ağırlıklı)** | **7,3 / 10** | 42 araç |

Kol ortalamaları: okuma/çıkarma **7,5** · etkileşim **7,4** · hedef/sekme **7,0**.

### 8.2 Kılavuzlar ve kod blokları

| Ölçüm | Puan |
|---|---:|
| Kılavuz seti (12 dosya, G1–G5 ağırlıklı ortalama) | **6,5 / 10** |
| Kod blokları (52 blok, C1 ağırlıklı) | **8,4 / 10** |
| Blok imza doğruluğu (C1) | 8,8 |
| Karar tablosu kapsamı (SKILL.md §3) | **10 / 10** — 42/42, sıfır eksik |

### 8.3 Genel hüküm

**Araç seti kılavuzdan belirgin biçimde daha iyi (7,3 ↔ 6,5).** Bu, beklenmedik ama ölçümle gelen sonuç ve bu eklentinin asıl riskidir: kılavuzun işi, aracın söyleyemediğini söylemek — ama üç yerde (spill yolu, `cdp_expect`'in konumlayıcısız örnekleri, `cdp_tab_close`'ın "throw etmez" iddiası) **kılavuz aracın doğru davranışını yanlış anlatıyor.** Yani kılavuzun eklediği değer, bazı yerlerde eksi değer.

Pozitif taraf dürüst olmak gerek: kapsama kusursuz (42/42), karar değeri yüksek (`10-skill-mimarisi.md`'deki polimorfizm kümeleri ve `09`'daki reçeteler gerçekten işe yarar), kanıt disiplini var (11'in vaka tablosu kaynağa izlenebiliyor), blok imzaları doğru (%8,8), ve kapılar **kırmızıya düşüyor** — yani sistem kendi hatalarının bir kısmını yakalayabilecek altyapıya sahip.

---

## 9. ÖNERİLEN DÜZELTME SIRASI (maliyet/etki)

| # | Düzeltme | Dosya/yol | Maliyet | Etki |
|---|---|---|---|---|
| 1 | `cdp_extract` açıklamasına "string" demek | `tools.ts:3169-3173` | 1 satır | 9 doküman yerini birden düzeltir |
| 2 | 7 `cdp_expect` örneğine konumlayıcı eklemek | `09:962,983,1174`, `10:134,162,205`, `11:140` | 7 satır | Zorunlu doğrulama adımını çalışır hale getirir |
| 3 | Spill hedefini indirme köküne taşımak **ya da** fiş metnini `cdp_files`'ın okuyabileceği biçime getirmek | `spill.ts:45-47` ↔ `downloads-dir.ts:24-28` | 1 karar + 1 test | 12k üstü her yanıtta ölü talimatı siler |
| 4 | `cdp_tab_close` için rehber 09'u kodla aynı yola getirmek | `09:146-148` | 3 satır | Yanlış hata tipi beklentisini siler |
| 5 | Çapa kapısına aynı sayfa içi `](#…)` desteği + 5 ölü çapa | `tests/guide-links.spec.ts:55` | 1 test + 5 satır | Sınıfın tamamını kapatır |
| 6 | `06-adapters.md`'yi ya gerçek bir araca bağlamak ya da silmek | `06-adapters.md` | karar | Ulaşılamayan yüzeyi kaldırır |
| 7 | `cdp_lock`'un `<active>` anahtarlamasını gerçek hedef çözümlemeye çevirmek | `tools.ts:745`, `tab-lock.ts:67` | 1 fonksiyon | Kilitlemeyi işlevsel hale getirir |
| 8 | `cdp_raw` (S7) ve `cdp_deep_click` için araç-seviyesi test | `tests/` | 2 spec | Sıfır testli iki en güçlü iddiayı koruma altına alır |
| 9 | SKILL.md §1'deki niyet kovalarını 42/42 doldurmak | `SKILL.md:41-49` | 22 araç adı | §2'nin kapsam belirsizliğini kapatır |
| 10 | `09`'daki kanıt bölümünü (yanlış satırlar, olmayan fixture'lar) düzeltmek ya da kesmek | `09:1107-1141` | 30 satır | Denetim yönteminin kendi tezini onarmak |

**1, 2 ve 4 toplamda ~11 satır; 3 tek bir mimari karar.** Yani bu rapordaki en ağır beş kusurun maliyeti, eklentinin en büyük dosyasının (`src/tools.ts`, 223 KB) yüzde biri kadar bile değil.

---

*Bu kart, kaynak, çalışma zamanı ve testlerden ölçülerek yazıldı. Her puan bir `path:line` kanıtına dayanıyor; kanıtı doğrulanamayanlar "unverified" olarak işaretlendi (alt ajanların kendi unverified listeleri korunmuştur). Hiçbir dosya değiştirilmedi.*
