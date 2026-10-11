/*++
  win32-kernel-bridge — driver/driver.c

  WinMemEng çekirdek katmanı: sürücü girişi, güvenli kontrol cihazı,
  IOCTL yönlendirmesi ve unload temizliği.

  Güvenlik kapıları (zorunlu):
    - Kontrol cihazı yalnız SİSTEM + YÖNETİCİ ACL'li
      (IoCreateDeviceSecure + SDDL_DEVOBJ_SYS_ALL_ADM_ALL).
    - Cihaz arabirimi GUID kayıtlıdır (GUID'li device interface).
    - IOCTL işleyicileri yalnız PASSIVE_LEVEL'da çalışır; üst düzeyde
      gelen çağrılar (arayüz dosyasından normalde mümkün değil)
      STATUS_INVALID_DEVICE_STATE ile reddedilir.
    - Unload: notify kaydı kaldırılır, MDL kilitleri açılır, filtre
      cihazları sökülür, sembolik bağlantı/arayüz silinir.
    - Hatalar NTSTATUS'tur; kilitleme ERESOURCE/FAST_MUTEX'tir (spinlock YOK).
--*/

#include "me_internal.h"

DRIVER_INITIALIZE DriverEntry;

_Dispatch_type_(IRP_MJ_CREATE)
_Dispatch_type_(IRP_MJ_CLOSE)
DRIVER_DISPATCH MeDispatchCreateClose;

_Dispatch_type_(IRP_MJ_DEVICE_CONTROL)
DRIVER_DISPATCH MeDispatchDeviceControl;

_Dispatch_type_(IRP_MJ_INTERNAL_DEVICE_CONTROL)
DRIVER_DISPATCH MeDispatchInternalDeviceControl;

_Dispatch_type_(IRP_MJ_PNP)
_Dispatch_type_(IRP_MJ_POWER)
_Dispatch_type_(IRP_MJ_SYSTEM_CONTROL)
DRIVER_DISPATCH MeDispatchForwardOrInvalid;

DRIVER_UNLOAD MeDriverUnload;

static PDEVICE_OBJECT g_ControlDevice = NULL;
static UNICODE_STRING g_InterfaceLink = { 0 };

/* --------------------------------------------------------------------------
 * Kontrol cihazı IOCTL işlemesi (yalnız PASSIVE_LEVEL).
 * -------------------------------------------------------------------------- */
static NTSTATUS
MeHandleControlIoctl(
    _In_ ULONG code,
    _In_ PVOID inBuf,
    _In_ ULONG inLen,
    _Out_opt_ PVOID outBuf,
    _In_ ULONG outLen,
    _Out_ PULONG_PTR information)
{
    *information = 0;

    if (KeGetCurrentIrql() != PASSIVE_LEVEL) {
        return STATUS_INVALID_DEVICE_STATE;
    }

    switch (code) {

    case IOCTL_ME_READVM:
    case IOCTL_ME_WRITEVM: {
        /* METHOD_NEITHER:
         *   READVM : inBuf = ME_RW_IN (Type3InputBuffer), outBuf = veri.
         *   WRITEVM: inBuf = [ME_RW_IN][veri], outBuf = NULL.            */
        BOOLEAN writeToRemote = (code == IOCTL_ME_WRITEVM);
        PVOID dataUser;
        ULONG dataLen;

        if (inBuf == NULL || inLen < sizeof(ME_RW_IN)) {
            return STATUS_BUFFER_TOO_SMALL;
        }

        if (writeToRemote) {
            dataUser = (PVOID)((PUCHAR)inBuf + sizeof(ME_RW_IN));
            dataLen  = (inLen > sizeof(ME_RW_IN)) ? (inLen - (ULONG)sizeof(ME_RW_IN)) : 0;
        } else {
            dataUser = outBuf;
            dataLen  = outLen;
        }

        return MeVmTransfer(writeToRemote, inBuf, (ULONG)sizeof(ME_RW_IN),
                            dataUser, dataLen, information);
    }

    case IOCTL_ME_PROTECT:
        return MeProtectIoctl((const ME_PROTECT_IN *)inBuf, inLen, outBuf, outLen, information);

    case IOCTL_ME_INJECT_SCANCODE:
        return MeInjectScancodeIoctl((const ME_INJECT_SCANCODE_IN *)inBuf, inLen);

    case IOCTL_ME_INJECT_MOUSE:
        return MeInjectMouseIoctl((const ME_INJECT_MOUSE_IN *)inBuf, inLen);

    case IOCTL_ME_PID_OF:
        return MePidOfIoctl((const ME_PID_OF_IN *)inBuf, inLen,
                            (ME_PID_OF_OUT *)outBuf, outLen, information);

    case IOCTL_ME_MODULES:
        return MeModulesIoctl((const ME_MODULES_IN *)inBuf, inLen,
                              (ME_MODULES_OUT *)outBuf, outLen, information);

    default:
        return STATUS_INVALID_DEVICE_REQUEST;
    }
}

