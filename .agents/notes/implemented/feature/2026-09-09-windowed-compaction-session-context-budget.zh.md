# Agent Note: Pencereli özetlemeli sıkıştırma, oturum başına sıkıştırma modları ve bağlam bütçesi

Status: implemented

[English](2026-09-09-windowed-compaction-session-context-budget.md) | 中文

## Problem

Bir modelin bağlam penceresinin küçültülmesi sıkıştırmayı bozuyordu: tek-seferlik özetleyici, sıkıştırılabilir bölgenin tamamını yönerge zarfıyla tek çağrıda gönderiyordu ve küçük pencerelerde bu çağrının kendisi taşıyordu. Taşma kullanıcıya `Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.` olarak dönüyordu; kök nedenler özetleme çağrısının pencereye sığmaması ve daraltma doğrulamasının başarısız olmasıydı. Arayüzde otomatik sıkıştırmanın nerede tetikleneceği ve hangi stratejiyle özetleneceği görünmüyor, hiçbiri oturum başına ayarlanamıyordu.

## Decision

### Pencereli map-reduce hattı

compaction-basic varsayılan özetleyicisi, sıkıştırılabilir bölgeyi hedef modelin bildirilen `contextWindow` değerinden üretim tavanı, yönlendirilmiş araç şemaları, sistem başlığı ve yönerge çerçevesi düşülerek kalan bütçeye göre bütün-mesaj pencerelerine böler. Her pencere, kendisini daha uzun bir konuşmanın bir bölümü olarak tanıtan map çağrısıyla özetlenir; map çıktıları işaretli kısmi kontrol noktaları olarak çerçevelenir. Birleştirme turları, tek grup kalana dek kısmi özetleri birleştirir ve son çağrı özeti üretir. Tek pencereye sığan açıklık, yönergesi ve çerçevesi bayt-sabit kalan eski tek-seferlik çağrıyı kullanır. Pencere bütçesinden büyük tek bir mesaj ve tek özette birleştirilemeyen kısmi kontrol noktaları, sınırları adlandırılmış hatalarla gürültülü biçimde başarısız olur. Her map ve ara birleştirme çağrısı, sahnesi (`window` veya `merge`), ham çıktısı ve çözümlenmiş sağlayıcı/model bilgisiyle `compaction/summary.intermediateCalls` içine kaydedilir.

### Oturum başına sıkıştırma modu ve tetik noktası

`compaction/mode`, tam-değer-değiştiren bir oturum olayıdır: özetleyici hedefi (`conversation` modeli veya ayrı bir `provider`/`model`) ve isteğe bağlı `contextBudgetTokens`, `thresholdTokens`, `maxTokens` (özetleme çıktı tavanı) öncelikleri. Tek yazma yolu `@deepseek-ai/dsh-compaction` içindeki `setCompactionMode` olup `session.setCompactionMode` Remote'unda açığa çıkar. Okumalar `compaction/mode` ve `request/context` olaylarını `compactionPolicy` oturum projeksiyonunda katlar; görünümü etkin bütçeyi (`contextBudgetTokens` önceliği ya da yönlendirilen modelin bildirilen kapasitesi), tetik noktasını (`thresholdTokens` önceliği ya da bütçenin `thresholdRatio` oranı) ve özetleme çıktı tavanını (`maxTokens` önceliği ya da arka ucun yapılandırılmış `maxTokens` değeri) çözümler. Hem otomatik basınç sıkıştırması hem de elle `Sıkıştır` eylemi aynı oturum modunu okur; varsayılan mod konuşmayı yürüten modelinle özetler. `contextPressure` projeksiyonu doluluğu etkin bütçeyle fiyatlar; böylece bağlam göstergesinin paydası, oturum bütçesi belirlenmişse odur. `ui-model-selection` içindeki model-kapasitesi ayar paneli oturum bütçesiyle yer değiştirmiştir; model başına varsayılan `contextWindow` değerini modeller ayar sayfası, sıkıştırma tavanının kurulum varsayılanını ise Genel ayarlar sayfası (`compaction-basic.maxTokens`) taşır.

