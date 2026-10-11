/*++
  win32-kernel-bridge — shared/me_ioctl.h

  WinMemEng IOCTL ABI v1 — TEK KAYNAK (single source of truth).
  Hem KMDF sürücüsü (driver/) hem UM yükleyici (loader/) bu başlığı tüketir:
    - driver/ : doğrudan #include eder.
    - loader/ : build.rs içinde bindgen ile derlenir (OUT_DIR/me_ioctl.rs).

  Sabit değerler yalnız burada tanımlıdır; hiçbir yerde kopyalanmaz.
  Yapı boyutları/yerleşimi MSVC x64 ABI'sına göre doğal hizalıdır,
  paketleme kullanılmaz (wire = ham struct gönderimi).

Copyright (c) 2026 DSH. Tüm hakları saklıdır.
--*/

#ifndef WINMEMENG_SHARED_ME_IOCTL_H
#define WINMEMENG_SHARED_ME_IOCTL_H

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
 * Taşınabilir sabit genişlikli tipler (kernel + UM ortak).
 * MSVC hedeflerinde sizeof(me_u64)==8, sizeof(me_i32)==4, sizeof(me_u16)==2.
 * -------------------------------------------------------------------------- */
typedef unsigned char       me_u8;
typedef unsigned short      me_u16;
typedef unsigned int        me_u32;
typedef unsigned __int64    me_u64;
typedef int                 me_i32;
typedef unsigned short      me_wchar;

/* --------------------------------------------------------------------------
 * Cihaz kimliği
 *   NT adı        : \Device\WinMemEng
 *   DOS bağlantısı: \DosDevices\WinMemEng  (=>  \\.\WinMemEng )
 *   Arayüz GUID   : ME_GUID_* makroları (device interface registration)
 * -------------------------------------------------------------------------- */
#define ME_ABI_VERSION              1u

#define ME_NT_DEVICE_NAME           L"\\Device\\WinMemEng"
#define ME_DOS_DEVICE_NAME          L"\\DosDevices\\WinMemEng"
#define ME_USER_DEVICE_PATH         "\\\\.\\WinMemEng"

#define ME_KERNEL_SERVICE_NAME      L"WinMemEng"       /* sc create / NtLoadDriver */
#define ME_KERNEL_IMAGE_FILENAME    L"winmemeng.sys"

/* GUID_DEVINTERFACE_WinMemEng — {5F4E2A1B-9C8D-4E7A-B361-C0DE4188A722} */
#define ME_IFGUID_DATA1             0x5F4E2A1Bu
#define ME_IFGUID_DATA2             0x9C8Du
#define ME_IFGUID_DATA3             0x4E7Au
#define ME_IFGUID_DATA4_INIT        { 0xB3u, 0x61u, 0xC0u, 0xDEu, 0x41u, 0x88u, 0xA7u, 0x22u }

/* --------------------------------------------------------------------------
 * IOCTL kodları
 * Cihaz tipi 0x8000 (özel üretim alanı), tüm erişimler tamponludur /
 * özel işaretçi (METHOD_NEITHER) ile yapılır. Cihaz kendisi yönetici
 * ACL'lidir; IOCTL erişim hakkı bayrakları bu nedenle FILE_ANY_ACCESS.
 *
 *   CTL_CODE(type, function, method, access) =
 *       (type << 16) | (access << 14) | (function << 2) | method
 * -------------------------------------------------------------------------- */
#define ME_METHOD_BUFFERED          0u
#define ME_METHOD_NEITHER           3u
#define ME_ACCESS_ANY               0u

#define ME_CTL_CODE(fn, method) \
    ((0x8000u << 16) | ((fn) << 2) | (method))

