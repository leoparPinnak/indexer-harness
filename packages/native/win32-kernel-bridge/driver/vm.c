/*++
  win32-kernel-bridge — driver/vm.c

  IOCTL_ME_READVM / IOCTL_ME_WRITEVM çekirdeği.

  Kopyalama: ntoskrnl!MmCopyVirtualMemory — çalışma anında MmGetSystemRoutineAddress
  ile çözülür (ithalat tablosuna sabitlenmez, sürüm kilitlenmesi yok).
  EPROCESS = PID -> PsLookupProcessByProcessId (handle AÇILMAZ; dolayısıyla
  PPL dahil hiçbir süreçte handle reddi oluşmaz — T1 sözleşmesi).

  MDL disiplini: METHOD_NEITHER kullanıcı pencereleri IoAllocateMdl +
  MmProbeAndLockPages ile kilitlenir, kopya boyunca açık kalır ve uç noktada
  (başarı/hata farkı olmaksızın) açılır. Kesilmiş transferlerin kayıtları
  GLOBAL kilit listesinde tutulur; unload temizliği (MeVmDrainLockedBuffers)
  bunları mutlaka açar.

  IRQL: yalnız PASSIVE_LEVEL (çağrı yolu IOCTL dispatch).
--*/

#include "me_internal.h"

typedef NTSTATUS (NTAPI *PFN_MM_COPY_VIRTUAL_MEMORY)(
    _In_ PEPROCESS sourceProcess,
    _In_ PVOID sourceAddress,
    _In_ PEPROCESS targetProcess,
    _Out_ PVOID targetAddress,
    _In_ SIZE_T bufferSize,
    _In_ KPROCESSOR_MODE previousMode,
    _Out_ PSIZE_T returnSize);

typedef struct _ME_LOCKED_WINDOW {
    LIST_ENTRY link;
    PMDL       mdl;
    PVOID      userVa;
    SIZE_T     size;
} ME_LOCKED_WINDOW;

static PFN_MM_COPY_VIRTUAL_MEMORY g_MmCopyVirtualMemory = NULL;
static LIST_ENTRY g_LockedWindows;
static FAST_MUTEX g_LockedWindowsLock;
static BOOLEAN g_VmReady = FALSE;

/* --------------------------------------------------------------------------
 * Kilitli pencere kaydı
 * -------------------------------------------------------------------------- */
