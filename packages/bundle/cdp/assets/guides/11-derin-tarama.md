# 11 — Derin Tarama: Gölge, Ham CDP ve Tarif

*plan16 · gece vardiyasının üç bilinmeyen tuzağından damıtılan kas gücü —
Google Console savaşı, çerez nüfus sayımı ve `typed 17 of 28` çilesi.*

Bu rehber ekipmanı anlatmaz; **tuzağı** anlatır. Merdivenler kör olur, tıklamalar
sahte çıkar, yazım bütçesi sinsice biter — üçü de bir gecede eli kolu bağladı.
Artık her birinin adı, kanunu ve aracı var.

---

## 1. Üç bilinmeyen tuzak (ve kanunları)

| Tuzak | Belirti | Kanun | Çare |
|---|---|---|---|
| **T1 Gölge körü** | Sayfada apaçık duran düğme "0 candidates" der | Gölgeler içindeki ışık-DOM merdivenler için **yok**tur | `cdp_deep_click` (pierceShadow) veya `cdp_click`/`cdp_fill`'e `pierceShadow: true` |
| **T2 Sahte tık** | `el.click()` çağırırsın, işleyici **yutmaz** (pano yazmaz, `jsaction` dinlemez) | `element.click()` = **güvenilir olmayan** olay; `isTrusted` muhafızları ve bazı işleyiciler reddeder | gerçek giriş: `cdp_click(x,y)` — koordinatları ölçmek yerine `cdp_deep_click` ile atomik davran |
| **T3 Yazım kesintisi** | `Typed 17 of 28 characters — TRUNCATED` | Kesinti **süre** duvarındandır (~2 sn), karakter bütçesi değil | çözüm üretimde: süre sınırı 30 sn / 4000 karakter; **uzun gövde yine `cdp_fill`'in** (anında native setter) |

> T2'nin ikiz kuralı: **koordinat da eskir.** "Ölç → turu kapat → tıkla" zincirinde
> araya giren her yeniden çizim, eski koordinatı yanlış noktaya çevirir (iki kez
> Kaydet yerine formun başka yeri). Kural: ölçümle tık TEK fırsatta; atomik araç
> budur.

---

## 2. Gölge-DOM gerçeği

Modern konsollar (Google Cloud Console klasik vaka) yüzeyi web bileşenleriyle
örer; `querySelectorAll` yalnız ışık ağacına bakar ve **gölgeleri yok sayar**.
Merdiven (aria-label → role+name → tag+text → innerText) bu yüzden gölgeli
sayfada dürüstçe "0 candidates" der — görmediğinden, naziklikten değil.

**Kanun:** *alt-bileşen sayfasında merdiven körüdür; delen bir çözümücü gerekir.*

`pierceShadow: true` çözüm çekirdeği (`locatorPageCore`) açık gölge köklerine
**iner** (`shadowRoot` zinciri boyunca `deepAll`). Aynı bayrak `cdp_click`,
`cdp_fill` ve çekirdeği paylaşan tüm çözücü çağrıları için geçerlidir;
`cdp_deep_click` ise varsayılan olarak delerek başlar (`false` vererek ışık-DOM'a
mahsus temiz deneme de yapabilirsin).

Bilinen tek sınır (dürüstlük için): erişilebilir-ad **etiket** araması
(`label[for]`) belge düzeyinde kalır; gölge içi etiketler adlandırmaya girmez —
o durumda ad, `title`/metinden gelir.

```js
// kaynak gerçek (plan16): spec.pierceShadow açıkken collect derin yürür
const deepAll = (root, sel) => { /* … her kökte querySelectorAll, gölge
  köklerini yığına iter — tek çağrı, gölgeli sayfada bile tek sonuç */ }
```

---

## 3. `cdp_fill(force)` — perde arkasındaki alana yazmak

Eylem-yapılabilirlik raporu kutsaldır: altı eksen (attached/visible/stable/
enabled/inViewport/hitTarget) ölçülür ve eksik olan yazmayı durdurur. Ama gerçek
hayatta **hitTarget'ın kendisi yalan söyler**: "hit-target blocked: topmost element
at center is div" — Google'ın yükleme perdesi, 6 saniyelik hayatında yazmayı
durdurur; oysa native setter o perdenin altında çalışıp gidecekti.

`force: true` = perdeyi **aş**, ama ölçmeyi **bırakma**:
- `actionability` alanı yine dolu gelir (rapor tam),
- zarf `forced: true` ile damgalanır,
- render açıkça `[forced: actionability failures bypassed]` der.

**Kanun:** *baypas et, ama baypas ettiğini damgala — sessiz hile yok.*

---

## 4. Ham CDP: `cdp_raw` ve tek ev kuralı

42 araç dünyayı kırk bir amaca böler; bir amaca ait araç olmayan alanlar
`cdp_raw`'un işidir. Tek çağrı, olduğu gibi protokol:

| İş | Çağrı |
|---|---|
| Çözülmüş çerez nüfus sayımı | `Network.getAllCookies` (sayfa hedefli) |
| Yerel/kalıcı depo | `Storage.*` |
| Hedef envanteri ham hâliyle | `Target.getTargets` |

