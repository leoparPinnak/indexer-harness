/*++
  win32-kernel-bridge — driver/procinfo.c

  IOCTL_ME_PID_OF / IOCTL_ME_MODULES + dinamik imza çözücü.

  Versiyon bağımlılığı YOK: EPROCESS alan dolguları (UniqueProcessId,
  ActiveProcessLinks, ImageFileName) her sürümde aşağıdaki yordamla
  ÇALIŞMA ANINDA bulunur — PDB indirilmez, sürüm yaması üretilmez:
    1. "sızıntı": ithal edilen PsLookupProcessByProcessId adresi ntoskrnl
       içindeki bir koddur; sayfa geriye taranıp MZ/PE doğrulanarak
       ntoskrnl tabanı ve boyutu elde edilir (bu taban MODULES çıktısına
       dinamik ntoskrnl girişi olarak da girer).
    2. "bilinen desen taraması": SYSTEM süreç gövdesinde (PsLookupProcessBy
       ProcessId ile) önce UniqueProcessId==4 + bitişik, kendisiyle tutarlı
       bir LIST_ENTRY (ActiveProcessLinks) çifti doğrulanır (yürüyüşte en az
       16 süreç gezilmeli), sonra 15 baytlık "System\0" kalıbıyla
       ImageFileName dolgusu bulunur ve ikinci süreç adıyla çapraz doğrulanır.

  MODULES için ayrıca belgelenmiş/çıkışlı ntoskrnl rutinleri (çalışma anında
  MmGetSystemRoutineAddress ile çözülür) kullanılır: PsGetProcessPeb ve
  PsGetProcessSectionBaseAddress. Modül zinciri, kararlı x64 ntdll düzenine
  göre PEB -> PEB_LDR_DATA -> InMemoryOrderModuleList üzerinden süreçler
  arası kopyalama (MeVmRawCopy) ile okunur.

  IRQL: yalnız PASSIVE_LEVEL. Süreç listesi yürürken düğüm tutarlılık
  denetimleri (__try/__except + çift yönlü bağ doğrulaması) yapılır;
  çıkış yapan süreçlerin düğümleri zarifçe atlanır.
--*/

#include "me_internal.h"

typedef NTSTATUS (NTAPI *PFN_PS_GET_PROCESS_PEB)(_In_ PEPROCESS process);
typedef PVOID (NTAPI *PFN_PS_GET_PROCESS_SECTION_BASE_ADDRESS)(_In_ PEPROCESS process);

/* x64 kararlı kullanıcı düzeni (ntdll halka açık düzeni). */
#define ME_OFF_PEB_LDR              0x18u
#define ME_OFF_LDR_INMEMORY         0x20u
#define ME_OFF_LDRENTRY_LINKS       0x10u
#define ME_OFF_LDRENTRY_DLLBASE     0x30u
#define ME_OFF_LDRENTRY_IMAGESIZE   0x40u
#define ME_OFF_LDRENTRY_BASEDLLNAME 0x58u   /* UNICODE_STRING {USHORT,USHORT,PVOID} */
#define ME_SCAN_LOW                 0x080u
#define ME_SCAN_HIGH                0x0A00u
#define ME_EPROCESS_SPAN            0x0C00u
#define ME_MIN_PROCESSES_SEEN       16u
#define ME_MAX_LIST_WALK            4096u

static PFN_PS_GET_PROCESS_PEB g_PsGetProcessPeb = NULL;
static PFN_PS_GET_PROCESS_SECTION_BASE_ADDRESS g_PsGetProcessSectionBaseAddress = NULL;

static PVOID  g_NtosBase = NULL;
static ULONG  g_NtosSize = 0;
static SIZE_T g_OffPid = (SIZE_T)-1;
static SIZE_T g_OffLinks = (SIZE_T)-1;
static SIZE_T g_OffName = (SIZE_T)-1;
static BOOLEAN g_Resolved = FALSE;

/* --------------------------------------------------------------------------
 * 1) "sızıntı" -> ntoskrnl tabanı
 * -------------------------------------------------------------------------- */
