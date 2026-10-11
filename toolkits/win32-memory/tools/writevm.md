# `writevm` — kapsam/onay kontrollü bellek yazma

Yetki: `kernel` · Ateşleme gömme: `code+guide` · Kod: [`writevm.rs`](writevm.rs)

## Görev

Sanal adres aralığına yazar. Yazım kapısı iki kademelidir ve ikisi de `WriteProcessMemory`'den ÖNCE geçilir:

1. **Yazım kapsamı** (`scope_allow` aralıkları): `[start, end)` aralıklarının birleşimi; `[addr, addr+len)` tamamen kapsanmıyorsa `E_OUT_OF_SCOPE`.
2. **Çağrı-başı onay kancası** (`wme_set_confirm_hook`): kancanın `1` dönmesi yazar; `0` ya da hiç kanca olmaması `E_REJECTED` üretir ve yazım hiç uğramaz.

Yazım yolu tek: `MemoryActuator::actuate`. Bağımsız serbest yazım fonksiyonu yoktur.

## Giriş

| Alan | Tip | Açıklama |
| --- | --- | --- |
| `addr` | `u64` | hedef sanal adres |
| `bytes` | `u8[]` | yazılacak ham baytlar |
| `tag` | `string` | kancaya taşınan niyet etiketi |
| `scope` | `Range<u64>[]` | kapsam aralıkları (`scope_allow`/`scope_clear` ile yönetilir) |

IPC karşılığı: `{"cmd":"scope_allow","pid","ranges":[[s,e]]}`, `{"cmd":"scope_clear"}`, `{"cmd":"actuate","pid","addr","bytes","tag"}`.

## Çıkış

| Durum | Şema |
| --- | --- |
| yazıldı | `{"ok":true,"data":{"wrote": <bayt>}}` |
| kapsam reddi | `{"ok":false,"error":{"code":"E_OUT_OF_SCOPE","detail","win32"}}` |
| kanca reddi / kanca yok | `{"ok":false,"error":{"code":"E_REJECTED","detail","win32"}}` |
| kısa yazım | `{"ok":false,"error":{"code":"E_SHORT_WRITE","detail","win32"}}` |