static NTSTATUS
MeVmLockWindow(
    _In_ PVOID userVa,
    _In_ SIZE_T size,
    _In_ LOCK_OPERATION operation,
    _Out_ ME_LOCKED_WINDOW *window)
{
    PMDL mdl;
    NTSTATUS status;

    RtlZeroMemory(window, sizeof(*window));

    if (userVa == NULL || size == 0) {
        return STATUS_INVALID_PARAMETER;
    }

    mdl = IoAllocateMdl(userVa, (ULONG)size, FALSE, FALSE, NULL);
    if (mdl == NULL) {
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    __try {
        MmProbeAndLockPages(mdl, UserMode, operation);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        status = GetExceptionCode();
        IoFreeMdl(mdl);
        return status;
    }

    window->mdl = mdl;
    window->userVa = userVa;
    window->size = size;

    ExAcquireFastMutex(&g_LockedWindowsLock);
    InsertTailList(&g_LockedWindows, &window->link);
    ExReleaseFastMutex(&g_LockedWindowsLock);

    return STATUS_SUCCESS;
}

static void
MeVmUnlockWindow(
    _In_ ME_LOCKED_WINDOW *window)
{
    ExAcquireFastMutex(&g_LockedWindowsLock);
    RemoveEntryList(&window->link);
    ExReleaseFastMutex(&g_LockedWindowsLock);

    MmUnlockPages(window->mdl);
    IoFreeMdl(window->mdl);
    RtlZeroMemory(window, sizeof(*window));
}

void
MeVmDrainLockedBuffers(void)
{
    for (;;) {
        PLIST_ENTRY entry;
        ME_LOCKED_WINDOW *window;

        ExAcquireFastMutex(&g_LockedWindowsLock);
        if (IsListEmpty(&g_LockedWindows)) {
            ExReleaseFastMutex(&g_LockedWindowsLock);
            break;
        }
        entry = RemoveHeadList(&g_LockedWindows);
        ExReleaseFastMutex(&g_LockedWindowsLock);

        window = CONTAINING_RECORD(entry, ME_LOCKED_WINDOW, link);
        MmUnlockPages(window->mdl);
        IoFreeMdl(window->mdl);
        ExFreePoolWithTag(window, ME_POOL_TAG);
    }
}

/* --------------------------------------------------------------------------
 * Ham kopya (dahili)
 * -------------------------------------------------------------------------- */
NTSTATUS
MeVmRawCopy(
    _In_ PEPROCESS sourceProcess,
    _In_ PVOID sourceVa,
    _In_ PEPROCESS targetProcess,
    _Out_ PVOID targetVa,
    _In_ SIZE_T size,
    _Out_opt_ PSIZE_T transferred)
{
    SIZE_T done = 0;
    NTSTATUS status;

    if (!g_VmReady || g_MmCopyVirtualMemory == NULL) {
        return STATUS_PROCEDURE_NOT_FOUND;
    }

    status = g_MmCopyVirtualMemory(
        sourceProcess,
        sourceVa,
        targetProcess,
        targetVa,
        size,
        KernelMode,     /* pencereler bizim tarafımızdan MDL ile doğrulandı */
        &done);

    if (transferred != NULL) {
        *transferred = done;
    }
    return status;
}

/* --------------------------------------------------------------------------
 * IOCTL gövdesi
 * -------------------------------------------------------------------------- */
NTSTATUS
MeVmTransfer(
    _In_ BOOLEAN writeToRemote,
    _In_ PVOID hdrUser,
    _In_ ULONG hdrLen,
    _In_opt_ PVOID dataUser,
    _In_ ULONG dataLen,
    _Out_ PULONG_PTR transferred)
{
    ME_LOCKED_WINDOW headerWindow = { 0 };
    ME_LOCKED_WINDOW dataWindow = { 0 };
    BOOLEAN headerLocked = FALSE;
    BOOLEAN dataLocked = FALSE;
    ME_RW_IN request;
    PEPROCESS remoteProcess = NULL;
    PEPROCESS callerProcess;
    PVOID headerKernel;
    PVOID dataKernel;
    SIZE_T done = 0;
    NTSTATUS status;

    *transferred = 0;

    if (KeGetCurrentIrql() != PASSIVE_LEVEL) {
        return STATUS_INVALID_DEVICE_STATE;
    }
    if (hdrUser == NULL || hdrLen < sizeof(ME_RW_IN)) {
        return STATUS_BUFFER_TOO_SMALL;
    }
    if (!g_VmReady) {
        return STATUS_PROCEDURE_NOT_FOUND;
    }

    /* Başlık penceresini kilitle ve kopyala. */
    status = MeVmLockWindow(hdrUser, hdrLen, IoReadAccess, &headerWindow);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    headerLocked = TRUE;
    headerKernel = MmGetSystemAddressForMdlSafe(headerWindow.mdl,
                                                NormalPagePriority | MdlMappingNoExecute);
    if (headerKernel == NULL) {
        status = STATUS_INSUFFICIENT_RESOURCES;
        goto Exit;
    }
    RtlCopyMemory(&request, headerKernel, sizeof(request));

    if (request.size == 0 || request.size > ME_MAX_TRANSFER_BYTES ||
        request.size > (me_u64)dataLen) {
        status = STATUS_INVALID_PARAMETER;
        goto Exit;
    }

    if (dataUser == NULL) {
        status = STATUS_INVALID_PARAMETER;
        goto Exit;
    }

    /* Veri penceresini, yöne uygun kilit erişimiyle kilitle. */
    status = MeVmLockWindow(
        dataUser,
        (SIZE_T)request.size,
        writeToRemote ? IoReadAccess : IoWriteAccess,
        &dataWindow);
    if (!NT_SUCCESS(status)) {
        goto Exit;
    }
    dataLocked = TRUE;
    dataKernel = MmGetSystemAddressForMdlSafe(dataWindow.mdl,
                                              NormalPagePriority | MdlMappingNoExecute);
    if (dataKernel == NULL) {
        status = STATUS_INSUFFICIENT_RESOURCES;
        goto Exit;
    }

    /* Hedef süreç: yalnız PID'den; handle yok, erişim hakkı denetimi yok. */
    status = PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)request.pid, &remoteProcess);
    if (!NT_SUCCESS(status)) {
        goto Exit;
    }

    callerProcess = PsGetCurrentProcess();

    if (writeToRemote) {
        status = MeVmRawCopy(callerProcess,
                             dataKernel,
                             remoteProcess,
                             (PVOID)request.address,
                             (SIZE_T)request.size,
                             &done);
    } else {
        status = MeVmRawCopy(remoteProcess,
                             (PVOID)request.address,
                             callerProcess,
                             dataKernel,
                             (SIZE_T)request.size,
                             &done);
    }

    if (done != 0) {
        *transferred = done;
    }

Exit:
    if (remoteProcess != NULL) {
        ObDereferenceObject(remoteProcess);
    }
    if (dataLocked) {
        MeVmUnlockWindow(&dataWindow);
    }
    if (headerLocked) {
        MeVmUnlockWindow(&headerWindow);
    }
    return status;
}

/* --------------------------------------------------------------------------
 * Yaşam döngüsü
 * -------------------------------------------------------------------------- */
NTSTATUS
MeVmInit(void)
{
    UNICODE_STRING routineName = RTL_CONSTANT_STRING(L"MmCopyVirtualMemory");

    InitializeListHead(&g_LockedWindows);
    ExInitializeFastMutex(&g_LockedWindowsLock);

    /* Sürümlenmiş imza yerine dışa aktarım çözümü: ntoskrnl sürümünden bağımsız. */
    g_MmCopyVirtualMemory =
        (PFN_MM_COPY_VIRTUAL_MEMORY)MmGetSystemRoutineAddress(&routineName);
    if (g_MmCopyVirtualMemory == NULL) {
        return STATUS_PROCEDURE_NOT_FOUND;
    }

    g_VmReady = TRUE;
    return STATUS_SUCCESS;
}

void
MeVmShutdown(void)
{
    g_VmReady = FALSE;
    g_MmCopyVirtualMemory = NULL;
    MeVmDrainLockedBuffers();
}