static NTSTATUS
MeResolveNtosBase(void)
{
    ULONG_PTR leaked = (ULONG_PTR)&PsLookupProcessByProcessId;
    ULONG_PTR base;
    ULONG_PTR floor = leaked - 0x20000000u;   /* 512 MiB azami geriye tarama */

    for (base = leaked & ~(ULONG_PTR)0xFFF; base > floor; base -= 0x1000) {
        PUCHAR p = (PUCHAR)base;
        ULONG e_lfanew;
        USHORT machine;

        __try {
            if (p[0] != 'M' || p[1] != 'Z') {
                continue;
            }
            e_lfanew = *(ULONG *)(p + 0x3C);
            if (e_lfanew < 0x40 || e_lfanew > 0x400) {
                continue;
            }
            if (*(ULONG *)(p + e_lfanew) != 0x00004550u) {   /* 'PE\0\0' */
                continue;
            }
            machine = *(USHORT *)(p + e_lfanew + 4);
            if (machine != 0x8664) {
                continue;
            }
            g_NtosSize = *(ULONG *)(p + e_lfanew + 0x50);    /* SizeOfImage */
            if (g_NtosSize < 0x10000 || g_NtosSize > 0x4000000) {
                continue;
            }
            /* Sızan işaretçi görüntü içinde kalmalı — güçlü doğrulama. */
            if (leaked >= base && leaked < base + g_NtosSize) {
                g_NtosBase = (PVOID)base;
                return STATUS_SUCCESS;
            }
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            break;
        }
    }
    return STATUS_NOT_FOUND;
}

/* --------------------------------------------------------------------------
 * 2) "bilinen desen taraması" -> EPROCESS alan dolguları
 * -------------------------------------------------------------------------- */
static BOOLEAN
MeIsPrintableNameAt(
    _In_ PUCHAR body,
    _In_ SIZE_T offset)
{
    ULONG i;
    for (i = 0; i < 15; ++i) {
        UCHAR c = body[offset + i];
        if (c == 0) {
            return i > 0;
        }
        if (c < 0x20 || c > 0x7E) {
            return FALSE;
        }
    }
    return TRUE;
}

