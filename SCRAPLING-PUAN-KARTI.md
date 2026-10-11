# SCRAPLING PUAN KARTI — API yüzeyi, ajan kılavuzu, kod blokları

**Kapsam:** `C:\Users\metin\Downloads\Scrapling-main\Scrapling-main` (sürüm `0.4.15`) + `agent-skill/Scrapling-Skill/` ajan kılavuzu
**Yöntem:** CDP eklentisi denetiminde kullanılan **aynı çerçeve** — altı araç ekseni (A1–A6), beş kılavuz ekseni (G1–G5), üç blok ekseni (C1–C3). Aynı ağırlıklar, kişiler karşılaştırabilsin diye.
**Kural:** Her puan bir ölçüme dayanır; kanıtı olmayana puan verilmez, `unverified` yazılır.

> Bu, `CDP-PUAN-KARTI.md`'nin karşılaştırmalı ikizidir. İki rapor sonunda aynı tabloda karşılaştırılacak.

---

## 0. ÖLÇÜLEN YÜZEY

| Ölçüm | Değer | Nasıl ölçüldü |
|---|---:|---|
| Kaynak Python dosyası | 58 (`scrapling/`), 126 toplam | dosya sayımı |
| Test dosyası / toplanan vaka | 62 dosya · **441 vaka toplandı, 74 toplama hatası** | `pytest --collect-only -q` |
| Hata nedeni | `ModuleNotFoundError: No module named 'protego'` | ortamda `scrapling 0.4.2` kurulu, depoda `0.4.15` |
| Ajan kılavuzu dosyası | **22** (1 SKILL.md + 19 `references/` + 2 README) | `agent-skill/**` envanteri |
| Bakım altındaki site dokümanı | 38 dosya (`docs/**`, 10 çeviri hariç) | envanter |
| Duyurulan genel API | 8 sınıf (`scrapling/__init__.py:14-24`) + 3 session + `ProxyRotator` (`scrapling/fetchers/__init__.py:11-34`) | kaynak okuma |

**Test koşumu dürüstlüğü:** bu ortamda takım **koşturulamadı** — 74 dosya eksik isteğe bağlı bağımlılıklar yüzünden toplanamıyor (kurulu sürüm 0.4.2, depo 0.4.15). Bu yüzden **A6 (test desteği) puanları test dosyalarını okumakla verildi, koşumla değil.** CDP tarafında ise takım koştu (1017/1017 yeşil). Karşılaştırmada bu farkı not etmek gerekiyor.

### 0.1 ✅ İyi haber: kılavuzun CLI iddiaları koda uyuyor

SKILL.md'in iki büyük seçenek tablosunda (`:99-111`, `:117-118`, `:147-162`, `:166-168`, `:172-177`) sayılan **18 seçeneğin 18'i** `scrapling/cli.py` içinde gerçekten tanımlı:

`--css-selector` · `--ai-targeted` · `--impersonate` · `--stealthy-headers` · `--follow-redirects` · `--verify` · `--disable-resources` · `--network-idle` · `--real-chrome` · `--wait-selector` · `--dns-over-https` · `--block-ads` · `--executable-path` · `--locale` · `--block-webrtc` · `--solve-cloudflare` · `--allow-webgl` · `--hide-canvas` — **tamamı bulundu.**

Kod örneklerinin import yolları da doğru: `SKILL.md:220` `from scrapling.fetchers import Fetcher, FetcherSession`, `:232` `StealthySession`, `:244` `DynamicSession` — üçü de `scrapling/fetchers/__init__.py:12-20` lazy-import haritasında dışa açık.

