# SKILL-KİT DENETİMİ — `C:\Users\metin\Desktop\SKILL-KIT`

**Denetlenen:** `SKILL-KIT` — 19 dosya · 166.666 karakter · 3.383 satır
**Yöntem:** Kitin kendi disipliniyle: A0 envanter → A1 kaynakla karşılaştırma → **A4 kırmızıya düşürme** → A6 kanıt kaydı.
**Kapsam:** Yöntem belgesi + kapı aracı + şablonlar + kontrol listesi + fixture'lar + örnek. İkisi birlikte değerlendirildi.

> Hiçbir kit dosyası değiştirilmedi. Mutasyon deneyleri `.probe/` adlı **kopyada** yapıldı ve silindi; self-test sonrası yeniden koşturuldu.

---

## 0. HÜKM

| Soru | Cevap |
|---|---|
| Kit işe yarar mı? | **Evet.** Verdiğim 7 açıktan **3'ünü kapatıyor** — en pahalı olanı: artık "kapı yazma şablonu yok" sorunu yok, kapı **hazır geliyor**. |
| Kapı aracı gerçek mi? | **Evet ve iyi.** Kendi kendini kanıtlıyor: temiz 8/8 yeşil, kırık 8/8 kırmızı, ayırt edicilik ayrıca doğrulanıyor. |
| Yanlış pozitif üretir mi? | **Üretimde 6/8 kapı sıfır yanlış pozitif ile geçti.** Kalan 2 kapının bulgularının **~%36'sı dedektör artefaktı** — ölçüldü. |
| Modele verilir mi? | **Verilir — ama iki düzeltmeden sonra.** Aşağıdaki K1 ve K2. |

**Tek cümlelik:** Bu, manifesto + uygulanabilir bir üretim hattı. Yöntemin boşluğu "kapı yok"tu; kit o boşluğu 892 satırlık çalışan bir araçla kapattı. Kalan sorun **aracın hassasiyeti**, yöntemin değil.

---

## 1. ENVANTER (ölçülmüş)

| Dosya | Karakter | Satır | Rolü |
|---|---:|---:|---|
| `00-BASLA.md` | 3.123 | 64 | Giriş: 7 adımlı sıra + kabul kriterleri |
| `YONTEM.md` | 90.046 | 1.590 | Yöntem (manifestonun kendisi) |
| `KONTROL-LISTESI.md` | 9.723 | 219 | Dört tur: (a) yazmaya başlarken → (d) yeniden gözden geçirme |
| `ARAC/skill-hat-gate.mts` | 44.171 | 892 | **8 kapılı ölçüm aracı** |
| `ARAC/hat-self-test.mts` | 4.176 | 98 | Aracın kendi kırmızı testi |
| `ARAC/fixtures/temiz-skill/` | 6.660 | 199 | Yeşil senaryo (4 araç) |
| `ARAC/fixtures/kirkik-skill/` | 3.953 | 156 | Kırık senaryo (4 araç, 8 kapı kırık) |
| `SABLON/SKILL.sablon.md` | 1.276 | 51 | Gövde iskeleti |
| `SABLON/ATIF-TABLOSU.sablon.md` | 1.291 | 28 | Spiderweb tablosu |
| `SABLON/YOL-KUMESI.sablon.md` | 1.616 | 47 | Polimorfizm kümesi |
| `ORNEK/README.md` | 1.631 | 32 | "İyi ama mükemmel değil" örneği |

### 1.1 Yöntem belgesi değişmemiş

`YONTEM.md` ile bana daha önce gönderdiğiniz manifesto **byte-byte aynı**:

```
manifesto chars: 90046      YONTEM chars: 90046
birebir ayni    : True
başlık farkı    : 0 (ne eklenmiş ne çıkmış)
```

**Yani kitin yeniliği yöntem değil, yöntemin etrafına konan üretim hattı.** Bu doğru bir karar: yöntem belgeyleşmiş, artık çalıştırılabilir hale getirilmiş.

---

## 2. KAPİ ARACI — teknik değerlendirme

### 2.1 Sekiz kapı ne ölçüyor

