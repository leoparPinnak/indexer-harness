/*++
  win32-kernel-bridge — driver/inject.c

  IOCTL_ME_INJECT_SCANCODE / IOCTL_ME_INJECT_MOUSE — klavye ve fare
  SINIF-SERVİS GERİ ÇAĞIRMA enjeksiyonu.

  Mekanizma (yalnız belgelenmiş IRP sözleşmesi; hook YOK, SSDT/IDT ezme YOK):
    kbdclass/mouclass, kendi sınıf-servis geri çağırmasını IOCTL_INTERNAL_
    KEYBOARD_CONNECT / IOCTL_INTERNAL_MOUSE_CONNECT ile aşağı gönderdiği
    CONNECT_DATA {ClassDeviceObject, ClassService} içinde yayınlar ve
    alıcı (port/hidclass) bu geri çağırmayı donanım KEYBOARD_INPUT_DATA /
    MOUSE_INPUT_DATA aralığıyla çağırır.

  Bizim WDM filtremiz sınıf sürücüsünün hemen ALTINA (IoGetLowerDeviceObject
  + IoAttachDeviceToDeviceStack) takılır; geçen CONNECT_DATA'yı yakalar ve
  sonraki enjeksiyonlarda aynı sözleşmeyi kullanarak donanım GÖRÜNÜMLÜ girdi
  üretir. Girdi böylece Win32k kuyruğunun DIŞINDAN, sınıf kuyruğunun İÇİNDEN
  akar: alt yazılım tarama kodu akışıyla ayırt edilemez.

  Bağlantı yaşam döngüsü: sınıf bağlantısı ilk kez cihaz başlatılırken kurulur;
  filtremiz geç takılırsa ilk CONNECT'i kaçırabilir. Bu durumda IOCTL'ler
  STATUS_DEVICE_NOT_READY döndürür ve UM tarafı (loader/src/inputstack.rs)
  belgelenmiş cfgmgr32 devre dışı/etkin döngüsüyle sınıfın yeniden bağlanmasını
  tetikler; bağlantı sonra yakalanır. Kancalama ya da desen taraması YOKTUR.

  IRQL: enjeksiyon IOCTL yollarında PASSIVE_LEVEL; sınıf-servis geri çağrısı
  DISPATCH_LEVEL çağrı sözleşmesine uygundur.
--*/

#include "me_internal.h"

typedef struct _ME_FILTER_EXT {
    ULONG          Tag;
    PDEVICE_OBJECT Lower;
    PFILE_OBJECT   ClassFile;      /* IoGetDeviceObjectPointer referansı */
    BOOLEAN        IsKeyboard;
} ME_FILTER_EXT;

typedef struct _ME_CLASS_LINK {
    FAST_MUTEX             Lock;
    PDEVICE_OBJECT         ClassDeviceObject;
    PSERVICE_CALLBACK_ROUTINE ClassService;
    BOOLEAN                Captured;
} ME_CLASS_LINK;

static ME_CLASS_LINK g_KeyboardLink;
static ME_CLASS_LINK g_MouseLink;
static PDEVICE_OBJECT g_KeyboardFilter = NULL;
static PDEVICE_OBJECT g_MouseFilter = NULL;

/* --------------------------------------------------------------------------
 * Sınıf bağlantısı yakalama
 * -------------------------------------------------------------------------- */
static void
MeCaptureClassLink(
    _In_ BOOLEAN isKeyboard,
    _In_opt_ PDEVICE_OBJECT classDeviceObject,
    _In_opt_ PSERVICE_CALLBACK_ROUTINE classService)
{
    ME_CLASS_LINK *link = isKeyboard ? &g_KeyboardLink : &g_MouseLink;

    if (classDeviceObject == NULL || classService == NULL) {
        return;
    }

    ExAcquireFastMutex(&link->Lock);
    /* Yeniden bağlanma durumunda en taze bağlantı geçerlidir. */
    link->ClassDeviceObject = classDeviceObject;
    link->ClassService = classService;
    link->Captured = TRUE;
    ExReleaseFastMutex(&link->Lock);
}