*(Not: ilk ölçümümde bu 18 seçenekten 10'u "yok" çıktı; ölçüm hatalıydı — Click seçenekleri tırnak içinde tanımlanmıyor. Tırnaksız aramayla tekrar ölçüldü ve düzeltildi. CDP raporundaki "ölçtüğüm iddia yanlış çıktı, düzelttim" kuralı burada da işledi.)*

**Karşılaştırma notu:** CDP'de rehber iki yerde kodu tersinden anlatıyordu (`cdp_tab_close` "throw etmez", `cdp_extract` nesne spec). Scrapling'de aynı sınıf hata **ilk taramada yok çıktı.** Bu, tek başına bir kalite farkıdır ama alt ajanların satır düzeyinde okumasıyla kesinleşecek.

---

## 1. YAPISAL BULGU: kılavuz, dokümanın *türetilmiş* bir kopyası ve türetme mekanik değil

`agent-skill/Scrapling-Skill/references/**`, `docs/**`'in ajana verilmiş kopyasıdır. Karşılaştırma (hash + başlık + kod bloğu sayımı):

| Ölçüm | Değer |
|---|---:|
| Paylaşılan dosya | 16 |
| **Birebir aynı** | **1** (`spiders/platform-templates.md`) |
| **Farklı** | **15** |
| Tek yönlü (yalnız `docs/`) | 19 dosya |
| Tek yönlü (yalnız `references/`) | 3 dosya |
| Farkların yönü | `references/` her zaman **daha kısa** (−%1,3 … −%23,2) |

Kısaltmanın bir kısmı **kasıtlı**: mkdocs'a özgü işaretler (`:::`, `--8<--`, `!!!`) temizlenmiş (ölçüldü: `parsing/adaptive.md` 2→0, `fetching/stealthy.md` 4→0).

Ama **türetme mekanik değil, kayıplı:**

| Dosya | `docs/` | `references/` | Fark |
|---|---:|---:|---|
| `fetching/stealthy.md` | 24 kod bloğu | **16 kod bloğu** | **8 blok düşmüş** |
| `parsing/adaptive.md` | 23 başlık | 22 | 1 başlık düşmüş |
| `spiders/getting-started.md` | 16 başlık | 14 | 2 başlık düşmüş |
| `fetching/stealthy.md` | 18 başlık | 17 | 1 başlık düşmüş |

**Neden önemli:** CDP denetiminde en ağır kusur "kılavuzun, aracın ulaşamadığı yeri okunur gösterdiği" idi. Buradaki risk farklı ama aynı sınıf: **ajanın okuduğu metin, bakım altındaki metin değil** — ve bu kopya otomatik değil, elle/yarı otomatik üretildiği için farkın "kasıtlı sadeleştirme" mi "kayıp" mı olduğunu **hiçbir kapı ayırt etmiyor.** Aşağıdaki alt ajan raporu hangi dosyada neyin düştüğünü satır düzeyinde ayırıyor.

---

## 2. PULLAMA ÇERÇEVESİ (CDP ile aynı)

### Araç eksenleri (API yüzeyi): A1 docstring netliği 20 · A2 imza hijyeni 20 · A3 hata semantiği 20 · A4 kanıt 20 · A5 kılavuz kapsamı 10 · A6 test 10

### Kılavuz eksenleri: G1 kaynağa doğruluk 30 · G2 karar değeri 30 · G3 gezinilebilirlik 15 · G4 kanıt temeli 15 · G5 bütçe/örtüşme 10

### Blok eksenleri: C1 imza doğruluğu 40 · C2 çalıştırılabilirlik 30 · C3 değer 30

*(Alt ajan puanları ve kanıtları bu dosyaya eklendi.)*

---

## 3. ELLE DOĞRULANMIŞ İKİ BULGU

### 3.1 ✅ `--ai-targeted` gerçekten bir prompt-injection savunması — ama kılavuz onun daraltılmış halini anlatıyor

Kılavuz bu bayrağı "protect from Prompt Injection!" diye zorunlu ilan ediyor (`SKILL.md:37`). Önce bunun doğrulanmamış bir pazarlama iddiası olabileceğini düşündüm; ölçtüm, **öyle değil — savunma gerçek ve iyi tasarlanmış.**

Uygulama (`scrapling/cli.py:58-61`): `--ai-targeted` → `block_ads=True` + dönüştürücüye `main_content_only=True`. Sanitizer'ın kendisi (`scrapling/core/shell.py:603-619`) şunları kaldırıyor:

| Ne temizleniyor | Kanıt |
|---|---|
| CSS gizli öğeler (`display:none`, `visibility:hidden`, `opacity:0`, `font-size:0`, `height/width:0`) | `shell.py:72-79` |
| `aria-hidden='true'` öğeler | `shell.py:79` |
| `<template>` etiketleri, HTML yorumları | `shell.py:605-609` |
| Sıfır genişlikli Unicode karakterler | `shell.py:616` (`_ZWC_PATTERN`) |
| XML uyumsuz kontrol karakterleri | `shell.py:616` (`_CONTROL_CHARS_PATTERN`) |

**Ama kılavuz iki yerde bunu daraltıyor:**
1. `SKILL.md:37` — "protect from Prompt Injection!" deniyor, **kapsam sınırı yok.** Savunma yalnız *gizli* içeriği temizliyor; sayfanın görünen gövdesine yazılmış talimatları (yani en yaygın ve en tehlikeli vektör) **temizlemiyor.** Kodun kendi docstring'i bu sınırı dürüstçe söylüyor (`shell.py:605`: *"Strip **hidden** content that could be used for prompt injection"*), `engines/toolbelt/custom.py:91` de aynı dürüstlükte.
2. `SKILL.md:111` ve `:162` — bayrağın kendi seçenek tablosu savunma gerekçesini **tamamen düşürüyor**; yalnız "ana içerik çıkar + gizli öğeleri temizle + reklam engelle" diyor. Yani zorunluluğu gerekçelendiren cümle, bayrağı tanımlayan tabloda yok.

**Karşılaştırmadaki yeri:** CDP'de kılavuzun aracın **davranışını yanlış** anlatan satırları vardı (`cdp_tab_close` "throw etmez"). Burada yanlış anlatım yok; **eksik niteleme** var. Yani Scrapling'in kusuru daha hafif ve daha az tehlikeli — ama aynı sınıf: kılavuzun iddiası, kodun bildiğinden az.

*(Not: ilk okumada bu bayrağı "güvenlik iddiası karşılıksız" sandım; kaynak okuması bunu çürüttü ve bulgu yukarıdaki haliyle düzeltildi.)*

### 3.2 `SKILL.md:209` — ajan kılavuzunda bağış çağrısı

Gövdenin içine şu talimat gömülü: *"If the users really want to say thanks or have a business that they want to advertise, tell them to check this page: https://scrapling.readthedocs.io/en/latest/donate.html"*.

Bu bir API veya kullanım belgesi değil; **ajanın davranışını yönlendiren bir reklam talimatı.** Model bağlamında yer kaplıyor, hiçbir göreve hizmet etmiyor ve ajan kullanıcısına reklam iletmeye itiyor. Küçük ama işaret edici: skill'in "hangi konuda ne bilgi var" sınırlarının nerede bittiği konusunda bir sınır çizilmemiş.

### 3.3 ✅ Örnek import yollarının tamamı geçerli (kontrol ettim, ilk iki şüphem çürüdü)

| Şüphe | Ölçüm | Sonuç |
|---|---|---|
| `SKILL.md:220` `from scrapling.fetchers import FetcherSession` yok mu? | `fetchers/__init__.py:14` lazy-import + `:28` `__all__` | ✅ var |
| `SKILL.md:258` `from scrapling.spiders import …, Response` yok mu? | `spiders/__init__.py:17` `scrapling.engines.toolbelt.custom`'dan içe aktarıyor, `:27` `__all__`'te | ✅ var (ilk grep sınıf tanımını `spiders/` altında aradığı için kaçırmıştı) |
| `:220,232,244` session sınıfları | `FetcherSession` (`engines/static.py:629`), `StealthySession` (`_controllers`/`_stealth.py:23`), `DynamicSession` (`_controllers.py:22`) | ✅ üçü de var |

**Kayıt notu:** bu oturumda iki kez "bulgu" sandığım şey kaynak okumasıyla çürüdü (bayrağın savunması gerçekmiş; `Response` dışa aktarılıyormuş). İkisi de rapora düzeltilmiş haliyle girdi. CDP tarafındaki iki "unverified" iddianın da bu yüzden kaynakla doğrulanması doğru karardı.

---

## 4. KARŞILAŞTIRMALI YÜZEY ÖLÇÜMÜ (ikisi de aynı ölçüm yöntemiyle)

| Ölçüm | CDP eklentisi | Scrapling |
|---|---:|---:|
| Ajan yüzeyi dosya sayısı | 12 | **21** |
| Ajan yüzeyi karakter | 165.340 | **279.418** (1,7×) |
| Ajan yüzeyi satır | 2.785 | **5.116** (1,8×) |
| Fenced kod bloğu | 51 | **267** (5,2×) |
| Blokların niteliği | 50 akış diyagramı, 1 kod | büyük kısmı **gerçek Python/CLI** |
| Bakım altındaki kaynak doküman | yok (yol gövdenin kendisi) | `docs/**` 38 dosya · 410.452 krk · 336 blok |
| Kaynak ↔ ajan kopyası ilişkisi | tek kopya, sürüm kayması **yok** | **türetilmiş kopya**, 15/16 dosya farklı |
| Model yüzeyi (katalog maliyeti) | 42 araç · ~217 KB şema | ~14 genel API + 6 CLI komutu + MCP araçları |

**İlk yapısal fark:** CDP'de ajanın okuduğu metin **tek ve aynı** kaynaktı (risk: kayma yok, tutarlılık yüksek). Scrapling'de ajanın okuduğu metin **bakım altındaki metnin türetilmiş bir kopyası** — dolayısıyla risk ters yönde: CDP'nin "iki yer söylüyor" sorunu yok, Scrapling'in "kopya bayatlamış" sorunu var.

---

## 5. 🔴 ELLE DOĞRULANMASI EN AĞIR BULGU: adaptif yerleştirme puanı hesaplanıyor ama **modele hiç ulaşmıyor**

Scrapling'in imza özelliği şu: "`SKILL.md:23` — *Its parser learns from website changes and automatically relocates your elements when pages update.*" Bu, kılavuzda kanıtsız bir vaat olarak yazılı; aslında **gerçek bir mekanizma** var (`parser.py:822` `__calculate_similarity_score`, `:552-577` yeniden yerleştirme döngüsü). Sorun mekanizmanın değil, **çıktının**.

İzledim: benzerlik puanı hesaplanıyor (`:557`), bir skor tablosuna konuyor (`:558`), en yükseği seçiliyor (`:561-562`) — ve sonra ne oluyor?

| Puanın gittiği yer | Kanıt |
|---|---|
| `log.debug` — **yalnız hata ayıklama seviyesinde** | `parser.py:563-568` |
| Başarısızlıkta `log.warning` (en yüksek puanı adıyla birlikte) | `parser.py:573-576` |
| Çağırana dönen değer | **puan değil, sadece eşleşen öğeler** — `parser.py:571-572` |

Yani `page.css('.price', adaptive=True, identifier='x')` çağıran bir kod, site değiştiğinde öğeyi **%61 benzerlikle tahmin etmiş olsa bile** tam olarak eşleşmiş gibi bir sonuç alıyor. Çağıran taraf "CSS seçicim tuttu" ile "sistem bir şeye benzetip getirdi" arasında **hiçbir fark göremez.**

**Dürüstlüğün iki yönü ayrı değerlendirilmeli:**
- ✅ **Başarısızlık dürüst:** eşik altında kalan durumda `[]` dönüyor ve uyarı en yüksek puanı **adıyla** söylüyor ("top score: 47%. Lower `percentage`…") — `parser.py:573-576`. "Bir şey bulamadım" demek dürüst.
- ❌ **Başarı derecelendirilmemiş:** eşiğin üstünde kalan her puan aynı görünüyor. `percentage` parametresi (`:598`) eşiği ayarlıyor ama **sonucu değil**, yani çağıran "eşiği %95'e çıkarınca daha güvenilir olur" diyebiliyor, sonucun ne kadar güvenilir olduğunu göremiyor.

**Karşılaştırmadaki yeri:** bu, CDP'deki `cdp_scroll`'un okunamayan konumda `atTop:true, atBottom:true` demesiyle **aynı sınıf** — ölçülebilir bir durumun varmış gibi sunulması. CDP'de bu iki araçtan birine bayrak eklemek bir satırlık işti; burada skor zaten hesaplandığı için çözüm de benzer ölçekte (ya puanı döndürmek ya da `Adaptor`'a `match_score` alanı eklemek). **Ama Scrapling'de bu eksik en az bir tam sürüm boyunca sürüyor**, çünkü `log.debug`'e gömülmüş durumda.

**Bonus:** bu bulgu, `SKILL.md:23`'teki vaadi de ölçülebilir kılıyor — vaat doğru, ama **kanıtı modele verilmiyor.**

---

## 6. 🔑 KAPILAR: Scrapling'de ajan kılavuzunu doğrulayan **hiçbir** otomatik kontrol yok

`.github/workflows/` içindeki dört iş akışını taradım:

| İş akışı | Gerçekten ne çalıştırıyor | Kılavuzu doğruluyor mu |
|---|---|---|
| `code-quality.yml` | Bandit, Ruff (lint+format), Vermin, Mypy, Pyright — `:63-107` | ❌ hepsi Python-only |
| `tests.yml` | `tox` (`:122-124`) | ❌ Python testleri |
| `release-and-publish.yml` | build + PyPI | ❌ |
| `docker-build.yml` | imaj | ❌ |

`agent-skill/**` yol filtresi **iki** iş akışında geçiyor (`code-quality.yml:14,26`, `tests.yml:13,27`) — ama bu bir **tetikleyici**, bir denetim değil: skill dosyası değişince "Python kalite kontrollerini çalıştır" deniyor, o kontroller de Markdown okumuyor.

**Sonuç:** `agent-skill/Scrapling-Skill/` 21 dosya · 279.418 karakter · elle üretilmiş bir kopyadır ve **hiçbir otomatik kontrol onu doğrulamaz.** Doğrulama yalnızca `tests/` altındaki Python testleriyle, dolaylı olarak yapılıyor.

**Karşılaştırma — bu iki projenin en keskin farkı:**

| | CDP eklentisi | Scrapling |
|---|---|---|
| Kılavuzu gören bir kapı var mı? | ✅ **5 skill spec dosyası** (`skill-packaging`, `skill-provider`, `skill-frontmatter`, `skill-web`, `skill-registration`) | ❌ yok |
| Repo seviyesinde kapı | ⚠️ var ama **bu paketi kapsamıyor** (`verify-skill-invocation-metadata.ts:32` yalnız `.agents/skills`) | ❌ hiç yok |
| Kılavuz ↔ kaynak kayması | düşük risk (tek kopya) | **yüksek risk** (bayatlamış türetilmiş kopya) + **denetim yok** |

