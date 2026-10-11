// kinput — sınıf girdi enjeksiyonu: pencere sınıfı adıyla pencere bul + win32k
// uzerinden ham INPUT paketleri enjekte et.
//
// Yontem: win32kfull servis fonksiyonlarina dogrudan cagri. Indisler musteri
// tarafindan BIND ile getirilir (kullanicinin kendi win32k cagri yongasindan:
// `mov eax, idx; syscall` = B8 xx xx xx xx 0F 05). Surucu bu indisleri golge
// SSDT'deki (win32k servis tablosu) fonksiyon isaretcilerine cevirir, oturum
// dogru GUI baglamina KeStackAttachProcess ile baglanir ve su cagrilari yapar:
//
//   NtUserFindWindowEx(NULL, NULL, &classUS, NULL, 0) -> HWND
//   NtUserSetForegroundWindow(hwnd)
//   NtUserSendInput(count, inputs, cbSize)
//
// Surucu is parcacigi PreviousMode=Kernel oldugundan win32k on-suzecleri
// (kullanici isaretcisi dogrulamalari) devreye girmez; INPUT paketleri ham
// iletilir (x64'te sizeof(INPUT)=40). Doner baglam: cagridan surecin kendi
// baglamina geri donulur.
#include <ntddk.h>

#define DSHKBR_DEVICE_NAME L"\\Device\\DshKbr"
#define DSHKBR_SYMLINK     L"\\DosDevices\\DshKbr"

#define IOCTL_KINPUT_BIND       CTL_CODE(FILE_DEVICE_UNKNOWN, 0x840, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_KINPUT_CLASS_SEND CTL_CODE(FILE_DEVICE_UNKNOWN, 0x841, METHOD_BUFFERED, FILE_ANY_ACCESS)

typedef struct _KINPUT_BIND_REQ {
    UINT32 idx_send_input;
    UINT32 idx_find_window;
    UINT32 idx_set_fg;
    UINT32 reserved;
} KINPUT_BIND_REQ;

typedef struct _KINPUT_CLASS_REQ {
    UINT32 gui_pid;        // oturum donuru surec (GUI baglam saglayicisi)
    UINT32 input_count;
    UINT32 input_cb;       // tek INPUT boyutu (x64: 40)
    UINT32 reserved;
    WCHAR  class_name[64]; // sinif adi (UTF-16, NUL sonlu)
    // ardindan input_count * input_cb bayt ham INPUT dizisi gelir
} KINPUT_CLASS_REQ;

typedef struct _KINPUT_RESP { UINT64 hwnd; UINT32 sent; UINT32 pad; } KINPUT_RESP;

// Golge SSDT tanimi (bilinen yerlesim).
typedef struct _KSERVICE_TABLE_DESCRIPTOR {
    PULONG_PTR Base;
    PULONG     Count;
    ULONG      Limit;
    PUCHAR     Number;
} KSERVICE_TABLE_DESCRIPTOR, *PKSERVICE_TABLE_DESCRIPTOR;

extern KSERVICE_TABLE_DESCRIPTOR KeServiceDescriptorTable; // ntoskrnl disa aktarimi

typedef PVOID (*PFN_NTFINDWINDOWEX)(PVOID parent, PVOID child,
                                    PUNICODE_STRING class_us, PUNICODE_STRING title_us,
                                    ULONG flags);
typedef BOOLEAN (*PFN_NTSETFG)(PVOID hwnd);
typedef UINT32  (*PFN_NTSENDINPUT)(UINT32 count, PVOID inputs, INT32 cb_size);

static PDEVICE_OBJECT g_device = NULL;
static PKSERVICE_TABLE_DESCRIPTOR g_win32k = NULL;
static KINPUT_BIND_REQ g_bind = { 0 };   // BIND ile iliştirilen win32k indisleri

static BOOLEAN CanonicalKernelPtr(PVOID p)
{
    ULONG_PTR v = (ULONG_PTR)p;
    return v > 0xFFFFF00000000000ULL && v != (ULONG_PTR)-1;
}

// Golge SDT'yi bul: KeServiceDescriptorTable'i cevreleyen hizali taramada
// dort tanimlik blog; kazanan adayin ikinci tanimi (win32k) oturum uzayi
// isaretci tasir ve Limit degeri bilinen win32k tablo genisligindedir.
static PKSERVICE_TABLE_DESCRIPTOR LocateWin32kTable(void)
{
    PUCHAR lo = (PUCHAR)&KeServiceDescriptorTable - 0x4000;
    PUCHAR hi = (PUCHAR)&KeServiceDescriptorTable + 0x20000;

    for (PUCHAR p = lo; p < hi; p += 0x10) {
        PKSERVICE_TABLE_DESCRIPTOR d = (PKSERVICE_TABLE_DESCRIPTOR)p;
        if (d[0].Base != KeServiceDescriptorTable.Base) continue;
        if (d[1].Limit < 0x200 || d[1].Limit > 0x2000) continue;
        if (!CanonicalKernelPtr((PVOID)d[1].Base)) continue;
        if (d[1].Number == NULL) continue;
        return &d[1];
    }
    return NULL;
}

static NTSTATUS ResolveService(UINT32 idx, PVOID *fn)
{
    if (g_win32k == NULL) {
        g_win32k = LocateWin32kTable();
        if (g_win32k == NULL) return STATUS_DEVICE_CONFIGURATION_ERROR;
    }
    if (idx >= g_win32k->Limit) return STATUS_INVALID_PARAMETER;
    PVOID p = (PVOID)g_win32k->Base[idx];
    if (!CanonicalKernelPtr(p)) return STATUS_INVALID_ADDRESS;
    *fn = p;
    return STATUS_SUCCESS;
}

