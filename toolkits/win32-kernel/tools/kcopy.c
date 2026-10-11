// kcopy — MmCopyVirtualMemory ile süreçler arası sanal bellek kopyası.
//
// Katmanlar: IRP_MJ_DEVICE_CONTROL dağıtımı + IOCTL_KCOPY_COPY arabellek
// sözleşmesi. Yönlü tek işlem: direction=1 -> (src_va) kopyalanır (dst_va)'ya,
// direction=0 -> ters yön. Win32 sınır çağrıları yalnız Lookup/Cleanup içinde.
#include <ntddk.h>

#define DSHKBR_DEVICE_NAME L"\\Device\\DshKbr"
#define DSHKBR_SYMLINK     L"\\DosDevices\\DshKbr"

#define IOCTL_KCOPY_COPY CTL_CODE(FILE_DEVICE_UNKNOWN, 0x810, METHOD_BUFFERED, FILE_ANY_ACCESS)

typedef struct _KCOPY_REQUEST {
    UINT32 src_pid;
    UINT32 dst_pid;
    UINT64 src_va;
    UINT64 dst_va;
    UINT64 length;
    UINT32 direction;   // 1: src_va -> dst_va ; 0: dst_va -> src_va
    UINT32 reserved;
} KCOPY_REQUEST;

// ntoskrnl'un dışa aktardığı prototip; WDK başlıklarında yoktur.
NTKERNELAPI NTSTATUS MmCopyVirtualMemory(
    PEPROCESS     SourceProcess,
    PVOID         SourceAddress,
    PEPROCESS     TargetProcess,
    PVOID         TargetAddress,
    SIZE_T        BufferSize,
    KPROCESSOR_MODE PreviousMode,
    PSIZE_T       ReturnSize);

static PDEVICE_OBJECT g_device = NULL;

static NTSTATUS LookupPid(UINT32 pid, PEPROCESS *out)
{
    if (pid == 0) return STATUS_INVALID_PARAMETER;
    return PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)pid, out);
}

static NTSTATUS DoCopy(const KCOPY_REQUEST *rq, PSIZE_T done)
{
    PEPROCESS a = NULL, b = NULL;
    NTSTATUS st = LookupPid(rq->src_pid, &a);
    if (!NT_SUCCESS(st)) return st;

    st = LookupPid(rq->dst_pid, &b);
    if (!NT_SUCCESS(st)) { ObDereferenceObject(a); return st; }

    PEPROCESS src = rq->direction ? a : b;
    PEPROCESS dst = rq->direction ? b : a;
    PVOID     sv  = rq->direction ? (PVOID)rq->src_va : (PVOID)rq->dst_va;
    PVOID     dv  = rq->direction ? (PVOID)rq->dst_va : (PVOID)rq->src_va;

    st = MmCopyVirtualMemory(src, sv, dst, dv, (SIZE_T)rq->length, KernelMode, done);

    ObDereferenceObject(a);
    ObDereferenceObject(b);
    return st;
}

static NTSTATUS DispatchDeviceControl(PDEVICE_OBJECT dev, PIRP irp)
{
    UNREFERENCED_PARAMETER(dev);
    PIO_STACK_LOCATION sp = IoGetCurrentIrpStackLocation(irp);
    NTSTATUS st = STATUS_INVALID_DEVICE_REQUEST;
    ULONG_PTR info = 0;

    if (sp->Parameters.DeviceIoControl.IoControlCode == IOCTL_KCOPY_COPY) {
        if (sp->Parameters.DeviceIoControl.InputBufferLength < sizeof(KCOPY_REQUEST)) {
            st = STATUS_BUFFER_TOO_SMALL;
        } else {
            KCOPY_REQUEST *rq = (KCOPY_REQUEST *)irp->AssociatedIrp.SystemBuffer;
            SIZE_T done = 0;
            st = DoCopy(rq, &done);
            // yanıt: SystemBuffer başına yerlesmis ULONG64 yazilan bayt
            if (irp->AssociatedIrp.SystemBuffer != NULL) {
                *(ULONG64 *)irp->AssociatedIrp.SystemBuffer = (ULONG64)done;
                info = sizeof(ULONG64);
            }
        }
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