| Kapı | Ölçüm | Kod |
|---|---|---|
| **G1 KAPSAM** | Her araç yalnız adıyla geçmiyor mu (derinlik 0/1/2/3) | `:307-336` |
| **G2 İDDİA-KOD** | Klavuzdaki imza kaynak kodun imzasıyla uyuşuyor mu (hayalet parametre, enum dışı değer) | `:253-305` |
| **G3 ERİŞİLEBİLİRLİK** | Enjekte edilen gövdeden her araca yol var mı | `:392-405` |
| **G4 SPIDERWEB** | Ağ yoğun mu, çift yönlü mü, izole düğüm var mı | `:560-656` |
| **G5 POLİMORFİZM** | Her kümede yol + karar ağacı + yedek plan + varsayılan | `:660-705` |
| **G6 LİNK BÜTÜNLÜĞÜ** | Kırık dosya/çapa, indexlenmemiş rehber, kaynakta olmayan araç atıfı | `:707-767` |
| **G7 KIRMIZI-TEST** | Kırmızıya düşürme kanıtı var mı | `:769-785` |
| **G8 ENJEKSİYON** | Frontmatter ayrışıyor mu, name kebab-case mi, description sınırda mı | `:787-804` |

### 2.2 Kod kalitesi — beklediğimden iyi

Yorumlar niyet açıklamaz, **kendi sınırlarını ve kırılganlıklarını** belgeler. Örnekler:

- `:315-317` — *"Pencere BÖLÜM SINIRIyla kesilir. Sabit ±14 satır, bir aracın maddesini komşu aracın hata sinyalleriyle doldurur ve 'adı geçen' aracı 'belgeli' sayar — yani kapı, tam olarak yakalaması gereken kusuru gizler."* → Bu, düzeltilmiş bir **yanlış pozitif** kaydı. Yazara, kapısının neyi kaçırdığını bilen biri olduğunu gösteriyor.
- `:277-278` — enum'ların **yalnız girdi şemasından** okunması, çıktı şemasındaki aynı adlı alanın parametreyi yanlış enum'la ezmemesi için. Bu, cdp'de `cdp_dialog(action)` ile `cdp_captcha(action)`'ın çakıştığı gerçek bir tuzaktır.
- `:392-395` — *"Bağlantı çözümleme tabanı, gövdenin bulunduğu klasör DEĞİL; resourceBase. Bu ayrım yanlışsa gövdedeki HER rehber bağlantısı 'kırık' görünür ve ölçüm kendi kendini çürütür."* → cdp'nin `src/skill.ts:112`'deki `resourceBase` kararının doğru okunması.
- `:561-565` — düğüm sütununun "en çok ad geçen" sütunla değil, "tekil ve tam eşleşen" sütunla bulunması. Kaba bir heuristik'in neden yanıltıcı olacağının farkındalığı.

**Envanter de el yazımı değil:** `:253-287` kaynak dosyadan okuyor ve `// 12. tool_adi` yorum işaretini, yoksa `name: '...'` kayıtlarını kullanıyor. "Eski liste, tüm assert'ları boş yapardı" gerekçesi yazılı.

### 2.3 Aracın kendi kendini sınaması

`hat-self-test.mts` üç faz çalıştırıyor ve hepsi yeşil:

| Faz | Beklenen | Ölçülen |
|---|---|---|
| [1] temiz-skill | 8/8 yeşil | ✅ 8/8, `EXIT 0` |
| [2] kirkik-skill | 8 kapı kırık | ✅ G1–G8 ayrı ayrı kırmızı, her biri için *hangi bulgunun* düşürdüğü yazılı |
| [3] ayırt edicilik | temiz ≠ kırık | ✅ 7 ayrı ayrım ölçümü |

Faz [2] özellikle değerli: kırık fixture'da `G3 → unreachable-tool, body-links-missing-guide`, `G6 → broken-link, broken-anchor, unindexed-guide, dead-tool-ref` gibi **bulgu kodları** listeleniyor. Yani araç "kapı kırık" deyip geçmiyor, **neyi neden kırdığını** söylüyor. Manifestonun T15'i ("bu test ne zaman kırmızı olur?") burada fiilen uygulanmış.

