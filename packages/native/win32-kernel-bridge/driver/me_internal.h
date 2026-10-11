/*++
  win32-kernel-bridge — driver/me_internal.h

  Sürücü içi sözleşmeler: alt sistem yaşam döngüsü, kalıcı durum ve
  dinamik olarak çözülen ntoskrnl dışa aktarımlarının tipleri.

  Tasarım kararı (KMDF/WDM): bu sürücü sc create / NtLoadDriver ile
  YÜKLENEN (non-PnP) bir legacy sürücüdür ve ayrıca kbdclass/mouclass
  yığına WDM filtre cihaz nesneleriyle katılır. İki gereksinim bir arada
  yalnız WDM cihaz nesneleriyle karşılanabilir (KMDF'in yabancı bir
  yığına takılacak non-PnP filtre cihazı için ekleme noktası yoktur),
  bu yüzden çekirdek saf WDM + wdmsec ile yazılmıştır; IOCTL yüzeyi
  sözleşmesi değişmez.

  Kilit disiplini:
    - protect.c olay/liste durumu  : ERESOURCE (PASSIVE_LEVEL bildirim geri
      çağrısıyla güvenli; spinlock YOK).
    - vm.c MDL kilit listesi       : FAST_MUTEX (yalnız IOCTL yolları).
  Hatalar her zaman NTSTATUS ile raporlanır.
--*/

#ifndef WINMEMENG_DRIVER_ME_INTERNAL_H
#define WINMEMENG_DRIVER_ME_INTERNAL_H

#include <ntddk.h>
#include <wdmsec.h>
#include <ntddkbd.h>
#include <ntddmou.h>

#include "../shared/me_ioctl.h"

#define ME_POOL_TAG         'gnEM'      /* 'MEng' ters sıralı havuz etiketi */

/* Cihaz tipi etiketleri (ortak uzatılmış cihaz nesnesi ayracı) */
#define ME_TAG_CONTROL      0x434E4D45u /* 'EMNC' kontrol cihazı        */
#define ME_TAG_KBDFILTER    0x4B464D45u /* 'EMFK' klavye sınıf filtresi */
#define ME_TAG_MSFILTER     0x4D464D45u /* 'EMFM' fare sınıf filtresi   */

/* --------------------------------------------------------------------------
 * Alt sistem yaşam döngüsü — driver.c sırayla çağırır; yalnız PASSIVE_LEVEL.
 * -------------------------------------------------------------------------- */
NTSTATUS MeInit(_In_ PDRIVER_OBJECT driverObject);  /* vm -> procinfo -> protect -> inject */
void     MeShutdown(void);  /* ters sırada; bekleyen MDL'leri ve kayıt
                               listelerini serbest bırakır           */

/* --------------------------------------------------------------------------
 * vm.c — MmCopyVirtualMemory tabanlı süreçler arası kopyalama
 * -------------------------------------------------------------------------- */

/* Dışa aktarım çözücü: ntoskrnl!MmCopyVirtualMemory çalışma anında bulunur
 * (başlıkta deklare edilmez; import tablosuna sabitlenmez). */
NTSTATUS MeVmInit(void);
void     MeVmShutdown(void);

/* METHOD_NEITHER yolu: hdrUser = ME_RW_IN, dataUser = veri penceresi.
 * writeToRemote = TRUE ise veri istemciden uzak süreçte yazılır (WRITEVM),
 * FALSE ise uzak süreçten okunup istemciye yazılır (READVM). */
NTSTATUS MeVmTransfer(
    _In_ BOOLEAN  writeToRemote,
    _In_ PVOID    hdrUser,
    _In_ ULONG    hdrLen,
    _In_opt_ PVOID dataUser,
    _In_ ULONG    dataLen,
    _Out_ PULONG_PTR transferred);

/* Dahili ham kopya (procinfo.c PEB okumaları için). PreviousMode=KernelMode;
 * tüm adresler ya çekirdek VA ya da ilgili sürecin uzayındaki VA'dır. */
NTSTATUS MeVmRawCopy(
    _In_ PEPROCESS sourceProcess,
    _In_ PVOID     sourceVa,
    _In_ PEPROCESS targetProcess,
    _Out_ PVOID    targetVa,
    _In_ SIZE_T    size,
    _Out_opt_ PSIZE_T transferred);

/* Unload temizliği: yol yarıda kesilmişse kilitli kalmış MDL kayıtlarını
 * açar (MmUnlockPages + IoFreeMdl) ve listeyi boşaltır. */
void MeVmDrainLockedBuffers(void);

/* --------------------------------------------------------------------------
 * protect.c — PsSetCreateProcessNotifyRoutineEx izleme kaydı
 * -------------------------------------------------------------------------- */
NTSTATUS MeProtectInit(void);
void     MeProtectShutdown(void);   /* notify kaldırır, kuyruğu boşaltır */
NTSTATUS MeProtectIoctl(
    _In_reads_bytes_(inLen) const ME_PROTECT_IN *in,
    _In_ ULONG inLen,
    _Out_writes_bytes_opt_(outLen) PVOID outBuf,
    _In_ ULONG outLen,
    _Out_ PULONG_PTR information);

/* --------------------------------------------------------------------------
 * inject.c — klavye/fare sınıf-servis geri çağırma enjeksiyonu
 * -------------------------------------------------------------------------- */
NTSTATUS MeInjectInit(_In_ PDRIVER_OBJECT driverObject);
void     MeInjectShutdown(void);    /* filtreleri ayırır, bağlantıları sıfırlar */
NTSTATUS MeInjectScancodeIoctl(
    _In_reads_bytes_(inLen) const ME_INJECT_SCANCODE_IN *in,
    _In_ ULONG inLen);
NTSTATUS MeInjectMouseIoctl(
    _In_reads_bytes_(inLen) const ME_INJECT_MOUSE_IN *in,
    _In_ ULONG inLen);

/* WDM filtre cihazlarının ortak ana işlevleri (driver.c yönlendirir). */
NTSTATUS MeFilterDispatchInternalDeviceControl(PDEVICE_OBJECT deviceObject, PIRP irp);
NTSTATUS MeFilterForward(PDEVICE_OBJECT deviceObject, PIRP irp);

/* --------------------------------------------------------------------------
 * procinfo.c — dinamik imza çözücü + PID_OF + MODULES
 * -------------------------------------------------------------------------- */
NTSTATUS MeProcInfoInit(void);
void     MeProcInfoShutdown(void);
NTSTATUS MePidOfIoctl(
    _In_reads_bytes_(inLen) const ME_PID_OF_IN *in,
    _In_ ULONG inLen,
    _Out_writes_bytes_opt_(outLen) ME_PID_OF_OUT *out,
    _In_ ULONG outLen,
    _Out_ PULONG_PTR information);
NTSTATUS MeModulesIoctl(
    _In_reads_bytes_(inLen) const ME_MODULES_IN *in,
    _In_ ULONG inLen,
    _Out_writes_bytes_opt_(outLen) ME_MODULES_OUT *out,
    _In_ ULONG outLen,
    _Out_ PULONG_PTR information);

#endif /* WINMEMENG_DRIVER_ME_INTERNAL_H */