CDP'de kılavuzun düzeltilmesi için en az bir mekanizma vardı (paket içi testler). Scrapling'de **mekanizmanın kendisi yok** — bu yüzden §1'de ölçtüğüm "15/16 kopya farklı, `fetching/stealthy.md`'de 8 kod bloğu düşmüş" bulgusu kimse tarafından fark edilmemiş olabilir; fark edilmemesi değil, **fark edilememesi** ihtimali var.

### 6.1 Kılavuzun kendi iddialarının kanıt durumu

| İddia | Yer | Ölçüm |
|---|---|---|
| "yanıtlayabileceğiniz soruların neredeyse **%90**'ını" | `agent-skill/README.md:5` | ❌ **Depoda hiçbir ölçüm yok.** Tek destekleyici cümle anekdot: "We tested it on OpenClaw and Claude Code" |
| "sürümü her zaman kütüphane sürümünü izler" | `docs/ai/agent-skill.md:7` | ✅ **Doğru ve dört yerde tutarlı:** `pyproject.toml:8` = `SKILL.md:4` = `scrapling/__init__.py:2` = `CHANGELOG.md:5` → hepsi **0.4.15**; kurulum sabiti `>=0.4.15` (`SKILL.md:43`) |
| …ve bu izlemeyi bir test zorlar mı? | — | ❌ hayır. İki sürüm bugün örtüşüyor **tesadüfen/manuel olarak**; sürüm ilerlediğinde kopya bayatlayacak ve hiçbir şey söylemeyecek |
| "Cloudflare Turnstile bypass" | `SKILL.md:3` | Mekanizma var (`--solve-cloudflare`, `cli.py`); başarı oranı hiçbir yerde ölçülmüyor |

**Not — karşılaştırmada dürüstlüğün notu:** CDP raporunda kılavuzun "kanıt kaydı" bölümü bulunmadığı için **eksiklik** sayılmıştı. Scrapling'de `docs/` içinde kanıt bölümü de yok; buna karşılık README'de sayısal bir iddia (%90) var ve o sayı **hiçbir yerde üretilmemiş.** CDP'de "kanıt kaydı yok" bir boşluk; burada "kanıt kaydı yok ama sayı yazılmış" bir **boşluğun üstüne sayı yazılmış** hâli — daha kötü, çünkü sayı var olmayan bir kanıtın yerine geçiyor.

---

## 7. ✅ MCP ARAÇ YÜZEYİ — CDP'nin 42 aracının karşılığı (elle envanterlendi)

`scrapling/core/ai.py:1103-1188` — `MCPServer(name="Scrapling")` üzerine **13 araç** kaydediliyor:

| Aile | Araçlar | Satır |
|---|---|---:|
| Oturum | `open_session`, `open_request_session`, `close_session`, `list_sessions` | `ai.py:1105-1119` |
| HTTP | `make_request`, `bulk_get` | `ai.py:1121-1134` |
| Dinamik tarayıcı | `fetch`, `bulk_fetch` | `ai.py:1136-1149` |
| Gizli tarayıcı | `stealthy_fetch`, `bulk_stealthy_fetch` | `ai.py:1151-1164` |
| Oturum kapsamlı | `session_fetch`, `session_make_request` | `ai.py:1166-1179` |
| Görüntü | `screenshot` | `ai.py:1181-1187` |

**Kaynak kodda gördüğüm üç tasarım kararı — hepsi CDP ile karşılaştırılabilir:**

