// kattach — PID'e çekirdek süreç kolu üretimi + koruma sınıfı yoklaması.
//
// ObOpenObjectByPointer(..., KernelMode, ...) kullanıldığı için kullanıcı
// ACL'leri atlanır; üretilen kol KERNEL koludur, sürücü içi yuvaya yazılır ve
// müşteriye yalnız attach_id döner (kernel kolu kullanıcı modunda kullanılamaz).
// Aynı yuva kolu kullanan diğer araçlar (kapc, kcopy) bu kimliğe başvurur.
#include <ntddk.h>

#define DSHKBR_DEVICE_NAME L"\\Device\\DshKbr"
#define DSHKBR_SYMLINK     L"\\DosDevices\\DshKbr"

#define IOCTL_KATTACH_OPEN  CTL_CODE(FILE_DEVICE_UNKNOWN, 0x820, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_KATTACH_PROBE CTL_CODE(FILE_DEVICE_UNKNOWN, 0x821, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_KATTACH_CLOSE CTL_CODE(FILE_DEVICE_UNKNOWN, 0x822, METHOD_BUFFERED, FILE_ANY_ACCESS)

#define KATT_MAX_SLOTS 32

typedef struct _KATTACH_PID_REQ  { UINT32 pid; UINT32 reserved; } KATTACH_PID_REQ;
typedef struct _KATTACH_CLOSE_REQ { UINT32 attach_id; UINT32 reserved; } KATTACH_CLOSE_REQ;

typedef struct _KATTACH_RESP {
    UINT32 attach_id;   // OPEN'da dolu; PROBE'da 0
    char   klass[32];   // "Normal" | "ProtectedProcessLight" | ...
} KATTACH_RESP;

// WDK dışa aktarımları: ObOpenObjectByPointer nesne tipi ve koruma yoklaması.
extern POBJECT_TYPE *PsProcessType;

typedef struct _PS_PROTECTION {          // bilinen yerleşim (Win8.1+)
    union {
        UCHAR Level;
        struct { UCHAR Type : 3; UCHAR Audit : 1; UCHAR Signer : 4; };
    };
} PS_PROTECTION;
NTKERNELAPI PS_PROTECTION PsGetProcessProtection(PEPROCESS Process);

typedef struct _KATTACH_SLOT {
    PEPROCESS process;
    HANDLE    handle;
} KATTACH_SLOT;

static PDEVICE_OBJECT g_device  = NULL;
static FAST_MUTEX     g_lock;
static KATTACH_SLOT   g_slots[KATT_MAX_SLOTS];   // 0: boş; 1..KATT_MAX_SLOTS: atanmış

// Koruma sınıfı — TargetClass sözleşmesiyle birebir aynı adlandırma.
static void Classify(PEPROCESS proc, char *out, SIZE_T cap)
{
    const char *name;
    if (proc == NULL) {
        name = "Gone";
    } else {
        PS_PROTECTION prot = PsGetProcessProtection(proc);
        switch (prot.Type) {
        case 0:  name = "Normal"; break;                 // PsProtectedTypeNone
        case 1:  name = "ProtectedProcessLight"; break;  // PsProtectedTypeProtectedLight
        case 2:  name = "ProtectedProcess"; break;       // PsProtectedTypeProtected
        default: name = "ProtectedUnknown"; break;
        }
    }
    SIZE_T n = strlen(name) + 1;
    if (n > cap) n = cap;
    RtlCopyMemory(out, name, n);
}

static NTSTATUS SlotAlloc(PEPROCESS process, HANDLE handle, UINT32 *id)
{
    ExAcquireFastMutex(&g_lock);
    for (UINT32 i = 0; i < KATT_MAX_SLOTS; i++) {
        if (g_slots[i].process == NULL && g_slots[i].handle == NULL) {
            g_slots[i].process = process;
            g_slots[i].handle  = handle;
            *id = i + 1;
            ExReleaseFastMutex(&g_lock);
            return STATUS_SUCCESS;
        }
    }
    ExReleaseFastMutex(&g_lock);
    return STATUS_INSUFFICIENT_RESOURCES;
}

static NTSTATUS SlotTake(UINT32 id, KATTACH_SLOT *out)
{
    if (id == 0 || id > KATT_MAX_SLOTS) return STATUS_INVALID_PARAMETER;
    ExAcquireFastMutex(&g_lock);
    KATTACH_SLOT *s = &g_slots[id - 1];
    if (s->process == NULL) { ExReleaseFastMutex(&g_lock); return STATUS_NOT_FOUND; }
    *out = *s;
    s->process = NULL;
    s->handle  = NULL;
    ExReleaseFastMutex(&g_lock);
    return STATUS_SUCCESS;
}