static BOOLEAN
MeReadConnectData(
    _In_ PIRP irp,
    _In_ PIO_STACK_LOCATION irpSp,
    _Out_ PCONNECT_DATA connectData)
{
    PVOID buffer;

    RtlZeroMemory(connectData, sizeof(*connectData));

    buffer = irp->AssociatedIrp.SystemBuffer;
    if (buffer == NULL) {
        buffer = irpSp->Parameters.DeviceIoControl.Type3InputBuffer;
    }
    if (buffer == NULL) {
        return FALSE;
    }

    __try {
        *connectData = *(PCONNECT_DATA)buffer;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return FALSE;
    }
    return (connectData->ClassDeviceObject != NULL && connectData->ClassService != NULL);
}

/* --------------------------------------------------------------------------
 * Enjeksiyon çekirdeği
 * -------------------------------------------------------------------------- */
static NTSTATUS
MeEmitInputData(
    _In_ BOOLEAN isKeyboard,
    _In_ PVOID inputStart,
    _In_ ULONG elementSize,
    _In_ ULONG count)
{
    ME_CLASS_LINK *link = isKeyboard ? &g_KeyboardLink : &g_MouseLink;
    PSERVICE_CALLBACK_ROUTINE service;
    PDEVICE_OBJECT classDeviceObject;
    ULONG consumed = 0;

    if (count == 0) {
        return STATUS_INVALID_PARAMETER;
    }

    ExAcquireFastMutex(&link->Lock);
    service = link->Captured ? link->ClassService : NULL;
    classDeviceObject = link->Captured ? link->ClassDeviceObject : NULL;
    ExReleaseFastMutex(&link->Lock);

    if (service == NULL) {
        return STATUS_DEVICE_NOT_READY;   /* sınıf bağlantısı henüz kurulmadı */
    }

    /* Aralığı port sürücüsüyle birebir aynı sözleşmeyle teslim et.
     * Consumed danışmandır; sınıf kuyruğu veriyi kabul etmiş sayılır. */
    service(classDeviceObject,
            inputStart,
            (PVOID)((PUCHAR)inputStart + elementSize * count),
            &consumed);

    return STATUS_SUCCESS;
}

NTSTATUS
MeInjectScancodeIoctl(
    _In_reads_bytes_(inLen) const ME_INJECT_SCANCODE_IN *in,
    _In_ ULONG inLen)
{
    KEYBOARD_INPUT_DATA frames[ME_MAX_SCANCODES];
    ULONG i;

    if (KeGetCurrentIrql() != PASSIVE_LEVEL) {
        return STATUS_INVALID_DEVICE_STATE;
    }
    if (in == NULL || inLen < sizeof(ME_INJECT_SCANCODE_IN)) {
        return STATUS_BUFFER_TOO_SMALL;
    }
    if (in->count == 0 || in->count > ME_MAX_SCANCODES) {
        return STATUS_INVALID_PARAMETER;
    }

    for (i = 0; i < in->count; ++i) {
        USHORT flags = 0;

        /* ME_KEY_* -> KEY_* (belgelenmiş kbdmou bayrak değerleri). */
        if (in->keys[i].flags & ME_KEY_BREAK) { flags |= KEY_BREAK; }
        if (in->keys[i].flags & ME_KEY_E0)    { flags |= KEY_E0; }
        if (in->keys[i].flags & ME_KEY_E1)    { flags |= KEY_E1; }

        RtlZeroMemory(&frames[i], sizeof(frames[i]));
        frames[i].UnitId  = (USHORT)in->unitId;
        frames[i].MakeCode = in->keys[i].makeCode;
        frames[i].Flags   = flags;
    }

    return MeEmitInputData(TRUE, frames, sizeof(KEYBOARD_INPUT_DATA), in->count);
}

