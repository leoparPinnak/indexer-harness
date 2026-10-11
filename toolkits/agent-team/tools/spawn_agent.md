# spawn_agent — Alt ajan doğurma

**Yetki:** process · **Sınıf:** çağıranın kendi süreç hiyerarşisi

Adlandırılmış bir **rol** ve **görev** ile bağımsız çalışan bir alt ajan doğurur.
Çocuk kendi Thought→Action→Observation döngüsünde koşar; sonuç `AgentTurnOutcome`
olarak döner; gerekirse `send_agent` ile sürdürülür.

- `forkMode: "clean"` → çocuk sıfır bağlamla başlar.
- `forkMode: "fork"` → çocuk ebeveynin sohbet kopyasından devam eder.
- `isolation: "worktree"` → çocuk **izole `git worktree`** içinde koşar (detached); yazmalar/commit'leri ana ağacı kirletmez, dal kalıntısı = çocuğun teslim yüzeyi.
- `budget` → tur/saniye sınırı (çekirdek reddi = kodlu hata, sessizlik yok).
- Model/effort verilmezse **ebeveyn hedefi miras** alınır.

Kullanıp kullanmamak tamamen senin kararındır. Desenler için `GUIDE.md`.