/* --------------------------------------------------------------------------
 * Ortak ana işlevler
 * -------------------------------------------------------------------------- */
NTSTATUS
MeDispatchCreateClose(
    _In_ PDEVICE_OBJECT deviceObject,
    _Inout_ PIRP irp)
{
    UNREFERENCED_PARAMETER(deviceObject);
    irp->IoStatus.Status = STATUS_SUCCESS;
    irp->IoStatus.Information = 0;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

NTSTATUS
MeDispatchDeviceControl(
    _In_ PDEVICE_OBJECT deviceObject,
    _Inout_ PIRP irp)
{
    PIO_STACK_LOCATION irpSp = IoGetCurrentIrpStackLocation(irp);
    NTSTATUS status;
    ULONG_PTR information = 0;
    PVOID inBuf;
    PVOID outBuf;
    ULONG inLen;
    ULONG outLen;
    ULONG method;

    if (*(PULONG)deviceObject->DeviceExtension != ME_TAG_CONTROL) {
        /* Filtre cihazlarına kullanıcı IOCTL'si ulaşmaz; yine de güvenli geç. */
        return MeFilterForward(deviceObject, irp);
    }

    inLen  = irpSp->Parameters.DeviceIoControl.InputLength;
    outLen = irpSp->Parameters.DeviceIoControl.OutputLength;
    method = (irpSp->Parameters.DeviceIoControl.IoControlCode >> 2) & 3;

    if (method == ME_METHOD_NEITHER) {
        inBuf  = irpSp->Parameters.DeviceIoControl.Type3InputBuffer;
        outBuf = irp->UserBuffer;
    } else if (method == ME_METHOD_BUFFERED) {
        inBuf  = irp->AssociatedIrp.SystemBuffer;
        outBuf = irp->AssociatedIrp.SystemBuffer;
    } else {
        status = STATUS_INVALID_DEVICE_REQUEST;
        goto Complete;
    }

    status = MeHandleControlIoctl(
        irpSp->Parameters.DeviceIoControl.IoControlCode,
        inBuf,
        inLen,
        outBuf,
        outLen,
        &information);

Complete:
    irp->IoStatus.Status = status;
    irp->IoStatus.Information = NT_SUCCESS(status) ? information : 0;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return status;
}

NTSTATUS
MeDispatchInternalDeviceControl(
    _In_ PDEVICE_OBJECT deviceObject,
    _Inout_ PIRP irp)
{
    ULONG tag = *(PULONG)deviceObject->DeviceExtension;

    if (tag == ME_TAG_KBDFILTER || tag == ME_TAG_MSFILTER) {
        return MeFilterDispatchInternalDeviceControl(deviceObject, irp);
    }

    irp->IoStatus.Status = STATUS_INVALID_DEVICE_REQUEST;
    irp->IoStatus.Information = 0;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_INVALID_DEVICE_REQUEST;
}

NTSTATUS
MeDispatchForwardOrInvalid(
    _In_ PDEVICE_OBJECT deviceObject,
    _Inout_ PIRP irp)
{
    ULONG tag = *(PULONG)deviceObject->DeviceExtension;

    if (tag == ME_TAG_KBDFILTER || tag == ME_TAG_MSFILTER) {
        return MeFilterForward(deviceObject, irp);
    }

    irp->IoStatus.Status = STATUS_INVALID_DEVICE_REQUEST;
    irp->IoStatus.Information = 0;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_INVALID_DEVICE_REQUEST;
}

/* --------------------------------------------------------------------------
 * Alt sistem yaşam döngüsü
 * -------------------------------------------------------------------------- */
NTSTATUS
MeInit(
    _In_ PDRIVER_OBJECT driverObject)
{
    NTSTATUS status;

    status = MeVmInit();
    if (!NT_SUCCESS(status)) {
        return status;
    }

    status = MeProcInfoInit();
    if (!NT_SUCCESS(status)) {
        MeVmShutdown();
        return status;
    }

    status = MeProtectInit();
    if (!NT_SUCCESS(status)) {
        MeProcInfoShutdown();
        MeVmShutdown();
        return status;
    }

    status = MeInjectInit(driverObject);
    if (!NT_SUCCESS(status)) {
        MeProtectShutdown();
        MeProcInfoShutdown();
        MeVmShutdown();
        return status;
    }

    return STATUS_SUCCESS;
}

void
MeShutdown(void)
{
    MeInjectShutdown();
    MeProtectShutdown();
    MeProcInfoShutdown();
    MeVmShutdown();          /* kalan MDL kilitlerini açar */
}

/* --------------------------------------------------------------------------
 * Giriş ve unload
 * -------------------------------------------------------------------------- */
static void
MeDeleteControlDevice(void)
{
    UNICODE_STRING dosName;

    if (g_InterfaceLink.Buffer != NULL) {
        IoUnregisterDeviceInterface(&g_InterfaceLink);
        ExFreePool(g_InterfaceLink.Buffer);
        g_InterfaceLink.Buffer = NULL;
        g_InterfaceLink.Length = 0;
        g_InterfaceLink.MaximumLength = 0;
    }

    if (g_ControlDevice != NULL) {
        RtlInitUnicodeString(&dosName, ME_DOS_DEVICE_NAME);
        IoDeleteSymbolicLink(&dosName);
        IoDeleteDevice(g_ControlDevice);
        g_ControlDevice = NULL;
    }
}

void
MeDriverUnload(
    _In_ PDRIVER_OBJECT driverObject)
{
    UNREFERENCED_PARAMETER(driverObject);

    MeShutdown();          /* inject -> protect -> procinfo -> vm */
    MeDeleteControlDevice();
}

NTSTATUS
DriverEntry(
    _In_ PDRIVER_OBJECT driverObject,
    _In_ PUNICODE_STRING registryPath)
{
    NTSTATUS status;
    UNICODE_STRING ntName;
    UNICODE_STRING dosName;
    UNICODE_STRING sddl;
    UNICODE_STRING interfaceTemplate;
    const GUID interfaceGuid = {
        ME_IFGUID_DATA1,
        ME_IFGUID_DATA2,
        ME_IFGUID_DATA3,
        ME_IFGUID_DATA4_INIT
    };
    ULONG i;

    UNREFERENCED_PARAMETER(registryPath);

    RtlInitUnicodeString(&ntName, ME_NT_DEVICE_NAME);
    RtlInitUnicodeString(&dosName, ME_DOS_DEVICE_NAME);
    RtlInitUnicodeString(&sddl, SDDL_DEVOBJ_SYS_ALL_ADM_ALL);
    RtlInitUnicodeString(&interfaceTemplate, L"WinMemEng");

    driverObject->DriverUnload = MeDriverUnload;
    for (i = 0; i <= IRP_MJ_MAXIMUM_FUNCTION; ++i) {
        driverObject->MajorFunction[i] = MeDispatchForwardOrInvalid;
    }
    driverObject->MajorFunction[IRP_MJ_CREATE]                  = MeDispatchCreateClose;
    driverObject->MajorFunction[IRP_MJ_CLOSE]                   = MeDispatchCreateClose;
    driverObject->MajorFunction[IRP_MJ_DEVICE_CONTROL]          = MeDispatchDeviceControl;
    driverObject->MajorFunction[IRP_MJ_INTERNAL_DEVICE_CONTROL] = MeDispatchInternalDeviceControl;

    /* Yönetici ACL'li kontrol cihazı (yalnız SY + BA tam erişim). */
    status = IoCreateDeviceSecure(
        driverObject,
        sizeof(ULONG),                      /* uzantı = cihaz tipi etiketi */
        &ntName,
        FILE_DEVICE_UNKNOWN,
        FILE_DEVICE_SECURE_OPEN,
        FALSE,
        &sddl,
        &interfaceGuid,
        &g_ControlDevice);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    *(PULONG)g_ControlDevice->DeviceExtension = ME_TAG_CONTROL;

    status = IoCreateSymbolicLink(&dosName, &ntName);
    if (!NT_SUCCESS(status)) {
        MeDeleteControlDevice();
        return status;
    }

    /* GUID'li device interface kaydı (arayüz, yönetici kontrolleri için). */
    status = IoRegisterDeviceInterface(
        g_ControlDevice,
        &interfaceGuid,
        &interfaceTemplate,
        &g_InterfaceLink);
    if (!NT_SUCCESS(status)) {
        MeDeleteControlDevice();
        return status;
    }

    g_ControlDevice->Flags &= ~DO_DEVICE_INITIALIZING;

    /* Alt sistemler: vm (MmCopyVirtualMemory çözümü) -> procinfo (dinamik
     * imza çözücü) -> protect (notify kaydı) -> inject (sınıf filtreleri). */
    status = MeInit(driverObject);
    if (!NT_SUCCESS(status)) {
        MeDeleteControlDevice();
        return status;
    }

    return STATUS_SUCCESS;
}