---

## 3. SINIR TESTİ — gerçek üretimde sıfır yanlış pozitif

Kitin kendi fixture'ı kendi aracına karşı kanıttır ama **çok kolay**dır. Asıl test, olgunlaşmış üretim skill setine koşurmak:

```
node ARAC/skill-hat-gate.mts --bundle "…\DSH v2\packages\bundle\cdp"
→ envanter: 36 araç · ağ rehberi: 10-skill-mimarisi.md · EXIT 1
```

| Kapı | Sonuç | Bu ne diyor |
|---|---|---|
| G1 KAPSAM | ✅ %100, 36/36 derinlik ≥2, 24'ü derinlik 3 | Hiçbir araç yalnız adıyla geçmiyor |
| G2 İDDİA-KOD | ✅ **147 belgelenmiş çağrı, 0 hayalet parametre, 0 enum dışı değer** | En güçlü tek sonuç: 1.197 satırlık rehberde 147 örnek çağrının **tamamı** kaynak şemayla uyumlu |
| G3 ERİŞİM | ✅ 36/36 bir atlama, 0 ulaşılamaz | Gövde tek başına yeterli |
| G6 LİNK | ✅ 10 rehber, 0 kırık dosya/çapa/indexlenmemiş/ölü araç atıfı | — |
| G7 KIRMIZI | ✅ 17 işaret | (aşağıda zayıf olduğunu tespit ettim) |
| G8 ENJEKSİYON | ✅ name kebab, description 470/500 | — |
| **G4 SPIDERWEB** | ❌ 74 kenar, **33 tek yönlü** | 12 artefakt + 21 gerçek (aşağıda ölçüldü) |
| **G5 POLİMORFİZM** | ❌ 9 küme, **4'ünde yedek plan yok, 3'ünde varsayılan yok** | 2–3 gerçek, 3 yanlış pozitif |

**6/8 kapı, 36 araçlık gerçek bir sistemde, sıfır yanlış pozitif ile geçti.** Bir yazım aracı için bu olağanüstü bir kalibrasyon sinyalidir. Çoğu "kontrol listesi" üretimde ilk çalıştırmada yüzlerce uyarı üretir; bu araç üretmiyor.

---

## 4. EN ÖNEMLİ BULGU — G4 prose körlüğü (deneyle kanıtlandı)

G4'ün 33 bulgusunun ne kadarının gerçek olduğunu **kapının kendi algoritmasını yeniden uygulayarak** ölçtüm:

```
toplam kenar                : 74     ← kapıyla birebir aynı
tek yönlü (capinin dediği)  : 33
  ├─ prose artefaktı        : 12
  └─ GERÇEK                  : 21
```

12 artefaktın **11'i tek bir hücreden** geliyor: `cdp_expect` satırının `öncesi` hücresi `**her mutasyon**` yazıyor — yani "her araçtan gelir", ki bu adı geçen her şeyi **kapsayan** bir ifadedir. Kapı ise araç adı içermediği için bu hücreyi boş sayıyor ve `cdp_expect`'e gelen **her kenarı** tek yönlü ilan ediyor.

### 4.1 Kanıt deneyi (3 adım, temiz fixture kopyasında)

| Adım | Değişiklik | G4 hükmü |
|---|---|---|
| 0 | dokunulmadı | 3 kenar · 0 tek yönlü · **8/8 yeşil** |
| A | `mini_poke → mini_dock` eklendi; hedefin `öncesi`'si araç adı (`mini_read`) | 4 kenar · **1 tek yönlü** · G4 kırık ← *doğru bulgu* |
| B | hedefin `öncesi`'si **prose**: `**her akışın sonu**` ("her akışın sonu" = her predecessor'i kapsar) | 4 kenar · **2 tek yönlü** · G4 kırık |
| C | hedefin `öncesi`'si: `` `mini_read` · `mini_poke` (akışın sonu) `` | 4 kenar · **0 tek yönlü** · **8/8 yeşil** |

**B ve C aynı anlamı taşıyor. B daha dürüst, daha okunur, daha kesin bir ifade — ve kapı onu daha kırmızı buluyor.**