#define IOCTL_ME_READVM             ME_CTL_CODE(0x801u, ME_METHOD_NEITHER)  /* uzak VA -> istemci tamponu  */
#define IOCTL_ME_WRITEVM            ME_CTL_CODE(0x802u, ME_METHOD_NEITHER)  /* istemci tamponu -> uzak VA  */
#define IOCTL_ME_PROTECT            ME_CTL_CODE(0x803u, ME_METHOD_BUFFERED) /* süreç izleme kaydı yönetimi */
#define IOCTL_ME_INJECT_SCANCODE    ME_CTL_CODE(0x804u, ME_METHOD_BUFFERED) /* KEYBOARD_INPUT_DATA akışı   */
#define IOCTL_ME_INJECT_MOUSE       ME_CTL_CODE(0x805u, ME_METHOD_BUFFERED) /* MOUSE_INPUT_DATA akışı      */
#define IOCTL_ME_PID_OF             ME_CTL_CODE(0x806u, ME_METHOD_BUFFERED) /* görüntü adı -> PID+taban    */
#define IOCTL_ME_MODULES            ME_CTL_CODE(0x807u, ME_METHOD_BUFFERED) /* modül tabanları (nt dinamik)*/

/* --------------------------------------------------------------------------
 * Boyut sınırları (sürücü tarafından zorlanır; aşan istekler STATUS_INVALID_PARAMETER)
 * -------------------------------------------------------------------------- */
#define ME_MAX_TRANSFER_BYTES       (16u * 1024u * 1024u)   /* tek VM kopyası üst sınırı  */
#define ME_MAX_WATCH_PIDS           128u                    /* hedef PID listesi kapasite */
#define ME_MAX_EVENTS               256u                    /* izleme kaydı halkası       */
#define ME_MAX_SCANCODES            64u                     /* tek enjeksiyon isteğinde   */
#define ME_MAX_PROCESS_RESULTS      64u                     /* IOCTL_ME_PID_OF azami sayı */
#define ME_MAX_MODULES              512u                    /* IOCTL_ME_MODULES azami sayı*/
#define ME_IMAGE_NAME_CHARS         64u                     /* WCHAR görüntü adı          */
#define ME_MODULE_NAME_CHARS        260u                    /* WCHAR modül adı            */

/* --------------------------------------------------------------------------
 * IOCTL_ME_READVM / IOCTL_ME_WRITEVM  (giriş = ME_RW_IN; ikinci tampon = veri)
 *
 * Yönlendirme IOCTL kodundan bellidir (METHOD_NEITHER çift yön):
 *   READVM  : lpInBuffer = ME_RW_IN; lpOutBuffer = veri (uzak süreçten okunur).
 *   WRITEVM : lpInBuffer = [ME_RW_IN][veri]; nInBufferSize = sizeof(ME_RW_IN)+size.
 *
 * Sürücü kullanılan kullanıcı tampon(lar)ını MDL ile kilitler
 * (unload temizliğinde mutlaka açar).
 * Erişim handle gerektirmez: EPROCESS = PID -> PsLookupProcessByProcessId,
 * kopyalama = MmCopyVirtualMemory (ntoskrnl dışa aktarımı). PPL dahil.
 */
typedef struct _ME_RW_IN {
    me_u32  pid;        /* hedef süreç                              */
    me_u32  reserved;   /* 0                                        */
    me_u64  address;    /* hedef süreçte sanal adres                */
    me_u64  size;       /* bayt; 0 < size <= ME_MAX_TRANSFER_BYTES  */
} ME_RW_IN;

/* --------------------------------------------------------------------------
 * IOCTL_ME_PROTECT  (tamponlu; giriş ME_PROTECT_IN, DRAIN'de çıkış = olaylar)
 *
 * PsSetCreateProcessNotifyRoutineEx ile sürücü yüklendiğinden beri tüm
 * süreç oluşturma/çıkış olaylarını görür; kayıt yalnız hedef PID listesindeki
 * süreçler için tutulur. Kilit disiplini: FAST_MUTEX (spinlock YOK).
 */