### Sohbette görünürlük

Pencereli yürüyüş çalışırken görünür: map sahnesi `compaction/windows` ekler ve sohbet sıkıştırma işaretçisi, ilişkilendirilmiş yaşam döngüsü olaylarından `status` (`running`, `landed`, `failed`) ve `windows` alanlarını katlar. Çalışan pencereli işaretçi "Pencereli özetleme çalışıyor ({windows} pencere)" okur; inen işaretçi pencere sayısını korur.

## Alternatives considered

**Tek-seferlik özetlemeyi koruyup yalnızca yeniden deneme payını büyütmek.** Bu, taşma sınıfını olduğu gibi bırakır: pencereden büyük her bölge yine başarısız olur ve başarısızlık, kullanıcıların pencereyi küçülttükten sonra çarptığı hatanın ta kendisidir.

**Özet yönergesini veya özet bütçesini küçültüp sığdırmak.** Yönerge zaten sıradan pencerelere sığar; onu küçültmek, özetteki bilgiyi feda eder ve bölgenin sorunun kendisi olduğu çok küçük pencerelerde hiçbir güvenlik kazandırmaz.

**Oturum başına pencere-token önceliği (paketleme için pencere genişliği).** Bütçe ve tetik noktası kontrolleri lehine reddedildi: paketleme genişliği hedef modelin gerçek penceresinin bir özelliği iken kullanıcının yönetmek istediği şey, sıkıştırmanın nerede başlayacağı ve oturumun ne kadar bağlam tutabileceğidir.

**Mod yazması için komut satırı `/compact` değişkenleri.** permission-presets komut örneği ile `model/selection` Remote örneği tartışıldı. Yazma, model seçimi gibi biçim görünümlü, sessiz, tam-değerli bir seçim olduğundan `session.setCompactionMode` olarak yayımlanır; sıkıştır komutu sıkıştırmayı şimdi çalıştırmaya devam eder.

**Yalnızca ayarlar düzeyinde varsayılan bağlam penceresi.** Bununla birlikte korundu, onun yerine değil: ayar değeri yeni oturumları tohumlar, oturum başına bütçe de canlı koldur. Tek başına ikisi de iki ihtiyacı karşılamaz.

## Consequences

Pencereli özetleme, pencere başına bir map çağrısı ve birleştirme turları maliyet eder; her map çağrısı, önbellek sağlayıcı önekini sıcak tutmak için sistem başlığını ve araç şemalarını yeniden yollar; compaction-basic Model Experience bölümü bunu fiyatlar. `compaction/summary` `intermediateCalls` kayıtlarıyla genişler ve `compaction/windows` kalıcı günlüğe girer; bu, oturum biçimine katmanlı bir eklemedir ve `SESSION_FORMAT_VERSION` değerini artırmaz. Tek-seferlik yol bayt-sabittir; böylece sıradan sıkıştırma çıktısının kaydedilmiş anlık görüntüleri kaymaz. Bir `resolveCallWithInfo` tip hatası onarımının, belgelenmiş desteklenmeyen-çaba reddini sessizce yedek değere çevirdiği bir ara dönem yaşandı; bu değişiklik reddi geri yükler; llm hizmet paketi ile session-models paketi bunu pinler.

## Testing

compaction-basic pencereli paketi; çok-pencereli map ve tek-birleştirme yürüyüşlerini, ara birleştirme turlarını, yakınsama başarısızlığını, dev-mesaj başarısızlığını, tek-seferlik sabitliği, `compaction/windows` bildirimini ve ayrı-ayrı moda yönlendirmeyi pinler. Mod paketi sözcük koruyucusunu ve tam-değerli yazmaları; policy-projection paketi katlamayı, etkin bütçe ve tetik noktasını; token-meter paketi bütçe paydasını pinler. session-controller paketi yazmayı, teldaki koruyucu reddini ve ortak bulunamadı yolunu pinler. sohbet düğümü paketi, hem otomatik hem elle yolda çalışan, inen ve başarısız evreleri pencere sayılarıyla pinler.