NTSTATUS
MeInjectMouseIoctl(
    _In_reads_bytes_(inLen) const ME_INJECT_MOUSE_IN *in,
    _In_ ULONG inLen)
{
    MOUSE_INPUT_DATA frame;

    if (KeGetCurrentIrql() != PASSIVE_LEVEL) {
        return STATUS_INVALID_DEVICE_STATE;
    }
    if (in == NULL || inLen < sizeof(ME_INJECT_MOUSE_IN)) {
        return STATUS_BUFFER_TOO_SMALL;
    }

    RtlZeroMemory(&frame, sizeof(frame));
    frame.UnitId           = in->unitId;
    frame.Flags            = (in->flags & ME_MOUSE_MOVE_ABSOLUTE) ? MOUSE_MOVE_ABSOLUTE
                                                                 : MOUSE_MOVE_RELATIVE;
    frame.ButtonFlags      = in->buttonFlags;
    frame.ButtonData       = in->buttonData;
    frame.LastX            = in->lastX;
    frame.LastY            = in->lastY;
    frame.ExtraInformation = in->extraInformation;

    return MeEmitInputData(FALSE, &frame, sizeof(MOUSE_INPUT_DATA), 1);
}

/* --------------------------------------------------------------------------
 * Filtre ana işlevleri (driver.c yönlendirmesi)
 * -------------------------------------------------------------------------- */
NTSTATUS
MeFilterDispatchInternalDeviceControl(
    _In_ PDEVICE_OBJECT deviceObject,
    _Inout_ PIRP irp)
{
    PIO_STACK_LOCATION irpSp = IoGetCurrentIrpStackLocation(irp);
    ME_FILTER_EXT *ext = (ME_FILTER_EXT *)deviceObject->DeviceExtension;
    CONNECT_DATA connectData;

    if (irpSp->Parameters.DeviceIoControl.IoControlCode == IOCTL_INTERNAL_KEYBOARD_CONNECT ||
        irpSp->Parameters.DeviceIoControl.IoControlCode == IOCTL_INTERNAL_MOUSE_CONNECT) {

        if (MeReadConnectData(irp, irpSp, &connectData)) {
            MeCaptureClassLink(ext->IsKeyboard,
                               connectData.ClassDeviceObject,
                               connectData.ClassService);
        }
    }

    return MeFilterForward(deviceObject, irp);
}

NTSTATUS
MeFilterForward(
    _In_ PDEVICE_OBJECT deviceObject,
    _Inout_ PIRP irp)
{
    ME_FILTER_EXT *ext = (ME_FILTER_EXT *)deviceObject->DeviceExtension;
    PIO_STACK_LOCATION irpSp = IoGetCurrentIrpStackLocation(irp);

    if (ext->Lower == NULL) {
        irp->IoStatus.Status = STATUS_INVALID_DEVICE_STATE;
        irp->IoStatus.Information = 0;
        IoCompleteRequest(irp, IO_NO_INCREMENT);
        return STATUS_INVALID_DEVICE_STATE;
    }

    if (irpSp->MajorFunction == IRP_MJ_POWER) {
        PoStartNextPowerIrp(irp);
    }

    IoSkipCurrentIrpStackLocation(irp);
    return IoCallDriver(ext->Lower, irp);
}

/* --------------------------------------------------------------------------
 * Filtre kurma/sökme
 * -------------------------------------------------------------------------- */