#define ME_PROTECT_ADD      1u      /* pid izleme listesine girer          */
#define ME_PROTECT_REMOVE   2u      /* pid listeden çıkar                   */
#define ME_PROTECT_CLEAR    3u      /* liste boşaltılır                     */
#define ME_PROTECT_DRAIN    4u      /* birikmiş kayıtlar boşaltılır (sıralı) */

#define ME_EVENT_CREATE     1u
#define ME_EVENT_EXIT       2u

typedef struct _ME_PROTECT_IN {
    me_u32  opcode;         /* ME_PROTECT_*                                 */
    me_u32  pid;            /* ADD/REMOVE için hedef; CLEAR/DRAIN'de yok sayılır */
    me_u32  maxEvents;      /* DRAIN'de alınacak azami kayıt sayısı          */
    me_u32  reserved;       /* 0                                             */
} ME_PROTECT_IN;

typedef struct _ME_EVENT {
    me_u32  recordType;                 /* ME_EVENT_*                        */
    me_u32  reserved;                   /* 0                                 */
    me_u64  pid;                        /* olayın süreci                     */
    me_u64  parentPid;                  /* ebeveyn (create için anlamlı)     */
    me_u64  time100ns;                  /* KeQueryInterruptTime benzeri sayaç */
    me_u16  imageName[ME_IMAGE_NAME_CHARS]; /* WCHAR, taban görüntü adı      */
} ME_EVENT;

/* --------------------------------------------------------------------------
 * IOCTL_ME_INJECT_SCANCODE  (tamponlu; giriş ME_INJECT_SCANCODE_IN)
 *
 * Verilen MAKE/BREAK dizisi, klavye sınıf-servis geri çağrısına KEYBOARD_INPUT_DATA
 * olarak donanım görünümlü biçimde iletilir (Win32k kuyruğunun DIŞINDAN).
 * Geri çağırma henüz bağlanmadıysa sürücü STATUS_DEVICE_NOT_READY döndürür;
 * enjeksiyon tekrar deneninceye kadar istekler güvenli biçimde reddedilir.
 */
#define ME_KEY_MAKE     0x0000u     /* tuş basımı        (KEY_MAKE)  */
#define ME_KEY_BREAK    0x0001u     /* tuş bırakımı      (KEY_BREAK) */
#define ME_KEY_E0       0x0002u     /* E0 öneki           (KEY_E0)    */
#define ME_KEY_E1       0x0004u     /* E1 öneki           (KEY_E1)    */

typedef struct _ME_SCANCODE_ENTRY {
    me_u16  makeCode;       /* tarama kodu (set-1)                  */
    me_u16  flags;          /* ME_KEY_* bayrakları                  */
} ME_SCANCODE_ENTRY;

typedef struct _ME_INJECT_SCANCODE_IN {
    me_u32  unitId;                             /* KEYBOARD_INPUT_DATA.UnitId */
    me_u32  count;                              /* 0 < count <= ME_MAX_SCANCODES */
    ME_SCANCODE_ENTRY keys[ME_MAX_SCANCODES];
} ME_INJECT_SCANCODE_IN;

/* --------------------------------------------------------------------------
 * IOCTL_ME_INJECT_MOUSE  (tamponlu; giriş ME_INJECT_MOUSE_IN)
 *
 * MOUSE_INPUT_DATA olarak sınıf-servis geri çağrısına veri akıştırılır.
 * Göreli hareket: flags=ME_MOUSE_MOVE_RELATIVE, lastX/lastY = piksel delta.
 */
#define ME_MOUSE_MOVE_RELATIVE      0x0000u
#define ME_MOUSE_MOVE_ABSOLUTE       0x0001u