static NTSTATUS HandleClassSend(const KINPUT_CLASS_REQ *rq, const UCHAR *inputs, KINPUT_RESP *resp)
{
    RtlZeroMemory(resp, sizeof(*resp));

    PFN_NTFINDWINDOWEX p_find;
    PFN_NTSETFG        p_fg;
    PFN_NTSENDINPUT    p_send;
    NTSTATUS st = ResolveService(g_bind.idx_find_window, (PVOID *)&p_find);
    if (!NT_SUCCESS(st)) return st;
    st = ResolveService(g_bind.idx_set_fg, (PVOID *)&p_fg);
    if (!NT_SUCCESS(st)) return st;
    st = ResolveService(g_bind.idx_send_input, (PVOID *)&p_send);
    if (!NT_SUCCESS(st)) return st;

    // GUI baglam doner surec: hedef oturumda herhangi bir GUI sureci.
    PEPROCESS donor = NULL;
    st = PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)rq->gui_pid, &donor);
    if (!NT_SUCCESS(st)) return st;

    KAPC_STATE apc;
    KeStackAttachProcess((PKPROCESS)donor, &apc);

    UNICODE_STRING class_us;
    RtlInitUnicodeString(&class_us, rq->class_name);

    PVOID hwnd = p_find(NULL, NULL, &class_us, NULL, 0);
    resp->hwnd = (UINT64)(ULONG_PTR)hwnd;
    if (hwnd != NULL) {
        p_fg(hwnd);
        resp->sent = p_send(rq->input_count, (PVOID)inputs, (INT32)rq->input_cb);
    }

    KeUnstackDetachProcess(&apc);
    ObDereferenceObject(donor);
    return STATUS_SUCCESS;
}

static NTSTATUS DispatchDeviceControl(PDEVICE_OBJECT dev, PIRP irp)
{
    UNREFERENCED_PARAMETER(dev);
    PIO_STACK_LOCATION sp = IoGetCurrentIrpStackLocation(irp);
    NTSTATUS st = STATUS_INVALID_DEVICE_REQUEST;
    ULONG_PTR info = 0;
    ULONG in_len = sp->Parameters.DeviceIoControl.InputBufferLength;

    switch (sp->Parameters.DeviceIoControl.IoControlCode) {
    case IOCTL_KINPUT_BIND: {
        if (in_len < sizeof(KINPUT_BIND_REQ)) { st = STATUS_BUFFER_TOO_SMALL; break; }
        g_bind = *(KINPUT_BIND_REQ *)irp->AssociatedIrp.SystemBuffer;
        st = STATUS_SUCCESS;
        info = sizeof(KINPUT_BIND_REQ);
        break;
    }
    case IOCTL_KINPUT_CLASS_SEND: {
        if (in_len < sizeof(KINPUT_CLASS_REQ)) { st = STATUS_BUFFER_TOO_SMALL; break; }
        KINPUT_CLASS_REQ *rq = (KINPUT_CLASS_REQ *)irp->AssociatedIrp.SystemBuffer;
        ULONG need = sizeof(KINPUT_CLASS_REQ) + rq->input_count * rq->input_cb;
        if (rq->input_cb == 0 || in_len < need) { st = STATUS_BUFFER_TOO_SMALL; break; }
        UCHAR *inputs = (UCHAR *)irp->AssociatedIrp.SystemBuffer + sizeof(KINPUT_CLASS_REQ);
        KINPUT_RESP resp;
        st = HandleClassSend(rq, inputs, &resp);
        if (NT_SUCCESS(st)) {
            RtlCopyMemory(irp->AssociatedIrp.SystemBuffer, &resp, sizeof(resp));
            info = sizeof(resp);
        }
        break;
    }
    default:
        st = STATUS_INVALID_DEVICE_REQUEST;
    }

    irp->IoStatus.Status = st;
    irp->IoStatus.Information = info;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return st;
}

static void DriverUnload(PDRIVER_OBJECT drv)
{
    UNREFERENCED_PARAMETER(drv);
    UNICODE_STRING sym;
    RtlInitUnicodeString(&sym, DSHKBR_SYMLINK);
    IoDeleteSymbolicLink(&sym);
    if (g_device) IoDeleteDevice(g_device);
}

NTSTATUS DriverEntry(PDRIVER_OBJECT drv, PUNICODE_STRING reg)
{
    UNREFERENCED_PARAMETER(reg);
    UNICODE_STRING dev_name, sym_name;
    RtlInitUnicodeString(&dev_name, DSHKBR_DEVICE_NAME);
    RtlInitUnicodeString(&sym_name, DSHKBR_SYMLINK);

    NTSTATUS st = IoCreateDevice(drv, 0, &dev_name, FILE_DEVICE_UNKNOWN,
                                 FILE_DEVICE_SECURE_OPEN, FALSE, &g_device);
    if (!NT_SUCCESS(st)) return st;

    st = IoCreateSymbolicLink(&sym_name, &dev_name);
    if (!NT_SUCCESS(st)) { IoDeleteDevice(g_device); return st; }

    drv->MajorFunction[IRP_MJ_DEVICE_CONTROL] = DispatchDeviceControl;
    drv->DriverUnload = DriverUnload;
    g_device->Flags &= ~DO_DEVICE_INITIALIZING;
    return STATUS_SUCCESS;
}