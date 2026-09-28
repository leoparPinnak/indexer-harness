# SKILL DENETİM RAPORU — `SKILL-MANIFESTO.md` ↔ `cdp-browser-control` eklentisi

**Tarih:** bu oturum
**Denetlenen A (yöntem):** `SKILL-MANIFESTO.md` — 1.589 satır, 12 bölüm
**Denetlenen B (ürün):** `packages/bundle/cdp/assets/` — 11 dosya, 141.647 karakter, 2.425 satır
**Yöntem:** Denetlenen A'nın kendi disiplini uygulandı — A0 envanter, A1 kaynakla karşılaştırma, A4 kırmızıya düşürme, A6 teslim kaydı.

> Bu bir tespit raporudur. Hiçbir düzeltme yapılmadı; geçici deney bozmaları geri alındı ve ağaç temiz doğrulandı.

---

## 0. Yönetici özeti

| Soru | Cevap |
|---|---|
| Manifesto yöntem olarak ne seviyede? | **L4 (kapılı) yöntem, L2 kendi kendini doğrulama.** İlkeler kanıta bağlı, tuzaklar gerçek olaydan, dış kaynakla kesişiyor. Ama kendi kanıt dizini bu depoda **yok** ve tarif ettiği mimarinin bir kısmı artık **kapıyla çelişiyor**. |
| Eklentinin skill seti ne seviyede? | **L4+.** 36/36 araç, dört yüzeyde de belgeli; 40 test 6 suite'te yeşil; iki guard bilerek kırarak kırmızıya düştüğü doğrulandı. |
| Manifesto ile eklenti uyumlu mu? | **Yapısal olarak evet, kural olarak 3 noktada hayır.** En ciddisi: manifestonun "iki-hop kuralı" artık **çalışan iki testle çelişiyor**. |
| Doğrulama araç seti ne seviyede? | **Eklenti için L4, depo geneli için L1.** `verify-skill-invocation-metadata` yalnız `.agents/skills/**` kapsıyor; preset ve bundle skill'leri repo kapısı dışında. |

**Tek cümlelik hüküm:** Bu, gördüğüm en olgun skill-yazım yöntemlerinden biri ve uygulaması da yönteminin seviyesinde. Zayıf nokta yöntemin değil, **yöntemin kendini denetleyememesinde**: manifesto, uygulamanın gerisinde kalmış ve bu geride kalışı yakalayan tek bir mekanizması yok.

---

## 1. Ölçüm tablosu (bugünün değerleri)

Karakter sayıları UTF-8 çözülmüş metinden; satır sayıları son satır sonu hariç.

| Dosya | Karakter | Satır | TR karakter | Not |
|---|---:|---:|---:|---|
| `skill/SKILL.md` | 25.645 | 253 | 23 | Gövde + katalog satırı |
| `guides/00-map.md` | 2.586 | 23 | 13 | İndeks |
| `guides/01-protocol-core.md` | 1.597 | 20 | 5 | İnce |
| `guides/02-input-and-stealth.md` | 1.590 | 21 | 3 | İnce |
| `guides/03-dom-and-eval.md` | 3.559 | 55 | 39 | İnce |
| `guides/04-proxy-and-analysis.md` | 1.332 | 19 | 11 | İnce |
| `guides/05-workflow-combos.md` | 1.451 | 20 | 6 | İnce |
| `guides/06-adapters.md` | 1.360 | 20 | 5 | İnce |
| `guides/07-human-interaction.md` | 18.111 | 360 | 41 | Kalın |
| `guides/09-scraping-master.md` | 62.984 | 1.197 | 3.190 | Master |
| `guides/10-skill-mimarisi.md` | 21.432 | 437 | 835 | Ağ haritası |
| **Toplam** | **141.647** | **2.425** | **4.166** | 9 rehber + 1 indeks + 1 gövde |

**Manifesto karşılaştırması (§11.1) — sapma küçük, yönü doğru:**

| Kalem | Manifesto | Bugün | Sapma |
|---|---:|---:|---:|
| SKILL.md | 24.612 krk / 239 satır | 25.645 / 253 | +4,2% / +14 satır |
| Rehber 09 | 62.209 / 1.186 | 62.984 / 1.197 | +1,2% |
| Rehber 10 | 21.418 / 437 | 21.432 / 437 | birebir |
| Rehber 07 | 17.549 / 358 | 18.111 / 360 | +3,2% |
| 00-map.md | 23 satır | 23 satır | birebir |
| Rehber sayısı | 9 | 9 | birebir |
| TR karakter (09 / 10) | 3.157 / 835 | 3.190 / 835 | ≈birebir |