1. **Açıklama tek kaynaktan geliyor:** `description=self.make_request.__doc__` (`:1124`, `:1131`, `:1139`, …). Yani modelin göreceği metin, geliştiricinin doküstride yazdığı metnin **aynısı** — kayma yapısal olarak imkânsız. CDP'de de `cdp_status` tek `CDP_STATUS_DESCRIPTION` sabitini iki kayıtta paylaşıyor (`status.ts:27-32`), ama 42 aracın **tamamı** için böyle bir kural yok.
2. **Aile bazlı davranış işaretleri:** `_SESSION_TOOL_ANNOTATIONS`, `_LIST_TOOL_ANNOTATIONS`, `_FETCH_TOOL_ANNOTATIONS` her araç grubuna veriliyor (`:1106, 1118, 1126…`). Model araca bakarken "bu salt-okunur mu, mutasyon mu" bilgisini **şemadan** okuyor. CDP'de bu bilgi yalnız kılavuzun §1'inde var ve orası da eksik (bkz. `CDP-PUAN-KARTI.md` §2.1: 42 aracın 22'si hiçbir kovada değil).
3. **Bileşik çıktı dürüstçe işaretlenmiş:** 12 araç `structured_output=True`, `screenshot` ise `False` — ve nedeni satır içinde yazılı: *"returns image + url content blocks, not structured JSON"* (`:1180`). Yani modelin bir aracın beklenmedik çıktı biçimi olduğunu **kayıt anında** bildiğini varsayıyor.

**Karşılaştırma:** CDP 42 araç / Scrapling 13 araç. CDP'nin avantajı genişlik, Scrapling'inkisi ise **her aracın şemasının tek kaynaktan gelmesi ve davranış işaretlerinin şemada taşınması.** CDP'de bu iki şey kılavuzun omuzunda taşınıyor — ve kılavuzda ölçülen 22 aracık boşluk tam olarak bunun sonucu.

---

## 8. API YÜZEYİ PUANLARI (fetcher + parser kolu, 7 yüzey)

Kaynak: bağımsız alt ajan okuması. Test iddiaları **spec dosyalarından okundu, koşturulmadı** (§0'daki neden).

| Yüzey | A1 | A2 | A3 | A4 | A5 | A6 | **TOPLAM** | Tek cümlelik hüküm |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `Selector` / `Selectors` | 6 | 5 | **8** | **3** | 8 | 7 | **5,9** | Kütüphanenin **en iyi** hata semantiği, **en kötü** kanıtı |
| `Fetcher` (sync HTTP) | **3** | 6 | 5 | 7 | 8 | 7 | **5,7** | Metotların hiç dokümanı yok; parametreler bir katman altında |
| `StealthyFetcher` | 7 | 5 | 6 | 4 | 7 | 6 | **5,7** | 32 parametre anlatılmış ama **başarısı kanıtlanamıyor** |
| `DynamicFetcher` | 7 | 5 | 5 | 5 | 7 | 6 | **5,7** | `page_action`/`wait_selector` hataları yutuluyor → sahte başarı |
| `Response` / `ResponseMeta` | 5 | 5 | 4 | 4 | 5 | 5 | **4,6** | **`ResponseMeta` diye bir şey yok**; yanıt süresi hiç yok |
| `AttributesHandler` / `TextHandler` | 4 | 4 | 4 | 4 | **3** | 6 | **4,1** | Ajan kılavuzunda **hiç geçmiyor**; 27 metot dokümansız |
| `AsyncFetcher` | **2** | 4 | 4 | 7 | 5 | **1** | **4,0** | Kopyalanmış tek satırlık doküstring; **sıfır test referansı** |
| **Kol ortalaması** | | | | | | | **4,9 / 10** | |

*(CDP'nin üç kolu: 7,5 · 7,4 · 7,0 — ortalamalar birbirine yakındı. Scrapling'in tek kolu 4,9'da; diğer üç kol geldiğinde genel ortalama netleşecek.)*

### 8.1 🔴 En ağır bulgu — benimkinin doğrulaması: adaptif skor hiçbir yere çıkmıyor

Alt ajan bağımsız olarak aynı sonuca vardı ve **iki yerden daha genişletmiş**: skor yalnızca `log.debug`'e gidiyor (`parser.py:563-568`), `xpath` yolunda **tamamen atılıyor** (`:684`), ve alt ajan ek olarak **`Selectors` sınıfında hiç `adaptive` parametresi yok** (`parser.py:1267, 1295`).

Bu sonuncusu ayrı bir tuzak: `Selector.css(sel, identifier, adaptive)` ile `Selectors.css(sel, identifier, auto_save)` — **üçüncü konumsal slot iki sınıfta iki farklı şey**, listede `adaptive` yok ve `auto_save` o slota kaymış durumda. Aynı çağrı iki sınıfta farklı anlama geliyor.

### 8.2 Diğer doğrulanmış kusurlar (alt ajan kanıtlarıyla)

**1. `Fetcher` üç parametreyi kabul ediyor ve sessizce atıyor.** `google_search`, `block_ads`, `extra_headers` (`engines/static.py:150-153` — *"Browser session params (ignored by HTTP sessions)"*). Uyarı yok; üstelik `tests/fetchers/test_merge_request_args.py:26-34` bunu **kasıtlı olarak sabitliyor.** Sonuç: bir tarayıcı örneğini `Fetcher.get`'e kopyalayan kullanıcı, `block_ads=True` yazdığını sanırken sessizce alamaz. → CDP'deki "hayalet parametre" sınıfının en kötü hâli: burada **milisaniye/saniye bileşim karışıklığı** da var.

**2. `timeout` birimi motorlar arasında çakışıyor.** `Fetcher` için **saniye** (varsayılan 30 — `static.py:78`), tarayıcı motorları için **milisaniye** (varsayılan 30000 — `_validators.py:78`) — ve milisaniye değerinin tip takma adı **`Seconds`** olarak adlandırılmış (`:56`). Web sitesi dokümanı ikisini de doğru yazıyor; motor değiştiren kullanıcıyı hiçbir şey uyarmıyor.

**3. `solve_cloudflare=True` görünmezce `timeout`'u ≥60.000 ms'ye yazıyor** (`_validators.py:154-155`) — hiçbir dokümanda yok, yalnız `tests/fetchers/test_validator.py:76-88`'de.

**4. `solve_cloudflare` başarısı kanıtlanamıyor.** Başarısızlık `log.error(...)` + `return None` (`_stealth.py:118-122`) → çağıran **çözülmemiş challenge sayfasını normal bir `Response` olarak alıyor**, "çözülmedi" diyen bir alan yok. Kütüphanenin imza özelliği.

**5. Tarayıcı otomasyonu hataları sessiz başarı.** `page_setup`, `page_action`, `wait_selector` istisnaları yalnız `log.error` (`_controllers.py:159, 172, 180`) → `fetch(url, wait_selector='.never')` ile başarılı `fetch(url)` **ayırt edilemiyor.** CDP'deki "ölçülemez tıklama `ok:true` sayılıyor" bulgusunun birebir karşılığı.

**6. Pakette sıfır `:raises:` etiketi** — ✅ **kendi ölçümümle teyitli:** tüm `scrapling/` ağacında `:\s*raises\s*:` için **0 sonuç**. Aynı ölçümde `:\s*return\s*:` için **58 sonuç** çıkıyor (Sphinx'in doğru biçimi `:returns:` — yani 58'i de yazım hatası). Parser'da en az 6 ayrı tipli istisna, her motorde `ValueError`/`TypeError`/`TimeoutError` var. **58 dönüş dokümanı, 0 istisna dokümanı.** → CDP'nin "hata semantiği 7,1" ekseninin **tersi**: burada hata davranışı iyi yazılmış (`SelectorSyntaxError` seçiciyi satırına gömüyor, `TypeError` suçlu tipi adıyla söylüyor) ama **hiçbiri belgelenmemiş.**

**7. `ResponseMeta` yok.** Tüm ağaçta 0 sonuç; `meta` tiplsiz bir `Dict[str, Any]` (`toolbelt/custom.py:79`) ve pratikte sadece `{"proxy": proxy}` ile doluyor. Yanıt süresi **hiçbir yerde** yok (yalnız spider seviyesinde, `spiders/result.py:150`).

**8. `cookies` tipi motora göre değişiyor.** HTTP'de `dict` (`convertor.py:318`), tarayıcıda **tuple of dicts** (`:140`) — doküman ikisi için de "dictionary" diyor (`docs/fetching/choosing.md:73`), farkı hiçbir test sabitlemiyor.

**9. Kopyalanmış doküstringler zaten kaymış.** Aynı parametre listesi 8 yere kopyalanmış; **senkron ve asenkron kopyalar arasında parametre sırası bile farklı** (`stealth_chrome.py:15-53` ↔ `:67-105`). CDP'de `cdp_status` tek sabiti paylaşıyor; burada her kopya ayrı ayrı yaşlıyor.

**10. `AsyncFetcher` en savunmasız yüzey.** 0 test, `choosing.md:12-27`'deki "three different fetcher classes" tablosunda **sütunu bile yok**, doküstringi `Fetcher`'ın kopyası, `get` metodu `async def` değil (`requests.py:52` — imzadan async'lik görünmüyor).

### 8.3 ✅ Bu kolun iyi tarafı (ölçülmüş olarak)

- **Hata mesajları iyi yazılmış:** `SelectorSyntaxError` seçiciyi cümle içine gömüyor (`parser.py:637, 707`), tip hataları suçlu tipi adıyla söylüyor (`:739-764`), adaptif kapalıyken `RuntimeError` (`:913, 927`). Sorun bunları **belgelememek**, üretmemek değil.
- **Web sitesi ↔ ajan kopyası kayması bu yüzeyde küçük ve doğru yönde:** `static.md` 439/43 başlık ↔ ajan 432/43; `dynamic.md` 376/31 ↔ 359/31; `choosing.md` 92/6 ↔ 84/6. Başlık sayıları birebir eşleşiyor — yani kayıp, §1'de ölçtüğüm stealthy.md'nin Camoufox bölümüyle sınırlı.
- **`custom.py` içindeki `markdown()` doküstringi dürüst:** gizli/prompt-injection içeriğin her zaman temizlendiğini açıkça yazıyor (`:91`) — §3.1'deki bulgumla tutarlı.

### 8.4 ✅ Test kalitesi: iki iddiayı kendim doğruladım

**a) Boş doğrulama.** `tests/fetchers/test_response_handling.py:171`:
```python
assert len(history) >= 0  # Should process redirects
```
`len(x) >= 0` **her zaman doğrudur** — bu satır hiçbir şey sınamıyor. Dahası, yorum satırı testin **neyi sınaması gerektiğini** yazıyor; yani test kendi eksikliğini not düşmüş. `_process_response_history` için tek test bu.

**b) Modül içeriğinde sınıf durumu değiştirme.** `tests/fetchers/sync/test_dynamic.py:7` — `DynamicFetcher.adaptive = True` dosya yüklenirken çalışıyor, yani **tüm pytest oturumu boyunca** sınıf durumunu değiştiriyor. Bu, testlerin birbirini etkileyebildiği bir ortam yaratıyor; `AGENTS.md`'deki "spes yalnız tek başına koşunca geçiyorsa hatalıdır" ilkesinin Python karşılığı.

**c) Zayıf doğrulama deseni.** Tüm `tests/` ağacında **`assert … is not None` biçiminde 50 doğrulama** var (en yoğun: `test_cache.py` 7, `test_storage_core.py` 7, `test_ai_mcp.py` 6). Bunların hepsi hatalı değil — ama "nesne üretildi mi" seviyesinde kalan doğrulamalar, CDP tarafında 1017 testin yeşil olmasına rağmen yakalanan `assert len(history) >= 0` sınıfının genel hali.

**Karşılaştırma notu:** CDP'de test sayısı yüksek (1017) **ve** kalite denetimi alt ajanlar tarafından satır düzeyinde yapıldı (bir testin hangi şeyi sabitlediği okundu). Scrapling'de test sayısı 441 civarında ve kalite ölçümü yapılmamış — bu yüzden A6 puanları her iki tarafta da **okumaya dayalı**, koşuma değil.

### 8.5 Eksen bazlı karşılaştırma (şimdilik: 7 API yüzeyi ↔ 41 CDP aracı)

| Eksen | Scrapling (7 yüzey) | CDP (41 araç) | Fark |
|---|---:|---:|---:|
| A1 Açıklama netliği | 4,9 | 6,8 | −1,9 |
| A2 İmza hijyeni | 4,9 | 7,1 | −2,2 |
| A3 Hata semantiği | 5,1 | 7,1 | −2,0 |
| **A4 Kanıt/verifikasyon** | **4,9** | **7,5** | **−2,6** |
| A5 Kılavuz kapsamı | 6,1 | 8,4 | −2,3 |
| A6 Test desteği | 5,4 | 7,3 | −1,9 |
| **TOPLAM** | **4,9** | **7,3** | **−2,4** |

**En derin fark A4'te (−2,6)** — ve bu tesadüf değil, iki projenin en karakteristik farkı:

- CDP'de araçlar **çıktının yeterli olduğunu varsaymak** zorunda kalıyor; "kanıt" ekseni orada bile 7,5 çünkü `actionability`, `coveredBy`, `didAct`, `postCondition`, `complete` gibi alanlar **tasarımın parçası**.
- Scrapling'de kütüphane **sonucu üretiyor ama inandırıcılığını taşımıyor**: adaptif skor (`parser.py:562-577`), Cloudflare çözüm durumu (`_stealth.py:118-122`), `wait_selector`/`page_action` çalışması (`_controllers.py:159,172,180`), yönlendirme geçmişi (`convertor.py:72-78`), `encoding` (`convertor.py:118→126`). Hepsi `log.*` içine gidiyor.

**Yani Scrapling'in farkı belgede değil, sözleşmede.** CDP'de kılavuzun aracı yanlış anlatabiliyordu; Scrapling'de kılavuz büyük ölçüde **doğru**, ama aracın kendisi "oldu" ile "olduğuna güveniyorum" arasındaki farkı modele taşımıyor. Karşılaştırmanın en kullanışlı cümlesi bu.

*(Diğer üç kol — spiders/CLI/MCP, skill seti, kod blokları — geldiğinde bu tablo genişleyecek; A4 farkının kapanıp kapanmadığı orada görülecek.)*

---

## 9. API YÜZEYİ PUANLARI — SPİDERS / CLI / MCP KOLU (7 yüzey)

| Yüzey | A1 | A2 | A3 | A4 | A5 | A6 | **TOPLAM** | Tek cümlelik hüküm |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| **MCP araçları (13 adet)** | **8,5** | **8,0** | **8,0** | **8,0** | 7,0 | 7,5 | **8,0** | **Denetimin tamamının en iyi dokümante yüzeyi** |
| CLI `mcp` | 8,0 | 7,5 | **9,0** | 6,0 | 5,0 | 5,5 | **7,2** | CLI'nin tek iyi yazılmış güvenlik yüzeyi |
| Spiders çerçevesi | 6,5 | 6,0 | 5,0 | **8,0** | 7,0 | **9,0** | **6,7** | Checkpoint ve istatistik güçlü; hata çoğunlukla yutuluyor |
| CLI `extract fetch`/`stealthy-fetch` | 7,0 | 7,5 | 4,0 | 3,5 | 5,0 | 3,5 | **5,3** | `--ai-targeted` doğru bağlanmış **tek** yer |
| CLI `shell` | 5,0 | 7,0 | 5,0 | 4,0 | 5,0 | 5,5 | **5,3** | En temiz argüman doğrulama; **SKILL.md hiç anmıyor** |
| CLI `extract get/post/put/delete` | 6,5 | 6,0 | 4,0 | 3,5 | 5,0 | 4,0 | **4,9** | Traceback-only hatalar; `--ai-targeted` ölü `block_ads` gönderiyor |
| CLI `install` | 4,0 | 5,5 | **3,0** | 3,0 | 5,0 | **1,0** | **3,7** | `try/except` bilinçli yok, **sıfır test** |
| **Kol ortalaması** | | | | | | | **5,9 / 10** | |

*Komut adları doğrulandı: `fetch` (cli.py:582) ve `stealthy-fetch` (cli.py:627) — "dynamic"/"stealthy" değil. SKILL.md:76-77 bunu doğru yazıyor.*

### 9.1 🔴 `--follow-redirects`: güvenlikle ilgili **yanlış** bir ifade ajana veriliyor (kendi ölçümüm)

Alt ajan bunu "SKILL.md yanlış diyor" diye bildirdi; ben kaynağı okuyunca bulgunun **daha ciddi** olduğunu gördüm, çerçeveyi düzeltiyorum.

Üç ayrı gerçek var:

| Katman | Gerçek | Kanıt |
|---|---|---|
| **Kütüphane/Python API** | varsayılan `"safe"` = *"follows redirects but rejects those targeting internal/private IPs (**SSRF protection**)"* | `static.py:692`, `:82`; `ai.py:466,540,1026`; `core/_types.py:43` (`FollowRedirects = Union[bool, Literal["safe","all","obeycode","firstonly"]]`) |
| **CLI bayrağı** | **bool** çifti, `default=True`, yardım metni *"(default: True)"* | `cli.py:262-265` |
| **SKILL.md** | `(default: "safe", rejects redirects to internal/private IPs)` | `SKILL.md:107` |

CLI her zaman `True`/`False` geçiriyor; `"safe"` modu **hiçbir yola ulaşmıyor.** SKILL.md'nin o satırı, kütüphane düzeyindeki doküstring cümlesinin **CLI tablosuna** olduğu gibi yapıştırılmış hâli.

**Neden bu en ciddi bulgu:** ajan bu tabloyu okuyup "varsayılan SSRF koruması var" diye güvenle `scrapling extract get` çağırıyor; oysa CLI varsayılanı **tüm yönlendirmeleri, iç IP'lere de dahil, izliyor.** Ajanın güvenliği azaltmak yerine **artırması** beklenen bir ayarda, güvence yok.

Bu, CDP'deki `cdp_tab_close`/"throw etmez" hatasının **güvenlik boyutlu** karşılığı: orada kılavuz yanlış bir hata tipi vaat ediyordu, burada yanlış bir **koruma** vaat ediyor.

### 9.2 🔧 Kendi önceki ölçümümün düzeltmesi — `--ai-targeted`'ın reklam engelleme kısmı HTTP komutlarında **ölü**

§3.1'de "bayrak reklam engellemeyi de otomatik açar" demiştim; bu **HTTP komutları için doğru değil:**

`cli.py:58-59` → `if ai_targeted: kwargs.setdefault("block_ads", True)` → ama `engines/static.py:153` `block_ads`'u `skip_keys` listesinde (*"ignored by HTTP sessions"*) ve `fetchers/requests.py:32` `**kwargs` kabul ettiği için **sessizce düşüyor.** `tests/fetchers/test_merge_request_args.py:20-24` bu düşüşü sabitliyor.

Yani `extract get/post/put/delete` için `--ai-targeted` yalnız `main_content_only` yapar; `extract fetch`/`stealthy-fetch` için (cli.py:362) iki şeyi de yapar. Kılavuzun tablosu (`:111`, `:162) ikisini de "otomatik ad blocking" diye tarif ediyor — HTTP için bu yanlış.

**Ve daha önemlisi — varsayılanlar ters yönde:**

| Yüzey | `main_content_only` varsayılanı |
|---|---|
| 6 CLI `extract` komutu | **`False`** (`cli.py:245,298`) |
| 13 MCP aracı | **`True`** (`ai.py:433,512,586,662,739,830,923,994` altısı; hepsi) |

Yani **MCP güvenli-varsayılan, CLI güvensiz-varsayılan.** Kılavuz CLI'yi öğretiyor ve CLI'de koruma açık değil.

### 9.3 Diğer doğrulanmış kusurlar

1. **MCP toplu araçlarında `asyncio.gather` `return_exceptions=True` olmadan çağrılıyor** (`ai.py:578, 730, 913`) — bir URL patlarsa 49 başarı da kayboluyor, kısmi sonuç yok. Yüzeyin en ciddi sessiz-başarısızlık modu.
2. **`docs/cli/**` ağacı ajan kılavuzunda hiç yok.** SKILL.md seçenek tablolarını **üçüncü kez** elle yazıyor (`:99-177`) ve zaten kaymış: `SKILL.md:76` `fetch` için "Use a browser to fetch content…" diyor, `cli.py:582` ise "Use DynamicFetcher to fetch content…" diyor.
3. **`docs/api-reference/mcp-server.md:8` "eleven powerful tools" diyor**, uygulama 13 kaydediyor. CDP'de araç sayısı üç ayrı yerde üç ayrı sayıydı — aynı sınıf.
4. **Başarısız istekler sayılıyor ama kim oldukları hiçbir yerde tutulmuyor.** `failed_requests_count` / `blocked_requests_count` çıplak tam sayılar (`result.py:128,140`); `CrawlStats`'ta URL bazlı bir hata defteri yok. Kullanıcı "12 istek başarısız" der, **hangi URL ve neden** sorusuna cevap yok. MCP katmanı bu sorunu tipli `ResponseModel(status, content, url)` ile çözmüş (`ai.py:96-101`) — CLI onu atıyor.
5. **`CrawlResult.completed`, `crawldir` verilmeden erken durdurulan bir taramada `True` dönüyor** (`result.py:207-209` + `engine.py:396-399`) ve `tests/spiders/test_engine.py:924` bunu kasıtlı sabitliyor — yani test, kendi doküstringine aykırı davranışı kilitliyor.
6. **`cli.py:25-28`** — `__Execute` içinde `try/except` yok ve satır `:28`'de yazarın kendi notu var: *"I meant to not use try except here"*. Başarısız `playwright install` → çıplak `CalledProcessError`.
7. **`proxy rotation` bir spider özelliği değil, session özelliği.** `scrapling/spiders/proxy-blocking.py` diye bir dosya yok; dönüşüm `ProxyRotator` (`engines/toolbelt/proxy_rotation.py:39`) ile **session'a** veriliyor. SKILL.md:23 "spider framework … automatic proxy rotation" diyor, araç zincirini söylemiyor.
8. **Bu kolun tek büyük gücü: test hacmi.** 560 test fonksiyonu (494 `tests/spiders/`, 73 `tests/ai/test_ai_mcp.py`, 38 `tests/cli/`), `pytest.ini` `--doctest-modules` çalıştırıyor, hata yolları **adıyla** sabitlenmiş (`test_blocked_response_max_retries_exceeded`, `test_retry_clears_proxy_kwargs`, `test_in_flight_request_survives_checkpoint_resume`). Eksik olan test sayısı değil — **var olmayan bir yeteneği sınayan test** (URL bazlı hata raporu, kuyruk derinliği, sonuçta `resumed` bayrağı).

### 9.4 ✅ Üç iddiayı kendim doğruladım

**(a) Zorunlu ilan edilen bayrağın sıfır testi.** `SKILL.md:37` `--ai-targeted`'ı **zorunlu** sayıyor ("you MUST use"). Kendi taramam: `tests/` ağacında `ai_targeted` / `ai-targeted` için **0 eşleşme.** Yani kılavuzun en güçlü güvenlik talimatının **hiçbir testi yok.**

Ama mekanizmanın kendisi testli: `main_content_only` için 6 test var ve biri dürüstçe isimlendirilmiş — `test_response_markdown.py:45`: *"Scripts, styles, and hidden elements are stripped even without main_content_only"*. Yani **sanitizer birim düzeyinde testli, CLI bayrağının bağlanması değil.** (Bu, CDP'deki `spill` vakasının tersi: orada mekanizma testliydi, gidiş-dönüş test edilmemişti; burada mekanizma testli, **kullanıcıya giden bağlantı** test edilmemiş.)

**(b) API referansı araç sayısını yanlış söylüyor — ajan kopyası doğru.** `docs/api-reference/mcp-server.md:8` (kendi satırıyla):
> *"The **Scrapling MCP Server** provides **eleven** powerful tools…"*

Kayıtlı araç sayısı **13** (`ai.py:1105-1187`, §7'de kendim saydım). Buna karşılık ajan kopyası `references/mcp-server.md:3` **"thirteen tools"** diyor ve **her araç için tür/varsayılan/açıklama içeren tam parametre tablosu** taşıyor — insan dokümanında olmayan bir şey.

**Karşılaştırmanın en tuhaf ama öğretici noktası:** Scrapling'de **insan dokümanı bayat, ajan kopyası taze.** CDP'de tam tersiydi (rehber 09 iki yerde kodu yanlış anlatıyordu). Yani "ajan metni ayrı bir ürün olarak yönetiliyor" disiplini burada işe yaramış.

**(c) `SCRAPLING_EXECUTABLE_PATH` ve auth token mantığı iki yerde uygulanmış** (`cli.py:576` ve `ai.py:193-194`) — tek sözleşme, iki uygulama. CDP'deki "bir olgu iki yerde, biri yavaş yazılıyor" sınıfının yazılım tarafındaki karşılığı.

---

## 10. KLAVUZ PUANLARI — 22 dosya (SKILL.md + 19 referans + 2 README)

### 10.1 🔧 Kendi ölçümümün düzeltmesi: paylaşılan dosya sayısı 16 değil **19**

Alt ajan benim §1'deki sayımı düzeltti ve haklı: 3 referans dosyası (`building-rag-systems.md`, `mcp-server.md`, `migrating_from_beautifulsoup.md`) `docs/` içinde alt klasörlerde (`ai/`, `tutorials/`) ama `references/` köküne **taşınmış**. Benim yol-eşleştirmem onları "yalnız referansta" saymıştı.

**Düzeltilmiş ölçüm: 19 paylaşılan dosya, 18'i farklı, 1'i birebir aynı** (`spiders/platform-templates.md` — ki o da türetilmemiş, mkdocs'siz olması şans).

**Türetmenin doğası** (alt ajanın sınıflandırması, ölçümle destekli): *mekanik-benzeri ama kayıplı bir yeniden yazım.* Beş tutarlı desen:
1. `!!! note` / girintili uyarı blokları → `**Note:**` olarak çözülüyor (tüm dosyalar) ✅ zararsız
2. **`!!! success "Prerequisites"` blokları 9 dosyada tamamen siliniyor** ← karar değeri olan "önce şunu oku" sırası yok ediliyor
3. Sayfalar arası "What's Next" gezinme bölümleri siliniyor
4. 2. tekil şahıs → edilgen çeviri
5. Dört dosyada gerçek içerik kaybı; bir dosya (`mcp-server.md`) baştan yeniden yapılandırılmış

### 10.2 Puan tablosu (22 dosya)

| Dosya | G1 | G2 | G3 | G4 | G5 | **TOPLAM** | Hüküm |
|---|---:|---:|---:|---:|---:|---:|---|
| `spiders/advanced.md` | 29 | 28 | 9 | 8 | 8 | **8,2** | Her varsayılan ve guard doğru — en güçlü dosya |
| `spiders/proxy-blocking.md` | 29 | 28 | 9 | 8 | 8 | **8,2** | Engelleme/retry kanıtlanabilir, strateji rehberi mükemmel |
| `spiders/getting-started.md` | 28 | 26 | 8 | 9 | 8 | **7,9** | En temiz giriş; "What's Next" silinmiş |
| `spiders/sessions.md` | 27 | 25 | 9 | 9 | 8 | **7,8** | Çoklu oturum doğru; `capture_xhr` örneği kırpılmış |
| `spiders/generic-templates.md` | 27 | 26 | 9 | 9 | 6 | **7,7** | Şablon API'si doğru; SKILL.md ile örnek çakışması |
| `spiders/platform-templates.md` | 28 | 22 | 8 | 9 | 8 | **7,5** | Birebir aynı; en yüksek doğruluk |
| `spiders/requests-responses.md` | 27 | 22 | 9 | 9 | 8 | **7,5** | API doğru; ne zaman kullanılacağına yönlendirme sığ |
| `mcp-server.md` | 25 | 24 | 10 | 8 | 7 | **7,4** | 13 araç doğru; "Breaking changes" ve client-kayıt JSON'ları düştü |
| `building-rag-systems.md` | 28 | 22 | 9 | 7 | 8 | **7,4** | Neredeyse hatasız; performans iddiası kanıtsız |
| `parsing/selection.md` | 27 | 21 | 10 | 8 | 8 | **7,4** | Seçici mantığı doğru ve detaylı |
| `parsing/main_classes.md` | 27 | 19 | 11 | 8 | 8 | **7,3** | 45 çapa çalışıyor; salt API tekrarı |
| `fetching/dynamic.md` | 25 | 22 | 9 | 8 | 8 | **7,2** | Doğru ve eksiksiz |
| `parsing/adaptive.md` | 26 | 22 | 9 | 7 | 8 | **7,2** | Doğru; iddialar ölçülmemiş |
| `fetching/static.md` | 26 | 20 | 8 | 8 | 8 | **7,0** | Parametreler doğru; hız iddiası kanıtsız |
| `fetching/choosing.md` | 22 | 26 | 6 | 7 | 8 | **6,9** | **En iyi karar tablosu**; 4 ölü bağlantı |
| `fetching/stealthy.md` | 24 | 21 | 9 | 8 | 7 | **6,9** | Camoufox bölümü ve CF doğrulama örneği silinmiş |
| `spiders/architecture.md` | 26 | 18 | 8 | 9 | 8 | **6,9** | Doğru bileşen dökümü; ajan için soyut |
| `migrating_from_beautifulsoup.md` | 25 | 20 | 8 | 8 | 7 | **6,8** | Doğru API tablosu; yönlendirme yok |
| `integrations/scrapy.md` | 20 | 16 | 8 | 9 | 8 | **6,1** | `convert_response` örneği hatalı; en zayıf karar değeri |
| **`SKILL.md`** | 21 | 22 | 7 | 6 | 6 | **6,2** | 4 çalıştırılabilir hata; TOC yok |
| `examples/README.md` | 22 | 24 | 3 | 6 | 7 | **6,2** | İyi tırmanma rehberi; SKILL.md'den erişilemiyor |
| **`agent-skill/README.md`** | 20 | 8 | 6 | 3 | 6 | **4,3** | "%90" ölçümsüz; `docs/cli` hiç kopyalanmamış |
| **Set ortalaması** | | | | | | **7,1 / 10** | |

**Kritik bölünme — CDP ile birebir aynı desen:** giriş noktası belgeleri **5,6**, referans gövdeleri **7,3.** CDP'de de gövde (6,7) referanslardan (8,2) düşüktü. **İki projede de "kapı" referanslardan daha zayıf** — ama neden farklı: CDP'de gövde *elle yazılmış ve hatalı*, burada referanslar *türetilmiş ve neredeyse sadık*, hatalar yine gövdede.

### 10.3 🔴 SKILL.md'deki dört çalıştırma hatası (ikisini kendim doğruladım)

**1 ve 2 — iki satır çalıştırılabilir değil.** ✅ *kendi ölçümüm:*

| SKILL.md | Kod | Gerçek | Sonuç |
|---|---|---|---|
| `:355` | `first_quote.next_sibling.css(...)` | `next_sibling` **hiçbir yerde yok** (tüm `scrapling/` ağacında 0 sonuç); gerçek ad **`next`** (`parser.py:452`) | `AttributeError` |
| `:360` | `first_quote.below_elements()` | `below_elements` bir **`@property`** (`parser.py:402-403`) | `TypeError: 'Selectors' object is not callable` |

İkisi de "Advanced Parsing & Navigation" bloğunda — ajanın **doğrudan kopyalayacağı** kod. Ve ironik olan: kılavuzun **kendi referansı** ikisini de doğru yazıyor (`references/migrating_from_beautifulsoup.md:32` → `element.next`; `references/parsing/main_classes.md:213` → property). Yani hata gövdede, doğru cevap aynı pakette 20 metre ötede.

**3 — `--follow-redirects` (§9.1'de ayrıntılı).** Kütüphane varsayılanı `"safe"` (SSRF koruması), CLI varsayılanı `True`; SKILL.md CLI tablosuna kütüphane varsayılanını yazmış.

**4 — async deseni `await` olmadan.** `SKILL.md:374-376`: `async with FetcherSession(...)` sonrası `session.get(...)` **`await` edilmeden** çağrılıyor; `__aenter__` asenkron mantığı kurduğu için `page1`/`page2` birer coroutine olur ve sonraki `.css()` patlar. Satır içi yorum ("can work in both sync/async patterns") ajanın güvenmesini sağlayan şey tam olarak bu.

### 10.4 Diğer doğrulanmış kusurlar

1. **SKILL.md kendi bayrak tablosuyla çelişiyor:** `:23` "Cloudflare Turnstile **out of the box**" diyor; `:175` `--solve-cloudflare … (default: False)` ve `StealthSession.solve_cloudflare` varsayılanı False (`_types.py:121`). Aynı çelişki `examples/03_stealthy_session.py:5-7`'de.
2. **Yanlış tarayıcı motoru:** `choosing.md:24` StealthyFetcher için "PlayWright" diyor; uygulama **`patchright`** kullanıyor (`_stealth.py:8-9`). Yalnız `DynamicFetcher` gerçek Playwright.
3. **Türetme sırasında 5 ölü göreli bağlantı üretilmiş:** `references/fetching/choosing.md:36,50,60,84` ve `static.md:86` → `parsing/main_classes.md#selector`; asıl `docs/` sürümleri `../parsing/…` idi. `../` atılınca `references/fetching/parsing/…` gibi var olmayan bir yola bakıyorlar. ✅ *kendi ölçümüm: `references/**` içindeki 41 göreli `.md` bağlantısını taradım — **5'i ölü**, hepsi `parsing/main_classes.md` hedefi.*
4. **`benchmarks.py` yalnız parser'ı ölçüyor** (146 satır; 5.000 iç içe öğe, `find_by_text`/`find_similar` karşılaştırması, 100 tekrar). **Çekme, stealth, Cloudflare, bellek veya spider verimine hiç ölçüm yok.** O halde şu iddiaların **hiçbirinin** ölçülmüş dayanağı yok: "Blazing fast crawls" (`SKILL.md:25`), 🐇/⭐ hız ve **bellek** puanları (`choosing.md:17-21`), "fetch ile stealthy-fetch neredeyse aynı hızda" (`:93`), "10 kat daha hızlı" (`static.md:249`), "~%25 daha hızlı" (`stealthy.md:75`). Üstelik `benchmarks.py` **hiçbir `pyproject.toml` extra'sında olmayan** paketleri içe aktarıyor — kılavuzun kendi ölçümünü kendi kurulum talimatıyla yeniden üretemiyor.
5. **`%90` iddiası içerik olarak da yanlış:** `docs/cli/**` (3 dosya, 31 KB — `extract` için yetkili referans), `docs/overview.md`, `docs/index.md`, `docs/development/**`, `docs/tutorials/replacing_ai.md` referans ağacında **karşılığı yok.** SKILL.md'deki CLI tabloları doküman değil, elle yazılmış bir özet.
6. **Gezinilebilirlik en zayıf boyut:** SKILL.md 416 satır / 15 başlık, **içindekiler yok, çapa yok.** References listesi 7 girdi, **3'ü dizin** → **19 referans dosyasının 16'sı hiç adlandırılmıyor.** `examples/` SKILL.md'de hiç geçmiyor.
7. **`mcp-server.md` operasyonel içerik kaybetmiş:** tüm `## Breaking changes` bölümü (v0.4.15'te `get`→`make_request`, one-shot araçlar artık `session_id` kabul etmiyor, `--http` auth'suz başlamayı reddediyor) ve **tüm** istemci-kayıt JSON'ları düştü. Kalanı doğru ve **her araç için düz parametre tablosu** taşıyor — insan dokümanında olmayan, ajan için **daha iyi** bir yapı. Tek dosya burada yeniden yazımın **kazandırdığı** yer.
8. **Referanslar `docs/`'den değil, kısmen SKILL.md'den türetilmiş:** `references/spiders/generic-templates.md:14-` içindeki `BlogCrawler` örneği **SKILL.md:311-326 ile bayt bayt aynı** — tek olgunun iki evi.

---

## 11. KOD BLOKLARI — TÜR DAĞILIMI (kendi ölçümüm)

CDP denetiminde soru "bloklar çalışıyor mu?" idi ve cevap şuydu: 52 bloğun 50'si akış diyagramı. Aynı soruyu Scrapling'e sordum:

| Yüzey | Blok | `python` | `bash` | `html` | `json` | Etiketsiz |
|---|---:|---:|---:|---:|---:|---:|
| `agent-skill/**` (21 dosya) | **284** | **245 (%86)** | 21 | 4 | 2 | 14 |
| `docs/**` (38 dosya) | 339 | 287 | 47 | 8 | 6 | 13 |
| `README.md` | 24 | 13 | 10 | — | — | 1 |
| **Depo geneli (60 dosya)** | **683** | **562 (%82)** | 84 | 12 | 8 | 16 |

*(İlk ölçümüm yalnız **etiketli** blokları saydı ve `agent-skill` için 267/240 verdi; yukarıdaki envanter etiketsizleri de kapsıyor. Kısmi ölçüm, eksik ölçümdür — düzeltildi.)*

**Karşılaştırmanın en keskin tek satırı:**

| | CDP | Scrapling |
|---|---|---|
| Ajan yüzeyindeki blok | 51 | **267** |
| Bunun gerçek kodu | **1 (%2)** | **240 (%90)** |
| Etiketsiz/akış diyagramı | 50 | 0 |

Yani **bu iki "kılavuz" tamamen farklı türler.** CDP'nin kılavuzu bir *karar* belgesi — akış şemaları, tablo satırları, bir tane bile gerçek kod yok. Scrapling'in kılavuzu bir *programlama* belgesi — dörtte biri Python, kopyalanıp çalıştırılabilir olması amaçlanmış.

**Bu, sonraki her şeyi belirliyor:**
1. Scrapling'de kod bloklarının puanı **C1 (imza doğruluğu) ve C2 (çalıştırılabilirlik)** üzerinden verilir; CDP'de bu iki eksen ölçülemezdi çünkü kod yoktu — orada ölçülen "akış doğru mu" idi.
2. Kod bloğu hatalarının **bedeli yüksektir:** §10.3'teki `next_sibling` / `below_elements()` hataları bir akış diyagramında görünmezdi; burada ajanın kopyalayacağı satırlar.
3. Buna karşılık Scrapling'in kılavuzu **kopyalanabilir** — CDP'de ajan kod yazmak zorundaydı, kılavuz ona ne yazacağını söylemiyordu.

### 11.1 Kod bloğu envanteri — 60 dosya, 683 blok

| Tür | Adet | Not |
|---|---:|---|
| `python` | **562** | 399 gerçek kod + **163 REPL dökümü** (`>>>` ve baked-in çıktı satırları) |
| `bash` / `commandline` | 84 | |
| `html` | 12 | |
| `json` | 8 | |
| etiketsiz | 16 | 13'ü MCP istem metni, 2'si backoff rampası, 1'i ASCII tırmanma ağacı |
| **mermaid** | **0** | CDP'de grafik dili yoktu, burada da yok |

### 11.2 Blok puanları (C1 imza 40 · C2 çalıştırılabilirlik 30 · C3 değer 30)

| Dosya grubu | C1 | C2 | C3 | Ağırlıklı |
|---|---:|---:|---:|---:|
| `spiders/*` dokümanları (generic-templates, advanced, sessions, getting-started, requests-responses, architecture, platform-templates) | 9,3–10 | 9–9,5 | 7–9,5 | **8,8–9,6** |
| `tutorials/migrating_from_beautifulsoup.md` | 10 | 9 | 9,5 | **9,6** |
| `ai/building-rag-systems.md`, `fetching/stealthy.md` | 9,5–10 | 8–8,5 | 9,5 | **9,2–9,3** |
| `fetching/dynamic.md`, `fetching/static.md`, `fetching/choosing.md`, `parsing/adaptive.md` | 9,5 | 7–9 | 7–9,5 | **8,6–8,9** |
| `parsing/selection.md`, `parsing/main_classes.md` | 9,5 | **6–6,5** | 7–8 | **7,7–8,2** |
| `api-reference/*` (7 dosya) | 10 | 9 | **2** | **7,3** |
| `integrations/scrapy.md` | **4** | **4** | 8 | **5,2** |
| **`agent-skill/Scrapling-Skill/SKILL.md`** | **5** | **5** | 7 | **5,6** |
| **`README.md`** | **6** | **5** | 6 | **5,7** |
| **Genel (399 kod bloğu)** | **8,4** | **7,9** | **7,6** | **8,0 / 10** |

**Değer tek tek dosyalarda değil, uçlarda toplanmış:** 8 dosya ≥9,2, 5 dosya ≤7,9. Düşük grubu düzeltmek yüksek grubu cilalamaktan ~10 kat daha değerli.

### 11.3 🔴 Blok kusurları — ✅ üçünü kendim doğruladım

**Üç halüsinasyon, iki vitrin dosyada, tek blokta** (`SKILL.md:341-361` "Advanced Parsing & Navigation" ve aynı bloğun `README.md` kopyası):

| Satır | Kod | Gerçekim (kendi ölçümüm) | Çalıştırılınca |
|---|---|---|---|
| `SKILL.md:349` | `page.find_by_text('quote', tag='div')` | `find_by_text(text, first_match, partial, case_sensitive, clean_match)` — **`tag` yok** (`parser.py:1111-1118`) | `TypeError` |
| `SKILL.md:355` | `first_quote.next_sibling` | **`next_sibling` tüm ağaçta yok**; gerçek `next`/`previous` (`parser.py:452,464`) | `AttributeError` |
| `SKILL.md:360` | `first_quote.below_elements()` | `@property` (`parser.py:402-403`) | `TypeError: 'Selectors' object is not callable` |

Üçü de **BeautifulSoup/parsel kalıplarından gelmiş hatıralar** ve üçü de yalnızca **ajanın ilk okuyacağı iki dosyada** görünüyor; `docs/` altında hiçbiri yok. Yani bozulma, okuma sırasının başındaki yüzeye lokalize.

**Diğer öne çıkanlar:**
1. **`--ai-targeted` zorunlu ilan edilmiş, ama 16 çalıştırılabilir örneğin 0'ı kullanıyor** — `SKILL.md:124,127,130,133,136,139,184,187,190,193,196,199` ve `README.md:489-492`. Üstelik `CHANGELOG.md:433` bunu bir kural olarak kaydediyor. **Koruma her yerde belgelenmiş, hiçbir yerde gösterilmemiş.**
2. **Modül seviyesinde `await` / `async with`** — 6 dosyada ~35 satır, kopyalayınca `SyntaxError`. Aynı dosyanın başka blokları doğru yuvalanmış (`dynamic.md:140` ↔ `:235`) → kayma, niyet değil. Ve async örnekler hiçbir yerde `asyncio.run` ile çağrılmıyor.
3. **`--follow-redirects` iki dosyada iki şekilde** (§9.1).
4. **`docs/spiders/proxy-blocking.md:78` özel modül öğretiyor** — `from scrapling.core._types import ProxyType`; dosyanın kendi başlığı "type checking purposes" diyor. `:115`'te `proxies` tanımsız (`NameError`).
5. **`page.mouse.wheel(10, 0)`** — metin "fare tekerleğiyle kaydır" diyor, Playwright imzası `(deltaX, deltaY)` → yatay 10px, dikey 0.
6. **REPL dökümleri `python` etiketiyle işaretlenmiş.** `parsing/main_classes.md` 47/58, `selection.md` 29/43 — ajan "örneği kopyala" derse kopyalayamaz, hiçbir yerde de "çalıştırılamaz" işareti yok.
7. ✅ **Tüm korpusta sıfır import yolu hatası.** `scrapling.fetchers`'ın 10 adı, `scrapling.spiders`'ın 15 adı, `Selector`, `Response`, `ScraplingMCPServer`, `scrapling_response`, `convert_response` — hepsi çözülüyor. Az ilginç yollar (`scrapling.engines.toolbelt.custom.Response`) bile doğru seçilmiş.
8. ✅ **`docs/spiders/*` bu depodaki en güçlü yüzey ve 7'nin altında tek kusuru yok.** Her sınıf özniteliği, her kanca imzası, her `CrawlStats` alanı ve her şablon-spider sözleşmesi `scrapling/spiders/**` ile birebir tutuyor.

---

## 12. KARŞILAŞTIRMA VE HÜKÜM

### 12.1 Puan karşılaştırması

| Ölçüm | CDP eklentisi | Scrapling | Fark |
|---|---:|---:|---:|
| **Araç/API yüzeyi** (ortalama) | **7,3** (42 araç) | **5,4** (14 yüzey) | −1,9 |
| — en iyi yüzey | `cdp_locate` **9,6** | MCP araçları **8,0** | −1,6 |
| — en zayıf yüzey | `cdp_navigate` **4,6** | CLI `install` **3,7** | −0,9 |
| — puan yayılımı | 4,6 → 9,6 (5,0) | 3,7 → 8,0 (4,3** | benzer |
| **Kılavuz** (ortalama) | **6,5** (12 dosya) | **7,1** (22 dosya) | **+0,6** |
| — giriş noktası belgeleri | 6,7 | **5,6** | −1,1 |
| — referans gövdeleri | 8,2 | **7,3** | −0,9 |
| **Kod bloğu** (C1 ağırlıklı) | **8,4** (51 blok) | **8,0** (683 blok) | −0,4 |
| — gerçek kod oranı | 1 / 51 (**%2**) | 399 / 683 (**%58**) | — |
| — `python` etiketli blok | 1 | 562 | — |

*Scrapling API ortalaması = 14 yüzeyin ağırlıklı ortalaması (fetcher/parser kolu 4,9 × 7 + spiders/CLI/MCP kolu 5,9 × 7).*

### 12.2 İki projenin kusuru **ters yönde**

| | CDP | Scrapling |
|---|---|---|
| Kılavuz aracı doğru anlatıyor mu? | ❌ hayır — `cdp_tab_close` "throw etmez", `cdp_expect` konumlayıcısız, spill yolu ölü | ⚠️ çoğunlukla evet — ama 4 satır **çalıştırılabilir değil** ve bir güvenlik satırı **yanlış** |
| Araç "oldu" ile "olduğuna güveniyorum" arasını ayırıyor mu? | ✅ çoğunlukla — `actionability`, `coveredBy`, `didAct`, `postCondition` | ❌ hayır — adaptif skor, CF çözüm durumu, `wait_selector` çalışması, redirect geçmişi, `encoding`: hepsi `log.*` içinde |
| Ajan metni ayrı bir ürün mü? | tek kopya, kayma riski düşük | ✅ ayrı ürün — ve bir yerde **insan dokümanından daha iyi** (MCP parametre tabloları) |
| Kopya bayatlayabilir mi? | hayır | ⚠️ evet — 19 dosyanın 18'i ayrışmış, hiç kapı yok |
| Kılavuzu doğrulayan otomatik kontrol | ✅ 5 skill spec + (dar) repo kapısı | ❌ **hiç yok** |

**Tek cümlelik fark:**
> **CDP'de kılavuz, aracın doğru davranışını yanlış anlatıyordu. Scrapling'de kılavuz büyük ölçüde doğru, ama aracın kendisi "oldu" ile "olduğuna güveniyorum" arasındaki farkı modele taşımıyor.**

### 12.3 Eksen bazında en derin fark: kanıt

| Eksen | Scrapling | CDP | Fark |
|---|---:|---:|---:|
| **A4 Kanıt/verifikasyon** | **5,2** (14 yüzey) | **7,5** | **−2,3** |
| A5 Kılavuz kapsamı | 5,8 | 8,4 | −2,6 |
| A2 İmza hijyeni | 5,2 | 7,1 | −1,9 |
| A3 Hata semantiği | 5,0 | 7,1 | −2,1 |
| A1 Açıklama netliği | 5,2 | 6,8 | −1,6 |
| A6 Test desteği | 5,5 | 7,3 | −1,8 |

*(Scrapling A-eksenleri 14 yüzey üzerinden ağırlıklı; CDP 41 araç üzerinden.)*

### 12.4 Neden fark burada?

Ölçümün gösterdiği ve kodun doğruladığı tek cümle: **Scrapling loglama'yı kanıt yerine kullanıyor.**

`log.debug` (adaptif skor, `parser.py:563-568`) · `log.error` (`page_action`/`wait_selector`, `_controllers.py:159,172,180`) · `log.error` + `return None` (Cloudflare, `_stealth.py:118-122`) · `log.warning` (eşik altı, `parser.py:573-576`) · `print()` (`cli.py:142`).

Hepsi doğru seçimler, ama **varsayılan seviyede görünmezler** ve çağıranın eline bir alan olarak geçmezler. CDP'de aynı ihtiyaç şemaya **alan** olarak girdi: `ok:false` + `reason`, `actionability`, `coveredBy`, `delivered`.

Scrapling'de bu, kod tabanında **tutarlı bir politika** olsaydı tek bir kararla çözülürdü. Şu anda politika dağınık: `core/shell.py:588-590` ve `integrations/scrapy.py:16-18` eylem alabilir `ModuleNotFoundError` verirken, `_controllers.py:4-11` çıplak `ModuleNotFoundError` veriyor; CLI `mcp` `ValueError`'ı temiz `UsageError`'a çeviriyor (`cli.py:195-197`), `extract` komutları çevirmiyor.

### 12.5 Önerilen düzeltme sırası (maliyet/etki)

| # | Düzeltme | Dosya | Maliyet | Etki |
|---|---|---|---:|---|
| 1 | `next_sibling` → `next`, `below_elements()` → `below_elements` | `SKILL.md:355,360` | 2 satır | Kopyalanamayan iki satırı çalıştırılabilir yapar |
| 2 | `--follow-redirects` satırını CLI gerçeğine çevir (veya "Python API'de `safe`" diye ayır) | `SKILL.md:107` | 1 satır | Güvenlikle ilgili yanlış inancı kaldırır |
| 3 | async örneğine `await` koy | `SKILL.md:374-376` | 3 satır | Kırık async deseni düzeltir |
| 4 | Adaptif skoru döndür (`match_score`) | `parser.py:571-572` | ~5 satır | Kütüphanenin imza özelliği kanıtlanabilir hâle gelir |
| 5 | `page_action`/`page_setup`/`wait_selector` hatalarını `Response` üzerinde bir alanda belirt | `_controllers.py:159,172,180` | ~10 satır | Sahte başarı kapanır |
| 6 | `docs/cli/**`'ı `references/` altına kopyala ve SKILL.md'deki elle tabloyu kaldır | `references/cli/**` | mekanik | Üçüncü kopya ve 5 ölü bağlantı sorunu kapanır |
| 7 | SKILL.md'ye içindekiler + `references/` dosya listesi | `SKILL.md` | ~15 satır | 19 dosyanın 16'sı erişilebilir olur |
| 8 | `benchmarks.py`'ya gerçekten iddia edilen şeyleri ölç (çekme, stealth) | `benchmarks.py` | 1 gün | "10 kat", "%25", ⭐⭐⭐ iddiaları kanıtlanır |
| 9 | Ajan kılavuzunu doğrulayan tek bir CI işi (parametre adları, import yolları, sürüm eşleşmesi) | `.github/workflows/` | ~30 satır | 4 sürüm bayatlaması ve bu rapordaki blok hataları kapanır |
| 10 | `docs/api-reference/mcp-server.md:8` "eleven" → "thirteen" | 1 dosya | 1 kelime | — |

**1, 2 ve 3 toplam 6 satır; 10 tek kelime.** Bu rapordaki en ağır on kusurun maliyeti, `SKILL.md`'nin (416 satır) yüzde birinin altında.

---

*Bu kart `CDP-PUAN-KARTI.md` ile aynı çerçeveyi kullanır. Kendi ölçtüğüm her iddia `path:line` kanıtı taşır; kanıtı olmayana puan verilmemiştir. Bu oturumda **üç kez kendi ölçümüm yanlış çıktı ve kaynak okumasıyla düzeltildi**: (1) 18 CLI bayrağını "yok" sayan ilk tarama, (2) `--ai-targeted`'ın savunma iddiasına ilişkin şüphem, (3) paylaşılan dosya sayısı 16 → 19. Üçü de rapora düzeltilmiş haliyle girdi.*