`targetId` var → sayfa oturumu (flattened session) üzerinden; yok → tarayıcı
kapsamı. Yetkiyi sınırlayan tek şey **ev kuralı** (geceki S7 öğretisi):

```
canceled: Browser.close , Target.disposeBrowserContext
  → "user browsers and profile storage never die without the user's explicit word"
tek sekmelik kasıtlı kapatma = cdp_tab_close (bilinçli araç, kayıtlı işlem)
```

**Kanun:** *ham güç, amaç aracının okumasıyla doğrulanır.* Bir `cdp_raw` sonucu
tek başına kanıt değildir; işin sahibi (`cdp_expect`, `cdp_text`, `cdp_extract`)
okuyup kapatır.

---

## 5. Görmek yerine TARİF: `cdp_describe`

Görsel girdisi olmayan bir model için ekran, kelimelerin cevaplayabileceği bir
bilmece olmalıdır. `cdp_describe(x, y, radius)` üç şey söyler:
**noktadaki düğüm** (tag/rol/ad/rect + ataları), **kompozit vuruş zinciri**
(üstte ne var), ve **komşu kutular** (≤12, görünür metinleriyle).

**Kanun:** *bu bir tariftir, OCR değildir.* Metni olmayan bir görseli yine göz
veya gören bir model yargılarcasına; dürüstlük sınırı budur. Ama DOM'lu
dünyada (şimdi hemen hemen her konsol) tarif, bakışın %90'ını geri kazandırır:

```
cdp_screenshot  →  kare düşünce
cdp_describe    →  "ekranda ne var" (DOM sözüyle)
cdp_locate      →  nokta kanıtı (neyin üstünde duruyor)
cdp_click       →  eylem
```

---

## 6. Yazım bütçesi gerçeği

`cdp_type` insan temposuyla yazar: 18–70 ms/karakter (bkz. rehber 02). Kesinti
"TRUNCATED" uyarısıyla **dürüstçe** gelir; asıl tuzak, onu karakter saymakta —
sınır **süredir**. Eski 2 sn'lik duvar 17–28 karakterde kesiyordu; şimdi 30 sn /
4000 karakter:

| İş | Araç | Neden |
|---|---|---|
| Alan doldurma, adres, başlık, ~500-1000 karakter | `cdp_type` | insan temposu + girdi olayları = çerçeve doğrular |
| Uzun gövde, yorum metni, tablo hücresi | `cdp_fill` | anında native setter + read-back `post` |
| Kaba yığın, JSON gövme | `cdp_exec` (native setter) + `cdp_fill(verify)` | tek seferde yaz, doğrula |

**Kanun:** *tipewriter daktilodur, Word değildir.*

---

## 7. Akış haritası — "gölgedeki düğme" kısa reçetesi

```
gölgedeki düğmeyi bul → gerçek tıkla → etkiyi doğrula
─────────────────────────────────────────────────────
  cdp_deep_click({ text: 'Kaydet' })        ← tek çağrı: bul + ölç + güvenilir tık
  cdp_expect({ check: 'visible', … })       ← veya işin sahibi okuması
  [degilse] cdp_describe(x, y)              ← "neyin üstündeyim?" (koordinatın dürüst ölçüsü)
  [asla]    el.click() (cdp_exec içi)       ← T2 sahte tık
```

Ham kapı için:

```
cdp_raw({ method: 'Network.getAllCookies', targetId })  ← çözülmüş kavanoz
  → kendi okumanla doğrula (ör. cdp_exec sayacı)
  → [kapatmak gerekirse] cdp_tab_close  — asla Browser.close
```

---

## 8. Bilinmeyen hata kayıtları (kanıtlı vakalar)

| Vaka | Kırık olan | Ders |
|---|---|---|
| Google Console'da Kaydet'i iki kez yanlış yere vurmak | ölç→tık turu | atomik tık şart (T2 kuzeni) |
| Panoya kopyalanan `uberip.com`'un okunamış olması | `Get-Clipboard` yarışı | yazma güvenilir tık ister (T2) |
| `typed 17 of 28 characters` | süre duvarı | T3; bütçe değil, duvar |
| Çerez nüfus sayımının üç denemede (kopya-al/robocopy/stream) düşmesi | dosya kilitleri | `Network.getAllCookies` tek çağrı |
| Aynı klasörün `canva`/`dizi`/uzun ad üçlemesi | adlandırma | biçime göre tanı: `Default\Network\Cookies` klasıdır |

---

## See also

- [Skill Architecture](10-skill-mimarisi.md) — ağ: bu üçlüden sonra hangi araca geçilir (§1 satırları 40–42).
- [DOM and Evaluation](03-dom-and-eval.md) — merdivenin anatomisi ve sınırlandırılmış değerlendirme.
- [Human Interaction](07-human-interaction.md) — ölç-tıkla disiplini ve görsele dayalı akış.
- [Scraping Master](09-scraping-master.md) — 42 araçlık envanter; 2.2b/2.3/2.5b maddeleri buradan çıkma.
- [Input and Stealth](02-input-and-stealth.md) — insan temposu ve gecikme tabloları (T3'ün kaynağı).
- [Guide Map](00-map.md) — haritanın kendisi.