> Bu, kitin kendi manifestosunun **T17** sınıfının tam kendisi: *"guard, tam olarak varlığını savunduğu düzeltmeyi cezalandırmamalı."* Kapı, prose yazımı cezalandırıyor; modeli araç adı listelemeye, yani *makine okunabilir ama daha az doğal* bir üsluba itiyor.

**Düzeltme (tek satır):** `skill-hat-gate.mts:616` — karşılık kontrolü, hedefin `öncesi` hücresinde **hiç araç adı yoksa** "bu bir üst-küme beyanıdır, karşı atıf örtülü olarak vardır" sayılmalı. Bu `:229-234`'te zaten var olan `isTerminalCell` ile simetrik bir `isProseSupersetCell` olur. Bu değişiklik cdp'de 33'ü **21'e** indirir — bulgunun yönü ayakta kalır, sayısı düzelir.

### 4.2 21 gerçek tek yönlü kenar

Raporun kalanı gerçek kusur ve düzeltilmeli: `cdp_click→cdp_screenshot`, `cdp_scroll→cdp_click`, `cdp_tab_new→cdp_tabs`, `cdp_wait→cdp_snapshot`, `cdp_exec→cdp_extract` … Yani `10-skill-mimarisi.md`'nin §1 tablosunda ters atıf kapsamı gerçekten eksik.

> **Önemli:** Bu 21 bulgu, cdp deposunun **kendi 40 vitest testi hiç yakalamıyor.** `skill-web.spec.ts:168-191` yalnız rehber→rehber *bağ* çift yönlülüğünü denetliyor; araç→araç *kenar* çift yönlülüğünü denetleyen kapı yok. Kitin aracı burada gerçek bir boşluğu dolduruyor.

---

## 5. G5'İN BULGULARI — yargılandı

Kümeleri kendi gözümle okudum (`10-skill-mimarisi.md:257-405`) ve kapının regex'leriyle karşılaştırdım (`:688-697`):

| Küme | Kapı | Gerçek mi? | Gerekçe |
|---|---|---|---|
| §3.3 Kaydırma | yedek plan yok | ✅ **GERÇEK** | Tek "Geçiş kuralı" cümlesi var ama *hata merdiveni* yok: "X başarısızsa Y" cümlesi yazılmamış |
| §3.9 Kanıt biçimi | yedek plan yok | ✅ **GERÇEK** | 5 yollu tablo, "En ucuz" işareti var ama hiçbir yolun hâlinde neye geçileceği yazılmamış |
| §3.1 Bulma (9 yol) | varsayılan yok | ✅ **GERÇEK** | 9 satırın hiçbiri varsayılan işaretli değil — **dosyanın kendi 259. satırı** "Her küme: yollar · **varsayılan** · ne zaman geçersin" diye söz veriyor, §3.1 sözü tutmuyor |
| §3.6 Tıklama adresleme | yedek plan yok | ❌ **YANLIŞ POZİTİF** | "**Tercih sırası:** `ref`/`css` > `role`+`name` > `ariaLabel` > `text` > `x/y`" — bu **sıralı bir yedek plandır**. Dedektör aynı ifadeyi `isDefault` için tanıyor (`:692` `tercih sirasi`), `fallback` için tanımıyor. **Aynı ifade iki ölçüt için farklı muamele görüyor** |
| §3.8 Sekme izolasyonu | yedek plan yok | ⚠️ **TARTIŞMALI** | "İzolasyon seviyesini **yükselt** (yeni sekme → context → kalıcı profil)" — oklu bir tırmanış, sıralı yedek planın prose hâli. Kabul edilebilir ama ölçülemez |
| §3.7 Teşhis merdiveni | varsayılan yok | ⚠️ **TARTIŞMALI** | 9 basamaklı merdiven; 1. basamak yapı gereği giriş. Kapı merdiveni tanımıyor |
| §3.9 Kanıt biçimi | varsayılan yok | ❌ **YANLIŞ POZİTİF** | İlk satır "**En ucuz**" diye işaretli — `isDefault` regex'i `varsayilan\|default\|tercih sirasi` arıyor, `en ucuz` tanımıyor |