#define ME_MOUSE_LEFT_BUTTON_DOWN   0x0001u
#define ME_MOUSE_LEFT_BUTTON_UP     0x0002u
#define ME_MOUSE_RIGHT_BUTTON_DOWN  0x0004u
#define ME_MOUSE_RIGHT_BUTTON_UP    0x0008u
#define ME_MOUSE_MIDDLE_BUTTON_DOWN 0x0010u
#define ME_MOUSE_MIDDLE_BUTTON_UP   0x0020u
#define ME_MOUSE_WHEEL              0x0400u     /* lastX değil, ButtonData kullanılır */

typedef struct _ME_INJECT_MOUSE_IN {
    me_u16  unitId;             /* MOUSE_INPUT_DATA.UnitId   */
    me_u16  flags;              /* ME_MOUSE_MOVE_*           */
    me_u16  buttonFlags;        /* ME_MOUSE alt düğme bayrakları */
    me_u16  buttonData;         /* tekerlek için deltası     */
    me_i32  lastX;              /* X: delta veya mutlak      */
    me_i32  lastY;              /* Y: delta veya mutlak      */
    me_u32  extraInformation;   /* MOUSE_INPUT_DATA.ExtraInformation */
} ME_INJECT_MOUSE_IN;

/* --------------------------------------------------------------------------
 * IOCTL_ME_PID_OF  (tamponlu; giriş ME_PID_OF_IN, çıkış ME_PID_OF_OUT)
 *
 * Görüntü adı (büyük/küçük harf duyarsız taban ad) ile süreç arar.
 * EPROCESS alanları dinamik imza çözücüyle bulunur (bkz. driver/procinfo.c);
 * sürümden bağımsızdır. Aynı adlı birden fazla süreç varsa hepsi döner.
 */
typedef struct _ME_PID_OF_IN {
    me_u16  imageName[ME_IMAGE_NAME_CHARS]; /* WCHAR, NUL-sonlu taban ad */
} ME_PID_OF_IN;

typedef struct _ME_PID_ENTRY {
    me_u64  pid;            /* süreç kimliği                     */
    me_u64  imageBase;      /* görüntü tabanı (PEB, yani ana modül) */
} ME_PID_ENTRY;

typedef struct _ME_PID_OF_OUT {
    me_u32  count;          /* doldurulan giriş sayısı (<= ME_MAX_PROCESS_RESULTS) */
    me_u32  reserved;       /* 0                                                     */
    ME_PID_ENTRY entries[ME_MAX_PROCESS_RESULTS];
} ME_PID_OF_OUT;

/* --------------------------------------------------------------------------
 * IOCTL_ME_MODULES  (tamponlu; giriş ME_MODULES_IN, çıkış ME_MODULES_OUT)
 *
 * Sürecin PEB -> Ldr InMemoryOrderModuleList zinciri taranarak modül tabanları
 * toplanır. Dizinin sonuna ntoskrnl.tabanı tek giriş olarak eklenir ve
 * ntosIndex ile işaretlenir; o taban dinamik çözülür (PDB yok).
 */
typedef struct _ME_MODULES_IN {
    me_u32  pid;
    me_u32  reserved;       /* 0 */
} ME_MODULES_IN;

typedef struct _ME_MODULE_ENTRY {
    me_u64  imageBase;
    me_u64  imageSize;
    me_u32  isNtoskrnl;     /* 1 => ntoskrnl.exe girişi (dinamik taban) */
    me_u32  reserved;       /* 0 */
    me_u16  name[ME_MODULE_NAME_CHARS]; /* WCHAR modül taban adı */
} ME_MODULE_ENTRY;

typedef struct _ME_MODULES_OUT {
    me_u32  count;          /* doldurulan giriş sayısı (<= ME_MAX_MODULES) */
    me_u32  ntosIndex;      /* ntoskrnl girişinin indeksi; yoksa 0xFFFFFFFFu */
    ME_MODULE_ENTRY entries[ME_MAX_MODULES];
} ME_MODULES_OUT;

#ifdef __cplusplus
}
#endif

#endif /* WINMEMENG_SHARED_ME_IOCTL_H */