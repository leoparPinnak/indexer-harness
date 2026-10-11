# `hwndmap` — Direct HWND Mapping

Yetki: `observe` · Ateşleme gömme: `code` · Kod: [`hwndmap.rs`](hwndmap.rs)

## Görev

Süreç → pencere (HWND) eşlemesini doğrudan pencere ağacından çıkarır: `EnumWindows` tek geçişte sınıf adı, başlık, dikdörtgen (sol/üst/sağ/alt), sahiplik (`GW_OWNER`) ve görünürlük toplar. Sonuç `pid` anahtarlı harita olarak sunulur ve kirli-damga + TTL önbelleği (`UiCache`) ile yönetilir: damga değişmedikçe ve TTL dolmadıkça yeniden tarama yapılmaz; `poll` ikinci bileşeninde `yenilendi_mi` bilgisini verir.

## Giriş

| Alan | Tip | Açıklama |
| --- | --- | --- |
| `pid` | `u32?` | verilirse yalnız o sürecin pencereleri süzülür |
| `ttl` | `Duration` | önbellek yaşam süresi (`ui_attach` ile kurulur) |
| `poll` | `bool` | yalnız damga/TTL sorgusu |

IPC karşılığı: `{"cmd":"ui_attach","pid","ttl_ms"}`, `{"cmd":"ui_detach"}`, `{"cmd":"status"}` (son eşleme özeti).

## Çıkış

`{"ok":true,"data":{"windows":[{"hwnd","pid","tid","class","title","rect":[l,t,r,b],"owned","visible"}],"changed": bool}}`

Boş liste, penceresiz süreç için geçerli sonuçtur. Alt/çocuk pencereler yalnız üst pencere ağacından değil, tüm masaüstü taramasından gelir.