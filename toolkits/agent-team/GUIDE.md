# agent-team — Alt Ajan Takımı (Yetki: process)

Bu kılavuz, **modelin kendi alt ajanlarını doğurup yönetmesi** için çekirdek
mekanizmayı tanıtır. Kaynak gerçek: `codex-rs/core/src/agent/` (child_config,
control/{execution, mailbox, delivery, budget, residency, interrupt, resume})
— üretim seviyesinde ajan hiyerarşisi.

## Kural (bu kılavuzun ruhu)
Araçlar verilir, ne yaptığı söylenir; **hangisini ne zaman kullanacağı tamamen
modelin insiyatifindedir**. Bu sette ZORLAMA, kısıt, yasak YOKTUR.

## Yetenek kümesi
| Beceri | Mekanizma | Kanıt |
|---|---|---|
| Alt ajan doğurma | `spawn_agent` araç çağrısı (adlandırılmış rol + görev) | `core/src/agent/child_config.rs` |
| Görev/aksiyon döngüsü | `control/execution.rs` (Thought→Action→Observation sarmalı) | `core/src/agent/control/execution.rs` |
| Çocuk yönetimi | bütçe (`budget.rs`), mesaj kutusu (`mailbox.rs`), teslim (`delivery.rs`), yerleşiklik (`residency.rs`) | `core/src/agent/control/` |
| Yaşam döngüsü | kesme (`interrupt.rs`), sürdürme (`resume.rs`), bitiş kanonikleştirme (`completion.rs`) | `core/src/agent/control/` |
| Rol çözümü | `role.rs` + `agent_resolver.rs` + `registry.rs` | model/effort/servis katmanı çocuğa miras |

## `spawn_agent` — ham sözleşme
```json
{ "name": "spawn_agent",
  "arguments": {
    "role": "coder | reviewer | scout | custom",
    "name": "iş adı (kısa, tekil)",
    "prompt": "çocuğun görevi — tek, kendi kendine yeterli dilim",
    "model": "opsiyonel: provider/model (yoksa ebeveynin hedefi)",
    "effort": "opsiyonel: düşük|orta|yüksek",
    "budget": { "maxTurns": 24, "maxSeconds": 900 }
  } }
```
Çocuk, kendi **bağımsız agent-loop**'unda koşar; sonuç `mailbox` üzerinden
ebeveyne raporlanır; `completion` kanonik bitişi üretir. Ebeveyn isterse zincirle
çocuk doğurur (max derinlik çekirdek yapılandırmasıyla sınırlıdır).

## Görev dağıtım desenleri (kullanım örüntüleri)
1. **Parça+birleştir**: büyük işi bağımsız dilimlere böl, her dilime bir çocuk, sonuçları kendin birleştir.
2. **Keşif-önce**: keşif çocukları okuma-yalnız rapor döndürür; yazma işi ebeveynde kalır.
3. **Yarış**: aynı işe iki farklı rol/strateji çocuk gönder, üstün geleni esas al.
4. **Denetim zinciri**: üretici çocuğun çıktısını denetçi çocuğa yorumlat.
5. **İzole çatal (yeni)**: `forkMode: "fork"` + `isolation: "worktree"` → çocuk ebeveyn sohbetini çatallar VE izole çalışma kopyasında yazar; sonuç = kirletilmemiş ana ağaç + incelemeye açık worktree.

## Sınır notları (tarafsız)
- Derinlik/bütçe çekirdek ayarlarıyla verilir; aşım çocuk reddi üretir.
- Çocuklar ebeveynin oturum logundan **kopuk** çalışır (bağımsız bağlam penceresi); özetlenerek birleşir.

## manifest.json
```json
{
  "setId": "agent-team",
  "title": "Alt Ajan Takımı",
  "capabilitySet": "agent-orchestration",
  "authority": "process",
  "personaSummary": "Kendi alt ajanlarını doğurabilir, görev dağıtabilir, sonuçları birleştirebilirsin.",
  "tools": [
    { "id": "spawn_agent", "authority": "process", "guide": "tools/spawn_agent.md", "code": "tools/spawn_agent.json", "fireEmbed": "code", "summary": "Adlandırılmış rol ve bütçeyle bağımsız alt ajan doğurur." }
  ]
}
```