static NTSTATUS
MeAttachClassFilter(
    _In_ PDRIVER_OBJECT driverObject,
    _In_ PCWSTR classDeviceName,
    _In_ ULONG tag,
    _In_ BOOLEAN isKeyboard,
    _Out_ PDEVICE_OBJECT *filterDevice)
{
    NTSTATUS status;
    PFILE_OBJECT classFile = NULL;
    PDEVICE_OBJECT classDevice = NULL;
    PDEVICE_OBJECT lowerDevice = NULL;
    PDEVICE_OBJECT attachedTo = NULL;
    PDEVICE_OBJECT filter = NULL;
    ME_FILTER_EXT *ext;
    UNICODE_STRING name;

    *filterDevice = NULL;
    RtlInitUnicodeString(&name, classDeviceName);

    status = IoGetDeviceObjectPointer(&name, FILE_READ_DATA, &classFile, &classDevice);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    /* Sınıf sürücüsünün bağlandığı cihaz = yığının onun altındaki tepesi. */
    lowerDevice = IoGetLowerDeviceObject(classDevice);
    if (lowerDevice == NULL) {
        ObDereferenceObject(classFile);
        return STATUS_NOT_SUPPORTED;
    }

    status = IoCreateDevice(
        driverObject,
        sizeof(ME_FILTER_EXT),
        NULL,
        classDevice->DeviceType,
        0,
        FALSE,
        &filter);
    if (!NT_SUCCESS(status)) {
        ObDereferenceObject(lowerDevice);
        ObDereferenceObject(classFile);
        return status;
    }

    ext = (ME_FILTER_EXT *)filter->DeviceExtension;
    ext->Tag = tag;
    ext->ClassFile = classFile;   /* kapanışta ObDereferenceObject */
    ext->IsKeyboard = isKeyboard;

    filter->Flags |= (classDevice->Flags & (DO_BUFFERED_IO | DO_DIRECT_IO | DO_POWER_PAGABLE));
    filter->StackSize = lowerDevice->StackSize + 1;

    attachedTo = IoAttachDeviceToDeviceStack(filter, lowerDevice);
    ObDereferenceObject(lowerDevice);
    if (attachedTo == NULL) {
        ObDereferenceObject(classFile);
        IoDeleteDevice(filter);
        return STATUS_NO_SUCH_DEVICE;
    }
    ext->Lower = attachedTo;

    filter->Flags &= ~DO_DEVICE_INITIALIZING;
    *filterDevice = filter;
    return STATUS_SUCCESS;
}

static void
MeDetachClassFilter(
    _In_opt_ PDEVICE_OBJECT filter)
{
    ME_FILTER_EXT *ext;

    if (filter == NULL) {
        return;
    }
    ext = (ME_FILTER_EXT *)filter->DeviceExtension;

    if (ext->Lower != NULL) {
        IoDetachDevice(ext->Lower);
        ext->Lower = NULL;
    }
    if (ext->ClassFile != NULL) {
        ObDereferenceObject(ext->ClassFile);
        ext->ClassFile = NULL;
    }
    IoDeleteDevice(filter);
}

/* --------------------------------------------------------------------------
 * Yaşam döngüsü
 * -------------------------------------------------------------------------- */
NTSTATUS
MeInjectInit(
    _In_ PDRIVER_OBJECT driverObject)
{
    NTSTATUS status;

    ExInitializeFastMutex(&g_KeyboardLink.Lock);
    ExInitializeFastMutex(&g_MouseLink.Lock);

    /* Klavye sınıfı zorunlu; fare sınıfı yoksa enjeksiyon klavyeyle sınırlı. */
    status = MeAttachClassFilter(driverObject, L"\\Device\\KeyboardClass0",
                                 ME_TAG_KBDFILTER, TRUE, &g_KeyboardFilter);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    (void)MeAttachClassFilter(driverObject, L"\\Device\\PointerClass0",
                              ME_TAG_MSFILTER, FALSE, &g_MouseFilter);
    return STATUS_SUCCESS;
}

void
MeInjectShutdown(void)
{
    ME_CLASS_LINK *links[2] = { &g_KeyboardLink, &g_MouseLink };
    ULONG i;

    /* Bağlantıları önce geçersiz kıl: enjeksiyonlar DEVICE_NOT_READY dönsün. */
    for (i = 0; i < 2; ++i) {
        ExAcquireFastMutex(&links[i]->Lock);
        links[i]->Captured = FALSE;
        links[i]->ClassService = NULL;
        links[i]->ClassDeviceObject = NULL;
        ExReleaseFastMutex(&links[i]->Lock);
    }

    MeDetachClassFilter(g_KeyboardFilter);
    g_KeyboardFilter = NULL;
    MeDetachClassFilter(g_MouseFilter);
    g_MouseFilter = NULL;
}