**Net:** 3 gerçek boşluk, 2 kesin yanlış pozitif, 2 tartışmalı. Yani G5'in dört "yedek plan yok" ve üç "varsayılan yok" bulgusunun **yarısı** dedektörün ifade tanımasından kaynaklanıyor.

### 5.1 Kapının kaçırdığı bir tutarsızlık (ucuz düzeltme)

G5 küme raporu hem başlıktaki sayıyı hem sayılmış yolu yazdırıyor — ve ikisi **uyumsuz** çıkıyor, kapı da bunu **denetlemiyor**:

| Küme | Başlıktaki sayı | Kapının saydığı | Gerçek |
|---|---:|---:|---|
| §3.2 Sayfayı bekleme | "5 yol" | 8 | 8 satır var → **başlık yanlış** |
| §3.6 Tıklama adresleme | "7 yol" | 6 | 7 adresleme modu var → sayım kapsam farkı |

`§3.2 — 5 yol` başlığı, manifestonun kendi ölçümüyle ("bekleme için 8 yol") **çelişiyor** ve kaynakta gerçekten hatalı. Kapı bu hatayı raporunda iki sayıyı yan yana göstererek *gösteriyor* ama *kırmızıya çevirmiyor*. `G5`'e üç satırlık bir kontrol (`başlıktaki sayı === sayılan yol`) eklemek mümkün.

---

## 6. KİTİN İÇ TUTARLILIĞI

### 6.1 Şablonlar, kapının yapmadığını kapının yaptığını söylüyor

| İddia | Yer | Gerçek |
|---|---|---|
| "**Kapı bu tabloyu okur; `alternative` ve `verifier` sütunları boş bırakılırsa G4 kırmızı verir.**" | `ATIF-TABLOSU.sablon.md:4-5` | ❌ **Yanlış.** `skill-hat-gate.mts` içinde `alternative`, `verifier`, `prerequisite` **sıfır kez** geçiyor (grep = 0). G4 yalnız `öncesi`/`sonrası` okuyor (`:560` `iNext = /sonrasi|next|sonra/`) |
| "her araçta `prerequisite` / `next` / `alternative` / `verifier` atıfları **çift yönlü**" (kabul kriteri) | `00-BASLA.md:47` | ❌ Aynı iddia, ikinci kez |
| "`alternative` ve `verifier` sütunları boş → … eksik" | `ORNEK/README.md:26` | ❌ cdp'nin tablosunda bu sütunlar **hiç yok**; boş değil, mevcut değil |

Bu, kitin kendi felsefesinin ihlali: *"politika, kapı olmadan politika değildir"* (§4.4). Burada kapısız politika şablona yazılmış — **ve ters etki yaratıyor**: model şablonu uygularsa boş sütunlar bırakır, kapı onları zaten umursamaz, model de "kapı yeşil, demek ki tamamdır" diye kapanır.

`SKILL.sablon.md:4` benzer bir aşırı iddia taşıyor: *"aşağıdaki hiçbir bölümü atlamak yok — hepsi kapı tarafından ölçülür."* Oysa §2 (zorunlu prosedür), §4 (tuzaklar) ve §6 (sınır) **hiçbir kapıyla ölçülmüyor**.

### 6.2 Kontrol listesi "iki hop", kapı "tek hop" diyor

| Kaynak | Kural |
|---|---|
| `KONTROL-LISTESI.md:109` | "Ana gövde → indeks → rehber zinciri **iki hopta** mı kalıyor?" |
| `YONTEM.md §7.2` | İki-hop kuralı, gerekçesi "derin zincirleme bağlar kısmi okuma yüzünden kötü" |
| `skill-hat-gate.mts:765` | `gövdede adı anılmayan rehber = 0` → **her rehber gövdeden adıyla anılmalı** |

Kit kendi içinde çelişiyor: kontrol listesi iki hop ister, kapı bir hopu zorunlu kılar. Ve kitin kendi örneği (`ORNEK/`) bir hopa uyuyor — yani **kit, kendi kontrol listesine uymayan bir örnek dağıtıyor.** (Bu, daha önce manifesto ile cdp arasında bulduğum Z2 çelişkisinin kitle birlikte yeniden üretilmiş hâli.)