Sapmalar §11.2'deki "paralel ajanlar çalışıyordu" uyarısıyla açıklanıyor. **Sapma yokluğu iyi haber; ama bu, manifestonun kendi ölçümünün güncel olduğu anlamına gelmiyor** — bölüm 5'te üç maddede artık yanlış.

---

## 2. ARAÇ KAPSAM MATRİSİ (T7'nin bugünkü hali)

`src/tools.ts` + `src/status.ts`'ten programatik olarak çıkarılan kayıtlı araçlar: **36** (34 `cdp_*` + 2 `net_*`).

Her aracın dört yüzeyde görünürlüğü ölçüldü:

| Yüzey | Kapsam | Sonuç |
|---|---|---|
| `src/` kayıt satırı | 36/36 | ✅ |
| `SKILL.md` §1 (adı geçiyor) | 36/36 | ✅ |
| `SKILL.md` §3 karar tablosu (kendi satırı) | 36/36 | ✅ |
| `09-scraping-master.md` §2 envanter | 36/36 | ✅ |
| `10-skill-mimarisi.md` §1 "sonraki araç" satırı | 36/36 | ✅ |

**Tuzak T7 ("34 aracın yalnız 15'i satırdı") KAPALI.** Karar tablosunda 42 markdown satırı var; 36'sı araç, kalanı meta satırı ("Hold on — prefer…") ve locator parametre tablosu. Kapsam kusursuz.

**T19 ("`cdp_dialog` `action` parametresini yazmıyordu") KAPALI** — `SKILL.md:140` artık `action`/`promptText`/`policy` ile "verilmezse ne olur" cümlesini içeriyor.

---

## 3. MANİFESTO DENETİMİ — ilke ilke

### 3.1 Güçlü taraflar (ölçülmüş olarak tespit edildi)

| # | Tespit | Kanıt |
|---|---|---|
| G1 | **Yöntemin kendi ilkeleri ölçülmüş.** Sayılar, satır referansları ve tarih damgası verilmiş; sapma ihtimali açıkça belirtilmiş. | §11.2 "satır referansları 26.09.2026 ~02:36 itibarıyladır" |
| G2 | **Kendi politika ihlalini kendisi kaydetti.** "Politika yazıldı, uygulanmadı, kimse fark etmedi — çünkü kapı yok." | §4.4, 09/10'un Türkçe ölçümüyle |
| G3 | **Kanıt hiyerarşisi ölçülmüş ≠ hesaplanan ayrımı.** | §5.1–5.2 |
| G4 | **Tuzak galerisi gerçek olaydan türetilmiş, sentetik değil.** 19 tuzak; her biri kaynak dosya:satır. | §6, T1–T19 |
| G5 | **Çelişki gizlenmemiş, sergilenmiş.** "description üçüncü tekil mi emir mi?" iki resmî kaynak ters diyor → kararı yazıp *bunun kendi yorumumuz olduğunu* işaretliyor. | §7.7.2 |
| G6 | **Bulunamayan konu yazılmış.** "Çift yönlü See also için resmî kural bulunamadı; bu tamamen öz gözlemimiz." | §7.7.3 |
| G7 | **Kaynak eğilimi kendi itirafıyla belirtilmiş** — `web_search` HTTP 402 verdi, küme Anthropic'e kayıklı. | §7.7 uyarı kutusu, §11.3 |
| G8 | **Dış doğrulama gerçek.** 15 URL'lik kesişim tablosu, 30+ dış ilke kendi karşılığına bağlanmış. | §7.7 |
| G9 | **Kırmızıya düşürme disiplini yazım aşamasına kadar taşınmış**, A4 teslimin ayrılmaz parçası ilan edilmiş. | §3 A4, §9(c) |
| G10 | **Mod C ("skill yazmalı mıyım?") en pahalı mod olarak konumlandırılmış.** | §0, §1.1 |

### 3.2 Zayıf taraflar