static NTSTATUS HandleOpen(const KATTACH_PID_REQ *rq, KATTACH_RESP *resp)
{
    PEPROCESS proc = NULL;
    NTSTATUS st = PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)rq->pid, &proc);
    Classify(proc, resp->klass, sizeof(resp->klass));
    resp->attach_id = 0;
    if (!NT_SUCCESS(st)) {
        // hedef Gone: yoklama dürüst sınıfla raporlanır, kol açılmaz
        return (st == STATUS_INVALID_PARAMETER) ? STATUS_SUCCESS : st;
    }

    HANDLE handle = NULL;
    st = ObOpenObjectByPointer(proc, OBJ_KERNEL_HANDLE, NULL,
                               PROCESS_ALL_ACCESS, *PsProcessType,
                               KernelMode, &handle);
    if (!NT_SUCCESS(st)) {
        ObDereferenceObject(proc);
        return st;
    }

    UINT32 id = 0;
    st = SlotAlloc(proc, handle, &id);
    if (!NT_SUCCESS(st)) {
        ZwClose(handle);
        ObDereferenceObject(proc);
        return st;
    }
    resp->attach_id = id;
    return STATUS_SUCCESS;
}

static NTSTATUS HandleProbe(const KATTACH_PID_REQ *rq, KATTACH_RESP *resp)
{
    PEPROCESS proc = NULL;
    NTSTATUS st = PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)rq->pid, &proc);
    resp->attach_id = 0;
    if (!NT_SUCCESS(st)) {
        Classify(NULL, resp->klass, sizeof(resp->klass));
        return STATUS_SUCCESS;   // yok: "Gone"
    }
    Classify(proc, resp->klass, sizeof(resp->klass));
    ObDereferenceObject(proc);
    return STATUS_SUCCESS;
}

static NTSTATUS HandleClose(const KATTACH_CLOSE_REQ *rq)
{
    KATTACH_SLOT slot = { 0 };
    NTSTATUS st = SlotTake(rq->attach_id, &slot);
    if (!NT_SUCCESS(st)) return st;
    if (slot.handle)  ZwClose(slot.handle);
    if (slot.process) ObDereferenceObject(slot.process);
    return STATUS_SUCCESS;
}

// Diğer araç katmanları (kapc) için yuva erişimi — aynı sürücü derlemesinde paylaşılan sözleşmesi.
NTSTATUS KattachSlotReference(UINT32 attach_id, PEPROCESS *process, HANDLE *handle)
{
    KATTACH_SLOT slot = { 0 };
    NTSTATUS st = SlotTake(attach_id, &slot);
    if (!NT_SUCCESS(st)) return st;
    *process = slot.process;   // taşıyıcı: çağıran ObDereferenceObject/SlotRelease eder
    *handle  = slot.handle;
    return STATUS_SUCCESS;
}

static NTSTATUS DispatchDeviceControl(PDEVICE_OBJECT dev, PIRP irp)
{
    UNREFERENCED_PARAMETER(dev);
    PIO_STACK_LOCATION sp = IoGetCurrentIrpStackLocation(irp);
    NTSTATUS st = STATUS_INVALID_DEVICE_REQUEST;
    ULONG_PTR info = 0;
    ULONG in_len = sp->Parameters.DeviceIoControl.InputBufferLength;
    KATTACH_RESP *resp = (KATTACH_RESP *)irp->AssociatedIrp.SystemBuffer;

    switch (sp->Parameters.DeviceIoControl.IoControlCode) {
    case IOCTL_KATTACH_OPEN:
        if (in_len < sizeof(KATTACH_PID_REQ)) { st = STATUS_BUFFER_TOO_SMALL; break; }
        st = HandleOpen((KATTACH_PID_REQ *)irp->AssociatedIrp.SystemBuffer, resp);
        if (NT_SUCCESS(st)) info = sizeof(KATTACH_RESP);
        break;
    case IOCTL_KATTACH_PROBE:
        if (in_len < sizeof(KATTACH_PID_REQ)) { st = STATUS_BUFFER_TOO_SMALL; break; }
        st = HandleProbe((KATTACH_PID_REQ *)irp->AssociatedIrp.SystemBuffer, resp);
        if (NT_SUCCESS(st)) info = sizeof(KATTACH_RESP);
        break;
    case IOCTL_KATTACH_CLOSE:
        if (in_len < sizeof(KATTACH_CLOSE_REQ)) { st = STATUS_BUFFER_TOO_SMALL; break; }
        st = HandleClose((KATTACH_CLOSE_REQ *)irp->AssociatedIrp.SystemBuffer);
        break;
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
    for (UINT32 i = 0; i < KATT_MAX_SLOTS; i++) {
        if (g_slots[i].handle)  ZwClose(g_slots[i].handle);
        if (g_slots[i].process) ObDereferenceObject(g_slots[i].process);
        g_slots[i].process = NULL;
        g_slots[i].handle  = NULL;
    }
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

    ExInitializeFastMutex(&g_lock);
    RtlZeroMemory(g_slots, sizeof(g_slots));

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