### 6.3 G7, kanıt değil sözlük sayımı

```
RED = /kırmızı|red-test|düzeltildi|yanlışland|çürüt|regresyon|proven false|…/i
markers = satır sayısı
```

G7, "kırmızı" kelimesi geçen satırları **sayıyor**. Temiz fixture'ın G7'si yeşil çünkü SKILL.md'sinde şu paragraf var: *"Bu kapı betiğinin kendisi kırmızıya düşürülerek doğrulanmıştır…"* — yani **makine-kanıtı olmayan bir cümle kapıyı geçiriyor.** Kırık fixture aynı kelimeleri içermediği için kırmızıya düşüyor.

Bu bir güvenlik açığı değil, **yumuşak kapı** ve dürüstçe "kanıt" adı verilmemeli: G7 *şüphe kelimesi* ölçüyor, *kırmızıya düşmüş olma* olayını değil. Manifestonun T15'i ("hiç yaşanmadan tekrarlanan kural güveniye yarar") tam burada uygulanıyor. En ucuz düzeltme: kırmızı kanıtı isteyen bir makine artefaktı (ör. kapının kendi `EXIT 1` çıktısının kaydedildiği bir dosya).

### 6.4 Örnek README'deki ölçülmemiş sayılar

`ORNEK/README.md` kendi yönteminin İ2'sini ihlal ediyor:

| Yazılan | Ölçülen |
|---|---|
| `guides/10-skill-mimarlisi.md` | **`10-skill-mimarlisi`** → doğru adı **`10-skill-mimarisi.md`** (yazım hatası, üstelik konum olarak verilmiş) |
| `09-scraping-master.md` (1.030 satır) | **1.197 satır** |
| "7 bekleme stratejisi" | §3.2'de **8** yol |
| "5 veri okuma yolu" | §3.5'te **8** yol |
| "önkosül" (`:16`) | "önkoşul" |

Ayrıca README, G4/G5'in kırmızı çıktısını **ham sayıyla** aktarıyor ("33 tek yönlü kenar"); yukarıda ölçtüğüm gibi bunun 12'si artefakt. Yani kit, kendi aracının **kalibre edilmemiş** çıktısını örneğine yapıştırmış.

### 6.5 Dosya adı izi

`KONTROL-LISTESI.md:3` ve `:219` kaynak olarak `SKILL-MANIFESTO.md` gösteriyor; kit içinde bu ad yok (dosya `YONTEM.md`). Küçük ama K3/İ3'ün tam tanımı: "aynı olgu iki yerde iki biçimde yazılmış, güncellenmemiş."

---

## 7. MANİFESTODAN KALAN İKİ AÇIK — hâlâ açık

| # | Açık | Kit çözdü mü? |
|---|---|---|
| **Z1** | Kanıt dizini (`geliştirme/`, `_citation-audit.mjs`) bu depoda yok; 135/135 alıntı doğrulanamıyor | ❌ **Hâlâ yok.** Kit de kendi kanıtını taşımıyor |
| **Z2** | "İki-hop kuralı" uygulamada tersine dönmüş, kapıyla çelişiyor | ⚠️ **Kötüleşti.** §6.2 — çelişki kitle birlikte yeniden üretildi ve artık **kapı da bu yönde** |
| **Z3** | Uzun rehberlerde TOC yok, kapısı yok | ❌ Kapı G1–G8'de TOC ölçümü yok |
| **Z4** | Bütçe kuralları eşiksiz | ❌ Kapı gövde boyutunu ölçmüyor |
| **Z5** | Kural → kapı eşleme haritası yok | ✅ **Kapı = harita.** 8 kapı, hangi kuralı zorladığı yazılı. En somut eşleme |
| **Z6** | Dil politikası karara bağlanmamış | ❌ Kapı dil ölçmüyor |
| **Z7** | Kendini güncelleme tetiği mekanik değil | ⚠️ `00-BASLA.md` §10.4 takvimi kopyalandı, hâlâ sahipsiz |