| # | Tespit | Etki | Kanıt |
|---|---|---|---|
| **Z1** | **Manifestonun kanıt dizini bu depoda yok.** `geliştirme/plan/00-SUREC-KURALLARI.md`, `01-SKILL-ENTEGRASYON-PLANI.md`, `00-TEST-RAPORLARI-DEGERLENDIRME.md`, T7/T8 raporları ve `geliştirme/skill/_citation-audit.mjs` — hiçbiri repo içinde değil. | **Yüksek.** K1–K9'un tanımı, 19 tuzağın kökeni ve "135/135 alıntı doğrulandı" iddiası **yeniden üretilemiyor**. §11.2'nin kendi talimatı ("depo değişirse bu betiği yeniden koştur") çalıştırılamıyor. Manifesto, kendi ilkesi olan "kanıtsız yazılmış sayılmaz"ı kendi çalışma alanında uygulayamıyor. | `geliştirme/**` → 0 sonuç; `_citation-audit` → 0 sonuç |
| **Z2** | **"İki-hop kuralı" artık yanlış ve kapıyla çelişiyor.** §7.2 der ki: "SKILL.md §6 **yalnız 00–07'yi** listeler; 09 ve 10 oraya girmez, ikinci hop'tan ulaşılır." | **Yüksek.** Bugün `SKILL.md:236-250` **dokuz rehberin dokuzunu da doğrudan adıyor**, 09 ve 10 dahil. Daha kötüsü: `guide-links.spec.ts:155-161` ve `skill-web.spec.ts:150-166` bunu **zorunlu kılıyor** — bir rehberi gövdeden çıkarırsanız iki test kızarır. Yani manifesto, yeşil bir sistemi tanımlıyor, sistem ise manifestonun kuralının tersini uyguluyor. | `SKILL.md:245-250` ↔ `guide-links.spec.ts:155` ↔ `skill-web.spec.ts:155` |
| **Z3** | **Yeni kabul edilen kural (TOC) hiç uygulanmamış ve kapısı yok.** §7.7.1 kural 1: "Uzun rehberlerin başına içindekiler koy." | **Orta.** 09 (1.197 satır, 60 başlık), 10 (437 satır, 22 başlık), 07 (360 satır, 11 başlık) — hiçbirinde TOC yok. 10'un başındaki 3 maddelik "Üç bölüm" listesi yalnız §1–§3'ü kapsar, §4'ü değil. Dış kaynağın gerekçesi (kısmi okuma → eksik bilgi) doğru ve bu dosyalarda tam olarak riskli. | Başlık taraması: 0 "İçindekiler/Contents" eşleşmesi |
| **Z4** | **Bütçe kurallarının çoğu eşiksiz.** §2.5'te gövde için "Ölç, yaz, sonra yeniden ölç" yazıyor; sayı yok. §2.3'te eşik var (10 KB / 25 KB) ama teslim kapısı yok. | **Orta.** Dış kaynak `< 500 satır / < 5000 token` diyor (manifesto §7.7'de alıntılıyor) ama **benimsemiş değil** — benimseseydi bir eşik olurdu. | §2.5 tablosu |
| **Z5** | **Kural → kapı eşleme haritası yok.** 19 tuzak, 10 ilke, ~40 madde var; hangisinin makine kapısı olduğu tek tabloda görünmüyor. | **Orta.** Kapsam denetimi yapılamıyor. Z3 ve §4.4 dil ihlali, kapısı olmayan kuralların nasıl biriktirdiğinin somut örneği. | §7.4 tablosu belge-bağımlı, depo-geneli değil |
| **Z6** | **Dil politikası karara bağlanmamış.** §4.4 "tek dil seç" diyor, sapmayı ölçüyor, kararı vermiyor. | **Düşük-Orta.** Manifestonun kendi ilkesi gereği ya karar verilmeli ya "okuyucunun kararı" diye işaretlenmeli. Aslında ikincisi yazılmış — sorun, kararın **yazılı olmaması**. | §4.4 |
| **Z7** | **Kendini güncelleme tetiği mekanik değil.** §10.4 bir gözden geçirme takvimi veriyor ama sahibi, sıklığı veya otomatik bir tetikleyicisi yok. | **Orta.** Z2'nin neden fark edilmediğini açıklar: yöntem belgesi de ağaçla birlikte yaşlanıyor. | §10.4 |
| **Z8** | **"Olgunluk ölçütü" 10 soruluk (§7.6) puanlanabilir değil.** "Hepsi iyi ise olgunlaşmıştır" — eşik yok, öncelik sırası yok. | **Düşük.** Denetlenebilir bir çetvele dönüştürülebilir. | §7.6 |

**Manifesto seviyesi: L4 yöntem / L2 kendi-denetim.** En ayırt edici tarafı kanıt disiplini; en zayıf tarafı, kendi kanıtını üretememesi (Z1) ve kendi tarif ettiği sistemle senkron kalamaması (Z2, Z7).

---

## 4. EKLENTİ DENETİMİ — SKILL.md ve rehber ağı

### 4.1 Manifestonun altı bölüm iskeletine uyum (§2.2)

| Bölüm | Beklenen | Gerçek | Uyum |
|---|---|---|---|
| §1 Ne ve ne zaman | araç listesi · niyet ayrımı · **kapsam dışı** | `SKILL.md:21-48`, "Not CDP: … shellbox skill" `:44-45` | ✅ tam |
| §2 Zorunlu prosedür | numaralı, atlanamaz | `:91-109`, 7 adım, gerekçeli (Gmail olayı) | ✅ tam |
| §3 Karar tablosu | 5 sütun | `:111-152`, 42 satır, 36 araç | ✅ tam |
| §4 Hata senaryoları | belirti → teşhis → düzeltme | `:200-221`, 9 madde | ✅ tam |
| §5 Keskin kenarlar | sessiz tehlike | `:223-230`, 3 madde | ✅ tam |
| §6 Daha derin rehberler | "talebe göre yükle" | `:232-253` | ⚠️ aşağı bak |
| **§7 Kanıt kaydı** | **zorunlu** (§8 şablon) | **YOK** | ❌ |

### 4.2 Katalog satırı (§2.1)

| Alan | Kural | Durum | Kapı |
|---|---|---|---|
| `name` | kebab-case, kodla birebir | `cdp-browser-control` | `skill-frontmatter.spec.ts:43-48` |
| `description` | ≤500, **≥16 karakter pay** | 467, pay 33 | `:50-55`, `:77-82` |
| `description` ↔ kod | birebir aynı | ✅ | `:67-70` |
| `whenToUse` | string, kodla birebir | ✅ | `:72-75` |
| Yasak anahtarlar | `allowed-tools` yok | ✅ | `:84-92` |

**§2.1'in katalog satırı kriterleri tam olarak karşılanıyor.** Tetikleyici üç kelime havuzunu birden yakalıyor (eylem listesi / kullanıcı dili / mutasyon eşiği) — manifestonun kendi örnek verdiği satırla neredeyse aynı.

### 4.3 Bütçe (İ5)

| Katman | Değerlendirme |
|---|---|
| Gövde 25.645 krk | §2.3'ün "25 KB üstü → çok dosya" eşiğinin **tam sınırında**, gereği yapılmış (9 rehber + indeks). |
| `description` 467/500 | 33 krk pay — pay kuralı ≥16 sağlanıyor, iki katı. |
| Rehber dağılımı | 1.3 KB – 63 KB. Tema bazlı bölünme; ince rehberler **yüzey alanı** dosyaları olarak konumlandırılmış ve gerekçesi `src/*.ts`'e yönlendirme. |
| **Uyarı** | En kalın rehber (09) gövdenin **2,5 katı**. Bu kabul edilebilir bir karar (manifestonun kendi mantığı), ama gövdeye hiç girmemesi de bir *kanıt* değil: 09'un SKILL.md'ye gömülmeme gerekçesi ölçülmüş bir maliyet hesabına dayanıyor, oysa bu hesap bu depoda **yeniden üretilemiyor** (Z1). |

### 4.4 Dil politikası (§4.4) — sapma büyüyor

| Dosya | TR karakter | Beklenen (manifesto §4.4) |
|---|---:|---|
| `09-scraping-master.md` | 3.190 | Türkçe (kaydedilmiş sapma) |
| `10-skill-mimarisi.md` | 835 | Türkçe (kaydedilmiş sapma) |
| `07-human-interaction.md` | 41 | İngilizce — **yeni sapma** |
| `03-dom-and-eval.md` | 39 | İngilizce — **yeni sapma** |
| `SKILL.md` | 23 | İngilizce — **yeni sapma** |
| `00-map.md` | 13 | İngilizce — **yeni sapma** |
| 01–06 | 3–11 | İngilizce — **yeni sapma** |

Manifesto "01–08 → 0" ölçtüğü halde bugün **7 dosyada Türkçe karakter var**, gövde dahil. Sapma kaydedilmiş ama **kapı olmadığı için birikiyor** — manifestonun kendi vardığı "politika, kapı olmadan politika değildir" sonucunun canlı ispatı. Gövdedeki iki cümle (`SKILL.md:63-64`, kalın) özellikle dikkat çekici: talimatın tam gövde içine gömülmüş.

### 4.5 Erişilebilirlik ve ağ (İ8, T8, T14, T16)

| Denetim | Durum | Kapı |
|---|---|---|
| Her rehber `00-map`'ten bağlı | ✅ | `guide-links.spec.ts:113-123` |
| Her rehber gövdeden adıyla anılıyor | ✅ | `guide-links.spec.ts:155-161` + `skill-web.spec.ts:150-166` |
| Her bağ **çapası** çözülüyor | ✅ | `guide-links.spec.ts:127-153` |
| Her rehber `00-map`'e geri dönüyor | ✅ | `skill-web.spec.ts:193-199` |
| Tek yönlü çıngırak yok | ✅ | `skill-web.spec.ts:168-191` |
| Ölü rehber yönü yok | ✅ | `skill-web.spec.ts:159-165` |
| Gövde/harita/dizin sayımı uyuşuyor | ✅ | `guide-links.spec.ts:163-177` |

**T8, T14, T16 KAPALI.** Ağ katmanı, manifestonun tarif ettiği spiderweb'in (kenar + örgü + düğüm) tamamıdır: kenar `10 §1` (36/36), örgü `10 §2` (F1–F14), düğüm her rehberin "See also" bloğu.

**T9 (gölge arama yolu) KAPALI ve aşırı düzeltilmiş.** `src/skill.ts:145-150` tek konuma indirmiş, `:134-142` emekli yol için **uyarı** koymuş. Bu, manifestonun "istenmeyen eşleşmeye dayanan tasarım" tespitinin tam karşılığı.

### 4.6 Kanıt disiplini (§5)

| Ölçüt | Durum |
|---|---|
| Kaynak satırı alıntısı | ✅ `SKILL.md:84` → `src/stealth.ts:15-17`; mekanik sınır İ7'nin gerektirdiği gibi koddan alıntılanmış |
| Ölçülmüş sayı | ✅ 16 KiB bütçe, 500 ms boşluk, 60 sn zaman aşımı — hepsi çalıştırma çıktısı |
| **Doğrulanmayan iddialar bölümü** | ✅ `09-scraping-master.md:997-1059` — üçlü kanıt kaydı, 9 düzeltilmiş iddia, 2 tekrarlanmayan bulgu, "benim eski hatam" itirafı |
| Kanıt kaydı **gövdede** | ❌ `SKILL.md`'de §7 yok |

`SKILL.md:152` — *"a counter the page does not publish is omitted and warned, never reported as 0"* — T2'nin ("boş" ≠ "yok") mükemmel uygulaması, doğrudan modele yazılmış.

### 4.7 Polimorfizm (§7.3)

9 küme, 5/5/4/8/7/9/4/5 yol. Her kümede **varsayılan** ve **geçiş cümlesi** var (`10:275-284` "matched: 0 → sorguyu genişlet (2→4→6→7)"; `:367-377` 9 basamaklı teşhis merdiveni). `skill-web.spec.ts:216-230` dokuz kümenin **adını** ayrı ayrı zorunlu kılıyor.

**Zayıf nokta:** "geçiş cümlesi" bir **başlığın adıyla** denetleniyor, içeriğiyle değil. Küme adı doğruysa test yeşil — yazılan kuralın boş olması testi geçer. T15'in ("hep geçen assertion") tam bu sınıfı hedeflediği düşünülebilir, ama burada kısmi.

---

## 5. MANİFESTO ↔ UYGULAMA ÇELİŞKİLERİ (raporun en kritik bölümü)

| # | Çelişki | Manifesto | Gerçek | Hukuk |
|---|---|---|---|---|
| **Ç1** | **İki-hop kuralı** | Gövde 09/10'u listelemez | Gövde hepsini listeler **ve iki kapı bunu zorunlu kılar** | **Uygulama kazanmış, manifesto kaybetmiş.** Ya manifesto §7.2 güncellenmeli, ya kural iptal edilmeli. Bugün ikisi de olmadı — bir sonraki yazar manifestoyu okuyup doğru olanı yapmaya çalışırsa iki test kızar. |
| **Ç2** | **Kanıt dizini** | 135/135 alıntı doğrulandı, betikle yeniden çalıştırılabilir | `geliştirme/` bu depoda yok | **Kaynak erişilemez.** Manifesto, kendi kanıtını taşıyan klasörü taşımıyor. |
| **Ç3** | **TOC kuralı** | >100 satırlık rehberde TOC şart | 09/10/07'de TOC yok, kapı yok | **Kural yazıldı, uygulanmadı.** §4.4'teki desenin ikinci örneği. |
| **Ç4** | **Dil politikası** | 01–08 İngilizce olmalı | 7 dosyada TR karakter var, kapı yok | Sapma kaydedilmiş, sürüyor. |
| **Ç5** | **Guard envanteri** | T17: negatif varlık iddiası istisna listesiyle korunur | ✅ **Uygulanmış** — `skill-web.spec.ts:64` `DOCUMENTED_AS_ABSENT = {cdp_read, cdp_sleep}` | Uyum. Bu madde manifestodan **ileride**. |
| **Ç6** | **Yeşil test uyarısı** | "Her guard kırmızıya düşürülerek kanıtlanmalı" | ✅ Beyan edilmiş **ve bu oturumda iki kez bağımsız doğrulandı** | Uyum, kanıtı aşağıda. |

---

## 6. DOĞRULAMA ARAÇ SETİ — seviye tespiti

### 6.1 Ölçülen durum

```
Test Files  6 passed (6)
Tests      40 passed (40)
Duration   1.42s
```

| Suite | Test | Koruduğu | Manifesto karşılığı |
|---|---:|---|---|
| `skill-web.spec.ts` | 10 | 36 araç sayımı · 1-hop erişim · parametre+hata imzası · **ölü araç adı** · `§N` çapraz referans · yönlendirme · çift yönlülük · yetim rehber · 36/36 "sonraki araç" · 9 polimorfizm kümesi | K1, T7, T17, T19, T8, T14 |
| `guide-links.spec.ts` | 7 | Gövde→dosya · harita→dosya · her rehberin "See also" · harita kapsamı · **çapa** · gövde kapsamı · sayım uyumu | T8, T14, T16 |
| `skill-frontmatter.spec.ts` | 8 | YAML · isim grameri · ≤500 · **≥16 pay** · kodla birebir · yasak anahtarlar | §2.1, T13 |
| `skill-provider.spec.ts` | 9 | Tek konumlu gövde · eksik taban · okunamayan gövde · emekli yol uyarısı · `resourceBase` | T9 |
| `skill-registration.spec.ts` | 3 | Kayıt + yükleme | — |
| `skill-packaging.spec.ts` | 3 | Yayınlanan dosya kümesi | T8 (gövde diskte mi) |

**Manifestonun "15/15 (7 guide-links + 8 frontmatter)" ölçümünün bugünkü karşılığı 40/40.** Araç seti büşümüş ve bu büyüme **içerikle** (ölü araç adı, çapa, yönlülük) sağlanmış.

### 6.2 Kırmızıya düşürme kanıtı (bu oturumda yapıldı)

| Deney | Beklenen | Gözlenen |
|---|---|---|
| `06-adapters.md`'ye hayalet araç adı `cdp_screenshot_zoom` eklendi | `skill-web` kızar | ❌ `never points at a tool the source does not register` — *"these tool names are not registered in tools.ts …: cdp_screenshot_zoom"* |
| `00-map.md`'de çapa `#protocol-core-architecture-x` yapıldı | `guide-links` kızar | ❌ `resolves every link ANCHOR` — *"has no heading with that anchor (it has: protocol-core-architecture, connection-lifecycle, target-registry, see-also)"* |
| İkisi geri alındı | 40/40 yeşil | ✅ 40/40, 1.53s; iki dosya orijinal içerikle eşleşiyor |

Hata mesajları yalnız kırmızı değil, **neyi bulması gerektiğini de söylüyor** (mevcut çapaları listeliyor). Bu T15'in "boş test" değil, gerçek sınav olması ölçütünün karşılanmasıdır.

### 6.3 Araç setinin **kapsamadığı** alanlar

| Boşluk | Somut risk | İlgili manifesto maddesi |
|---|---|---|
| **Gövdede kanıt kaydı (§7) zorunlu değil** | `SKILL.md`'de kanıt kaydı bölümü yok ve yokluğu fark edilmiyor. §8 şablonu bunu "boş bırakma" diye yasaklıyor. | §5.6, §8 kural 5 |
| **TOC kapsamı yok** | 1.197 satırlık rehber kısmi okumada eksik bilgiyle bırakılabilir. | §7.7.1 kural 1 |
| **Dil kapsamı yok** | Sapma birikiyor, kimse fark etmiyor. | §4.4 |
| **Bütçe kapsamı yok** | Gövde şişirse kapı kızmaz. | İ5 |
| **Repo seviyesinde skill kapısı dar** | `scripts/verify-skill-invocation-metadata.ts:31-38` yalnız `.agents/skills/**` tarıyor. `packages/preset/agent-presets/presets/*/skills/**` ve `packages/bundle/*/assets/skill/**` repo kapısının **dışında**; onları yalnız paket kendi testleri koruyor. | §7.5 "yeni araç = zorunlu teslim üçlüsü" — kapı yoksa teslim de yok |
| **`guide-links.spec.ts` kendi başlığında G2'yi sahipleniyor** (`:21-23` "G2 dead tools …"), ama uygulaması kardeş dosyada (`skill-web.spec.ts:101-107`). | Dosya yorumu, kendi kapsamı dışındaki bir guard'ı kendi diyor. T17'nin konusu tam olarak bu: guard'ı sahiplenmeyen yorum. | T17, İ3 |
| **Çalışma-zamanı kayması kapısı yok** | `cdp_locate` hem `src/tools.ts:3274`'te kayıtlı hem `SKILL.md`'de belgeli; **çalışan oturumun araç kataloğunda yok**. Kaynak, skill ve dağıtım üç ayrı sürümde. Hiçbir kapı bu üçünü bağlamıyor. | §7.5 (izlenebilirlik) |

---

## 7. KANIT KAYDI (manifestonun A6-6 / İ10 standardında)

### Doğrulanmış ölçümler

| Ölçüm | Komut | Sonuç |
|---|---|---|
| Varlık ölçümü | `Get-ChildItem -Recurse assets -Filter *.md` + UTF8 karakter sayımı | 11 dosya · 141.647 krk · 2.425 satır |
| Araç envanteri | `tools.ts` + `status.ts` üzerinde regex | 36 kayıtlı araç |
| 36 araç × 5 yüzey | çapraz referans taraması | 36/36 her yüzeyde |
| Kapılar yeşil | `pnpm vitest run <6 suite>` | **40/40**, 1.42 sn |
| Kırmızı #1 | hayalet araç adı eklendi | `skill-web` ❌ — yakalandı |
| Kırmızı #2 | ölü çapa eklendi | `guide-links` ❌ — yakalandı |
| Geri dönüş | iki düzeltme geri alındı | 40/40 yeşil; iki dosya orijinal |
| Kanıt dizini | `geliştirme/**` glob | **0 sonuç** |
| Alıntı betiği | `_citation-audit` grep | **0 sonuç** |

### Doğrulanmayan / derleme-özel iddialar

1. **Çalışan oturumun araç kataloğu `cdp_locate` içermiyor.** Bu, skill'in *dağıtılmış build'i* aştığı anlamına gelir; ancak oturumun hangi build'i yüklediğini doğrulamadım. **Benzer bir eksik görürsen önce `cdp_status`'a bak, rapora olduğu gibi yazma.**
2. **Manifestonun "İki-hop kuralı uygulanıyor" iddiası yanlış.** Bunu yalnız manifestonun metnine bakarak değil, `SKILL.md:236-253`'ü ve iki kapının kaynağını okuyarak doğruladım; yine de bu, manifestonun yazıldığı andaki ağacın duruyor olmasına dayanıyor.
3. **Polimorfizm küme testinin gerçekten yetersizliği** — kümelerin *adının* denetlendiğini gördüm, içeriklerinin denetlenmediğini *kaynak okumasıyla* çıkardım, kırmızıya düşürmedim. Bu madde bir muamele değil, denetim eksikliğidir.

### Kaynakta bulunan ve bu raporda düzeltilen tutarsızlıklar

| Bulgu | Nerede | Durum |
|---|---|---|
| "9 rehber" ↔ kapının `>= 10` eşiği | manifesto §11.1 ↔ `guide-links.spec.ts:176` | **Yanlış alarm** — 9 rehber + `00-map` = 10 dosya; eşik tutarlı, açıklama gereksiz. |
| Rehber 08 hiç yok | manifesto §4.4 "01–08 İngilizce" | Dosya hiç var olmamış; numaralama boşluğu (`07 → 09`) kozmetik. |
| `SKILL.md` 239 satır | manifesto §11.1 | Güncel değil (253). §11.2'nin uyarısı kapsıyor. |

---

## 8. BULGULAR ÖZETİ — öncelik sırasıyla

| # | Bulgu | Yön | Önem |
|---|---|---|---|
| 1 | İki-hop kuralı manifestoda hâlâ duruyor, ama iki yeşil kapı tersini zorunlu kılıyor | Manifesto | **Yüksek** — bir sonraki yazarı doğru olanı yapmaya zorlayıp kırmızıya düşürecek |
| 2 | Kanıt dizini (`geliştirme/`) ve alıntı betiği depoda yok | Manifesto | **Yüksek** — yöntemin kendi doğrulanabilirliği kayıp |
| 3 | Repo seviyesinde skill kapısı yalnız `.agents/skills`'ı kapsıyor | Araç seti | **Yüksek** — preset ve bundle skill'leri kapı dışında |
| 4 | Gövdede kanıt kaydı (§7) yok, şablon onu zorunlu kılıyor | Eklenti | Orta |
| 5 | 09/10/07'de TOC yok, kural kabul edilmiş ama kapısız | Her ikisi | Orta |
| 6 | Dil sapması 7 dosyaya yayıldı, kapı yok | Eklenti | Orta |
| 7 | `guide-links.spec.ts` başlığı sahibi olmadığı G2 guard'ını sahipleniyor | Araç seti | Düşük |
| 8 | Polimorfizm testi küme adlarını denetliyor, içeriklerini değil | Araç seti | Düşük |
| 9 | Gövde/harita/dizin/skill/çalışan-build arasında sürüm bağı yok | Araç seti | Orta |
| 10 | Gövde 25.645 krk ile §2.3'ün 25 KB eşiğinde; kanıtlanmış payı yok | Eklenti | Düşük |

---

## 9. HUKM

**`cdp-browser-control` skill seti, `SKILL-MANIFESTO.md` ile uyumlu ve manifestonun tarif ettiği seviyede.** Kapsam (T7), erişilebilirlik (T8/T14/T16), gölge yol (T9), negatif varlık iddiası (T17), anlamlı çağrı (T19) ve kanıt disiplini maddeleri ya kapalı ya da kapıyla zorlanıyor; iki guard bu oturumda bağımsız olarak kırmızıya düştüğü doğrulandı. Bu, "iyi yazılmış bir skill" değil, **"kuralları makine kapısına bağlanmış bir skill"** — manifestonun kendi ölçütünde üst seviye.

**Manifesto, yöntem olarak bu skill setinin önünde ve onu besliyor; ama kendi uygulamasının gerisinde kalmış.** En değerli yanı kanıt disiplini; en zayıf yanı, kendi kanıtını taşıyan klasörü taşımaması ve tarif ettiği iki kuralın uygulamada tersine dönmüş olması. Manifestonun kendi ilkesi gereği (K3, K10, "önce kendi ölç") bu iki maddenin ya manifesto ya uygulama lehine kapatılması gerekir — bugün ikisi de açık.

---

*Bu rapor manifesto disipliniyle yazıldı: sayılar ölçüldü, iki kural kırmızıya düşürülerek doğrulandı, doğrulanamayan üç madde "doğrulanmayan" olarak işaretlendi. Şüpheli bulduğun her iddia için: önce kendi ölç.*