static BOOLEAN
MeValidateLinksWalk(
    _In_ PUCHAR systemEprocess,
    _In_ SIZE_T linksOffset,
    _In_ SIZE_T pidOffset,
    _Out_ PULONG processesSeen)
{
    LIST_ENTRY *head = (LIST_ENTRY *)(systemEprocess + linksOffset);
    PLIST_ENTRY node;
    ULONG seen = 1;   /* başlangıçta SYSTEM */

    *processesSeen = 0;

    __try {
        if (head->Flink->Blink != head || head->Blink->Flink != head) {
            return FALSE;
        }
        for (node = head->Flink; node != head; node = node->Flink) {
            PUCHAR proc = (PUCHAR)node - linksOffset;
            ULONGLONG pidValue;

            if (++seen > ME_MAX_LIST_WALK) {
                return FALSE;
            }
            if (node->Flink->Blink != node || node->Blink->Flink != node) {
                return FALSE;
            }
            pidValue = *(ULONGLONG *)(proc + pidOffset);
            if (pidValue == 0 || pidValue > 0x40000000ull) {
                return FALSE;
            }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return FALSE;
    }

    *processesSeen = seen;
    return (seen >= ME_MIN_PROCESSES_SEEN);
}

static NTSTATUS
MeResolveEprocessOffsets(void)
{
    NTSTATUS status;
    PEPROCESS systemProcess = NULL;
    PUCHAR body;
    SIZE_T pidOff, linksOff, nameOff;

    status = PsLookupProcessByProcessId((HANDLE)4, &systemProcess);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    body = (PUCHAR)systemProcess;

    /* ActiveProcessLinks + UniqueProcessId: SYSTEM PID'si 4'tür ve
     * doğrudan ardından gelen kendisiyle tutarlı LIST_ENTRY çifti
     * yürüyüşle doğrulanır. */
    for (pidOff = ME_SCAN_LOW; pidOff + 8 <= ME_SCAN_HIGH; pidOff += 8) {
        ULONG seen = 0;
        __try {
            if (*(ULONGLONG *)(body + pidOff) != 4) {
                continue;
            }
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            break;
        }
        for (linksOff = pidOff + 8; linksOff <= pidOff + 16; linksOff += 8) {
            if (MeValidateLinksWalk(body, linksOff, pidOff, &seen)) {
                g_OffPid = pidOff;
                g_OffLinks = linksOff;
                break;
            }
        }
        if (g_OffPid != (SIZE_T)-1) {
            break;
        }
    }

    /* ImageFileName: 15 baytlık "System\0" kalıbı + sıfır dolgu. */
    for (nameOff = ME_SCAN_LOW; nameOff + 16 <= ME_EPROCESS_SPAN; ++nameOff) {
        __try {
            if (body[nameOff] == 'S' && body[nameOff + 1] == 'y' &&
                body[nameOff + 2] == 's' && body[nameOff + 3] == 't' &&
                body[nameOff + 4] == 'e' && body[nameOff + 5] == 'm' &&
                body[nameOff + 6] == 0 && body[nameOff + 7] == 0 &&
                body[nameOff + 8] == 0 && body[nameOff + 9] == 0 &&
                body[nameOff + 10] == 0 && body[nameOff + 11] == 0 &&
                body[nameOff + 12] == 0 && body[nameOff + 13] == 0 &&
                body[nameOff + 14] == 0) {
                g_OffName = nameOff;
                break;
            }
        } __except (EXCEPTION_EXECUTE_HANDLER) {
            break;
        }
    }

    ObDereferenceObject(systemProcess);

    if (g_OffPid == (SIZE_T)-1 || g_OffLinks == (SIZE_T)-1 || g_OffName == (SIZE_T)-1) {
        g_OffPid = g_OffLinks = g_OffName = (SIZE_T)-1;
        return STATUS_NOT_FOUND;
    }

    /* Çapraz doğrulama: ikinci listedeki süreç adı "System" olmamalı ve
     * yazdırılabilir görünmeli. */
    if (g_NtosBase != NULL) {
        status = PsLookupProcessByProcessId((HANDLE)4, &systemProcess);
        if (NT_SUCCESS(status)) {
            __try {
                LIST_ENTRY *head = (LIST_ENTRY *)((PUCHAR)systemProcess + g_OffLinks);
                PUCHAR second = (PUCHAR)head->Flink - g_OffLinks;
                if (MeIsPrintableNameAt(second, g_OffName)) {
                    g_Resolved = TRUE;
                }
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                g_Resolved = FALSE;
            }
            ObDereferenceObject(systemProcess);
        }
    }

    return g_Resolved ? STATUS_SUCCESS : STATUS_NOT_FOUND;
}

/* --------------------------------------------------------------------------
 * Yürüyüş yardımcıları
 * -------------------------------------------------------------------------- */
static void
MeCopyProcessName(
    _In_ PUCHAR proc,
    _Out_writes_(ME_IMAGE_NAME_CHARS) me_u16 *name)
{
    ULONG i;
    RtlZeroMemory(name, ME_IMAGE_NAME_CHARS * sizeof(me_u16));
    __try {
        for (i = 0; i < 15; ++i) {
            UCHAR c = proc[g_OffName + i];
            if (c == 0) {
                break;
            }
            name[i] = (me_u16)c;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        RtlZeroMemory(name, ME_IMAGE_NAME_CHARS * sizeof(me_u16));
    }
}

static BOOLEAN
MeUpcaseNameMatches(
    _In_reads_(ME_IMAGE_NAME_CHARS) const me_u16 *requested,
    _In_reads_(ME_IMAGE_NAME_CHARS) const me_u16 *actual)
{
    ULONG i;
    for (i = 0; i < ME_IMAGE_NAME_CHARS; ++i) {
        WCHAR a = RtlUpcaseUnicodeChar((WCHAR)requested[i]);
        WCHAR b = RtlUpcaseUnicodeChar((WCHAR)actual[i]);
        if (a != b) {
            return FALSE;
        }
        if (a == L'\0') {
            return TRUE;
        }
    }
    return TRUE;
}

/* --------------------------------------------------------------------------
 * IOCTL_ME_PID_OF
 * -------------------------------------------------------------------------- */
NTSTATUS
MePidOfIoctl(
    _In_reads_bytes_(inLen) const ME_PID_OF_IN *in,
    _In_ ULONG inLen,
    _Out_writes_bytes_opt_(outLen) ME_PID_OF_OUT *out,
    _In_ ULONG outLen,
    _Out_ PULONG_PTR information)
{
    NTSTATUS status;
    PEPROCESS systemProcess = NULL;
    LIST_ENTRY *head;
    PLIST_ENTRY node;
    ULONG steps = 0;

    *information = 0;

    if (KeGetCurrentIrql() != PASSIVE_LEVEL) {
        return STATUS_INVALID_DEVICE_STATE;
    }
    if (in == NULL || inLen < sizeof(ME_PID_OF_IN) ||
        out == NULL || outLen < sizeof(ME_PID_OF_OUT)) {
        return STATUS_BUFFER_TOO_SMALL;
    }
    if (!g_Resolved) {
        return STATUS_DEVICE_NOT_READY;
    }

    status = PsLookupProcessByProcessId((HANDLE)4, &systemProcess);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    out->count = 0;
    out->reserved = 0;
    head = (LIST_ENTRY *)((PUCHAR)systemProcess + g_OffLinks);

    __try {
        for (node = head->Flink; node != head && out->count < ME_MAX_PROCESS_RESULTS;
             node = node->Flink) {
            PUCHAR proc = (PUCHAR)node - g_OffLinks;
            me_u16 actual[ME_IMAGE_NAME_CHARS];

            if (++steps > ME_MAX_LIST_WALK) {
                break;
            }
            if (node->Flink->Blink != node || node->Blink->Flink != node) {
                continue;
            }

            MeCopyProcessName(proc, actual);
            if (MeUpcaseNameMatches(in->imageName, actual)) {
                PEPROCESS process;
                ULONGLONG pidValue = *(ULONGLONG *)(proc + g_OffPid);

                out->entries[out->count].pid = pidValue;
                out->entries[out->count].imageBase = 0;
                if (NT_SUCCESS(PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)pidValue,
                                                          &process))) {
                    if (g_PsGetProcessSectionBaseAddress != NULL) {
                        out->entries[out->count].imageBase =
                            (me_u64)(ULONG_PTR)g_PsGetProcessSectionBaseAddress(process);
                    }
                    ObDereferenceObject(process);
                }
                ++out->count;
            }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        ObDereferenceObject(systemProcess);
        return GetExceptionCode();
    }

    ObDereferenceObject(systemProcess);
    *information = sizeof(me_u32) * 2 + out->count * (ULONG)sizeof(ME_PID_ENTRY);
    return STATUS_SUCCESS;
}

/* --------------------------------------------------------------------------
 * IOCTL_ME_MODULES — PEB -> Ldr InMemoryOrderModuleList
 * -------------------------------------------------------------------------- */
static NTSTATUS
MeReadRemote(
    _In_ PEPROCESS process,
    _In_ ULONG64 remoteVa,
    _Out_writes_bytes_(size) PVOID local,
    _In_ SIZE_T size)
{
    SIZE_T done = 0;
    NTSTATUS status;

    if (remoteVa == 0) {
        return STATUS_INVALID_ADDRESS;
    }
    status = MeVmRawCopy(process, (PVOID)(ULONG_PTR)remoteVa,
                         PsGetCurrentProcess(), local, size, &done);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    return (done == size) ? STATUS_SUCCESS : STATUS_PARTIAL_COPY;
}

NTSTATUS
MeModulesIoctl(
    _In_reads_bytes_(inLen) const ME_MODULES_IN *in,
    _In_ ULONG inLen,
    _Out_writes_bytes_opt_(outLen) ME_MODULES_OUT *out,
    _In_ ULONG outLen,
    _Out_ PULONG_PTR information)
{
    NTSTATUS status;
    PEPROCESS process = NULL;
    ULONG64 peb = 0;
    ULONG64 ldr = 0;
    ULONG64 listHead;
    ULONG64 node;
    ULONG steps = 0;
    UCHAR ldrPrefix[0x28];
    me_u16 ntosName[ME_MODULE_NAME_CHARS];

    *information = 0;

    if (KeGetCurrentIrql() != PASSIVE_LEVEL) {
        return STATUS_INVALID_DEVICE_STATE;
    }
    if (in == NULL || inLen < sizeof(ME_MODULES_IN) ||
        out == NULL || outLen < sizeof(ME_MODULES_OUT)) {
        return STATUS_BUFFER_TOO_SMALL;
    }

    status = PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)in->pid, &process);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    out->count = 0;
    out->ntosIndex = 0xFFFFFFFFu;

    __try {
        if (g_PsGetProcessPeb != NULL) {
            peb = (ULONG64)(ULONG_PTR)g_PsGetProcessPeb(process);
        }
        if (peb == 0) {
            status = STATUS_NOT_SUPPORTED;   /* sistem/64-bit-uzak süreç vb. */
            goto Exit;
        }

        status = MeReadRemote(process, peb + ME_OFF_PEB_LDR, &ldr, sizeof(ldr));
        if (!NT_SUCCESS(status)) {
            goto Exit;
        }
        status = MeReadRemote(process, ldr + ME_OFF_LDR_INMEMORY, ldrPrefix, sizeof(ldrPrefix));
        if (!NT_SUCCESS(status)) {
            goto Exit;
        }
        listHead = ldr + ME_OFF_LDR_INMEMORY;

        for (node = *(ULONG64 *)ldrPrefix;   /* head->Flink */
             node != listHead && out->count < ME_MAX_MODULES - 1;
             ) {
            UCHAR entryHead[0x70];
            ULONG64 entryBase = node - ME_OFF_LDRENTRY_LINKS;
            ULONG64 dllBase;
            ULONG64 imageSize;
            UNICODE_STRING baseName;
            me_u16 nameCopy[ME_MODULE_NAME_CHARS];

            if (++steps > ME_MAX_LIST_WALK) {
                break;
            }

            status = MeReadRemote(process, entryBase, entryHead, sizeof(entryHead));
            if (!NT_SUCCESS(status)) {
                break;
            }

            dllBase   = *(ULONG64 *)(entryHead + ME_OFF_LDRENTRY_DLLBASE);
            imageSize = *(ULONG64 *)(entryHead + ME_OFF_LDRENTRY_IMAGESIZE);
            baseName.Length        = *(USHORT *)(entryHead + ME_OFF_LDRENTRY_BASEDLLNAME);
            baseName.MaximumLength = *(USHORT *)(entryHead + ME_OFF_LDRENTRY_BASEDLLNAME + 2);
            baseName.Buffer        = *(PWSTR *)(entryHead + ME_OFF_LDRENTRY_BASEDLLNAME + 8);

            if (dllBase != 0 && baseName.Length != 0 &&
                baseName.Length < ME_MODULE_NAME_CHARS * sizeof(WCHAR)) {
                RtlZeroMemory(nameCopy, sizeof(nameCopy));
                status = MeReadRemote(process,
                                      (ULONG64)(ULONG_PTR)baseName.Buffer,
                                      nameCopy,
                                      baseName.Length);
                if (NT_SUCCESS(status)) {
                    ME_MODULE_ENTRY *slot = &out->entries[out->count];
                    RtlZeroMemory(slot, sizeof(*slot));
                    slot->imageBase = dllBase;
                    slot->imageSize = imageSize;
                    RtlCopyMemory(slot->name, nameCopy, baseName.Length);
                    ++out->count;
                }
            }

            node = *(ULONG64 *)(entryHead + ME_OFF_LDRENTRY_LINKS);   /* Flink (liste içi) */
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        status = GetExceptionCode();
        goto Exit;
    }

    status = STATUS_SUCCESS;

    /* Dinamik çözülmüş ntoskrnl tabanı dizi sonuna tek giriş olarak girer. */
    if (g_NtosBase != NULL && out->count < ME_MAX_MODULES) {
        ME_MODULE_ENTRY *slot = &out->entries[out->count];
        ULONG i;

        RtlZeroMemory(slot, sizeof(*slot));
        slot->imageBase = (me_u64)(ULONG_PTR)g_NtosBase;
        slot->imageSize = g_NtosSize;
        slot->isNtoskrnl = 1;
        RtlZeroMemory(ntosName, sizeof(ntosName));
        {
            const WCHAR *literal = L"ntoskrnl.exe";
            for (i = 0; literal[i] != L'\0' && i < ME_MODULE_NAME_CHARS - 1; ++i) {
                ntosName[i] = (me_u16)literal[i];
            }
        }
        RtlCopyMemory(slot->name, ntosName, sizeof(ntosName));
        out->ntosIndex = out->count;
        ++out->count;
    }

    *information = sizeof(me_u32) * 2 + out->count * (ULONG)sizeof(ME_MODULE_ENTRY);

Exit:
    ObDereferenceObject(process);
    return status;
}

/* --------------------------------------------------------------------------
 * Yaşam döngüsü
 * -------------------------------------------------------------------------- */
NTSTATUS
MeProcInfoInit(void)
{
    UNICODE_STRING name;
    NTSTATUS status;

    RtlInitUnicodeString(&name, L"PsGetProcessPeb");
    g_PsGetProcessPeb = (PFN_PS_GET_PROCESS_PEB)MmGetSystemRoutineAddress(&name);
    RtlInitUnicodeString(&name, L"PsGetProcessSectionBaseAddress");
    g_PsGetProcessSectionBaseAddress =
        (PFN_PS_GET_PROCESS_SECTION_BASE_ADDRESS)MmGetSystemRoutineAddress(&name);

    status = MeResolveNtosBase();
    if (!NT_SUCCESS(status)) {
        return status;
    }
    return MeResolveEprocessOffsets();
}

void
MeProcInfoShutdown(void)
{
    g_Resolved = FALSE;
    g_NtosBase = NULL;
    g_NtosSize = 0;
    g_OffPid = g_OffLinks = g_OffName = (SIZE_T)-1;
    g_PsGetProcessPeb = NULL;
    g_PsGetProcessSectionBaseAddress = NULL;
}