**Net:** Kit, **yöntemin eksik olan uygulama katmanını** ekledi. Yöntemin kendi içindeki 7 açıktan **1'ini** (kapı haritası) kapattı, 1'ini (iki-hop) bozdu, 5'ini olduğu gibi bıraktı.

---

## 8. SORUNA DOĞRUDAN CEVAP: "modele verirsem yazar mı?"

**Evet — ve bu kit olmadan da yazardı, ama daha kötü yazardı.** Fark şurada:

| Ölçüt | Manifesto tek başına | Kit ile birlikte |
|---|---|---|
| İskelet | §8'de şablon var | Şablon var **+ 3 ayrı doldurulabilir şablon dosyası** |
| A4 kırmızıya düşürme | "zorunlu" ama **yapılamaz** | ✅ **Tek komut:** `node ARAC/skill-hat-gate.mts --bundle <kök>` |
| "Doğru bitti" nasıl anlaşılır | §7.6'nın 10 sorusu, puanlanabilir değil | ✅ **`EXIT 0` veya değil** |
| Teslim kontrolü | §9 üç liste | ✅ Dört turlu, **doldurulabilir** kontrol listesi |
| Hatanın bulunduğu yeri bilme | — | ✅ Hata mesajı dosya:satır + bulgu kodu veriyor |

**Yani "yazarmı" sorusunun cevabı artık kesin `evet`.** Kalan risk yazma kalitesinde değil, iki yerde:

**K1 — Araç, şablonun vaadini taşımıyor (düzeltilmeli, ~10 satır).**
`alternative` / `verifier` sütunları için kapı yaz ya da şablon ve `00-BASLA.md:47`'deki iddiayı kaldır. Bugünkü hâliyle model, kapının kontrol etmediği bir şeyi yapmaya çalışıp başarı sanacak.

**K2 — Araç, prose'u cezalandırıyor (düzeltilmeli, ~3 satır).**
`:616`'daki karşılık kontrolü, hedefin `öncesi` hücresi araç adı içermiyorsa onu üst-küme beyanı saymalı. Aksi hâlde araç, **daha iyi yazılmış** bir tabloyu daha kırmızı buluyor — bu, yöntemin T17'sini ve "politika kapı olmadan politika değildir" ilkesini kendi aracında ihlal ediyor.

İki düzeltmeden sonra kit, bir yazım aracı olarak **tutarlı**: vaat ettiği her şeyi ölçüyor, ölçtüğü her şeyi doğru ölçüyor.

---

## 9. ÖNCELİK SIRASI

| # | Bulgu | Yön | Etki |
|---|---|---|---|
| 1 | `:616` prose körlüğü — daha doğru yazım daha kırmızı | Araç | **Yüksek** — kalibrasyon bozuk, cdp'de 33→21 düzeltir |
| 2 | `alternative`/`verifier` kapıda yok ama şablonda vaat ediliyor | Şablon + 00-BASLA + ORNEK | **Yüksek** — model yanıltılıyor |
| 3 | G5: `tercih sırası` fallback sayılmıyor, `en ucuz` varsayılan sayılmıyor | Araç | Orta — 2 kesin yanlış pozitif |
| 4 | İki-hop (liste) ↔ tek-hop (kapı) çelişkisi | Kit içi | Orta — kit kendi kuralına uymayan örnek dağıtıyor |
| 5 | G7 kelime sayıyor, kanıt değil | Araç | Orta — yumuşak kapı, dürüst adlandırılmalı |
| 6 | `ORNEK/README.md`'de yazım hatası + 3 ölçülmemiş sayı | Örnek | Düşük — ama yöntemin İ2'si |
| 7 | G5 başlık sayısı ≠ sayılan yol denetlenmiyor | Araç | Düşük — 3 satır, §3.2'nin gerçek hatasını yakalardı |
| 8 | `KONTROL-LISTESI.md` eski dosya adını gösteriyor (`:3`, `:219`) | Kit içi | Düşük |
| 9 | Z1: kit kendi kanıt dizinini taşımıyor (alıntı denetimi yeniden çalıştırılamıyor) | Yöntem | Orta |

---

## 10. KANIT KAYD

### Doğrulanmış ölçümler

