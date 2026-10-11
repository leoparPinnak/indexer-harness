# `scancode` — ham scan-code girdi enjeksiyonu

Yetki: `input` · Ateşleme gömme: `code+guide` · Kod: [`scancode.rs`](scancode.rs)

## Görev

Ham set-1 scan-code klavye ve fare olaylarını `SendInput` ile enjekte eder. İki aşamalıdır:

1. **Planlama (saf)** — `plan(strokes, seed)` vuruşları bas/bırak olay çiftlerine açar ve zamanlamayı önceden üretir: her olay için `delay_ms` (tuşta: basış sonrası `hold_ms` kadar bekleme, ardından bırakma). Titreşim deterministik xorshift ile üretilir; aynı `seed` aynı planı verir.
2. **Yürütme (adanan OS thread)** — `InputWorker` işleri kanaldan çeker, `delay_ms` uyur, `SendInput(KEYEVENTF_SCANCODE)` ile gönderir (`extended` kodlarda `KEYEVENTF_EXTENDEDKEY`/0xE0 öneki). Sıcak döngü hiçbir zaman bloke beklemeye girmez.

## Giriş

| Alan | Tip | Açıklama |
| --- | --- | --- |
| `strokes` | `Stroke[]` | `Key{code,hold_ms}` \| `Move{x,y}` \| `LButton{down}` |
| `seed` | `u64` | zamanlama titreşim tohumu |
| `code` | `{code: u16, extended: bool}` | ham tarama kodu (ör. 0x1E = A) |

IPC karşılığı: `{"cmd":"send_scancode","strokes":[...],"seed"}`.

## Çıkış

Plan (yatay özet): `{"ok":true,"data":{"events":[{"event","delay_ms"}]}}`; yürütme sonrası `{"sent": <olay sayısı>}`. `SendInput` sıfır olay kabul ederse `io::Error` (son Win32 hatası) döner.

## Mekanik not

UIPI: girdi, enjekte eden sürecin bütünlük seviyesi hedefinkine eşit/üstünde olduğunda hedefe ulaşır; alttaysa hedef tarafında sessizce düşer (motor bunu raporlayamaz). Fare koordinatları `MOUSEEVENTF_ABSOLUTE` uzayında 0..65535. Klavye olayları VKey değil, doğrudan scan-code taşır; tuş yerleşimi tarama kodundan bağımsızdır.