| Ölçüm | Komut / yol | Sonuç |
|---|---|---|
| Kit envanteri | `Get-ChildItem -Recurse` + UTF8 karakter sayımı | 19 dosya · 166.666 krk · 3.383 satır |
| Yöntem ≡ manifesto | `ReadAllText` + `-ceq` | **True** (90.046 karakter, 0 başlık farkı) |
| Aracın kendi sınaması | `node ARAC/hat-self-test.mts` | 3 faz yeşil · `EXIT 0` |
| Sınır testi | `node ARAC/skill-hat-gate.mts --bundle …\bundle\cdp` | 6/8 yeşil, G4+G5 kırmızı · `EXIT 1` |
| G2'nin gücü | aynı koşu | 147 çağrı örneği · 0 hayalet parametre |
| Kenar envanteri | `:596-610` algoritmasının yeniden uygulanması | 74 kenar — kapıyla birebir |
| Tek yönlü ayrımı | aynı + prose hücresi kontrolü | 33 = **12 artefakt + 21 gerçek** |
| Prose körlüğü kanıtı | 3 adımlı mutasyon (kopi) | A: 1 · B: **2** · C: 0 |
| `alternative`/`verifier` yokluğu | grep `skill-hat-gate.mts` | **0 eşleşme** |
| §3.2 yol sayısı | `10-skill-mimarisi.md:288-299` | Başlık "5 yol", tabloda **8** satır |
| Kit bütünlüğü | probe silindi, self-test yeniden koşturuldu | 19 dosya, `EXIT 0`, davranış değişmedi |

### Doğrulanmayan / derleme-özel iddialar

1. **12 artefaktın dağılımı**, cdp tablosunun 36 satırına baktığımda elde ettiğim sınıflandırmadır. Aracın kendi iç çıktısı bu ayrımı **yapmıyor** — 33'ü düz tek sayıyor. Yani "12" benim ölçümüm, araçtan çıkan değil.
2. **G5'teki "2 kesin yanlış pozitif"** yorumdur: §3.6'nın "Tercih sırası" zincirini ve §3.9'un "En ucuz" işaretini yedek plan/varsayılan saymamanın yanlış olduğu kanaatindeyim. Aracın kuralı yazılı; tartışma kuralın yorumunda.
3. **Kitin hangi sürümüyle çalıştığını bilmiyorum** — eldeki dosyaları ölçtüm, tarihçeyi doğrulamadım. Hareketli bir ağaç varsa (YONTEM.md §11.2'nin kendi uyarısı) satır referansları kaymış olabilir.
4. **T6 notu (kendi zemin hatasım):** sınıflandırma betiğimde `.Split('->')` karakter dizisiyle bölme hatası yaptım ve ilk koşu "74 kenar → 74 gerçek" dedi. Araç doğrutu, **betiğim** bozuktu. Düzeltip yeniden ölçtüm. Aynı hatayı tekrarlamamak için ikinci koşunun kenar sayısını kapıyla karşılaştırdım (74 = 74 ✓).

### Kaynakta bulunan ve bu raporda düzeltilen tutarsızlıklar

| Bulgu | Nerede | Durum |
|---|---|---|
| "95 KB" ifadesi | `00-BASLA.md:24` | Gerçek: 90.046 karakter (≈ 96.802 bayt) — **bayt cinsinden doğru**, karakter cinsinden değil. Yanlış alarm. |
| "9 rehber" / `>= 10` eşiği | YONTEM §11.1 ↔ kit kapısı | Tutarlı (9 rehber + `00-map` = 10 dosya). Yanlış alarm. |
| Rehber 08 | YONTEM §4.4 "01–08 İngilizce" | Kitte de yok; numaralama boşluğu kozmetik. Yanlış alarm. |

---

*Bu rapor kitin kendi yöntemiyle yazıldı: sayılar ölçüldü, iki kapı bilerek kırarak kırmızıya düştüğü doğrulandı, üç bulgu "doğrulanmayan" olarak işaretlendi ve bir tanesi (kendi ölçüm betiğim) raporda açıkça düzeltildi. Şüpheli bulduğun her iddia için: önce kendi ölç.*
