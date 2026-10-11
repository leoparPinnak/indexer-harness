/*++
  win32-kernel-bridge — driver/protect.c

  IOCTL_ME_PROTECT — PsSetCreateProcessNotifyRoutineEx izleme kaydı.

  Sürücü yüklendiği anda tüm süreç oluşturma/çıkış olaylarını alan bir
  bildirim geri çağrısı kaydeder. Kayıt yalnız hedef PID listesindeki
  süreçler için tutulur (ADD/REMOVE/CLEAR ile yönetilir); DRAIN birikmiş
  kayıtları sırayla boşaltır.

  Kilit disiplini: ERESOURCE (bildirim geri çağrısı PASSIVE_LEVEL'da ve
  bir kritik bölge içinde çalıştığı için; spinlock yerine kural gereği
  ERESOURCE/FAST_MUTEX — burada ERESOURCE). Olay halkası ME_MAX_EVENTS
  taşarca en eski kayıt düşürülür.

  Unload temizliği: notify kaydı kaldırılır (Windows, kaldırma tamamlanana
  kadar devam eden bildirim geri çağrısı beklemez — bu yüzden kuyruk
  serbest bırakılmadan önce unregister değer dönüşü doğrulanır), düğümler
  ve halka boşaltılır.
--*/

#include "me_internal.h"

typedef struct _ME_WATCH_NODE {
    LIST_ENTRY link;
    me_u32     pid;
    me_u16     imageName[ME_IMAGE_NAME_CHARS];
} ME_WATCH_NODE;

static ERESOURCE g_StateLock;
static LIST_ENTRY g_WatchList;      /* ME_WATCH_NODE */
static ULONG g_WatchCount = 0;
static LIST_ENTRY g_EventRing;      /* ME_EVENT paketli düğümler: ME_EVENT_NODE */
static ULONG g_EventCount = 0;
static BOOLEAN g_NotifyRegistered = FALSE;
static BOOLEAN g_Ready = FALSE;

typedef struct _ME_EVENT_NODE {
    LIST_ENTRY link;
    ME_EVENT   event;
} ME_EVENT_NODE;

/* --------------------------------------------------------------------------
 * Yardımcılar
 * -------------------------------------------------------------------------- */
static void
MeCopyBaseName(
    _In_opt_ PCUNICODE_STRING fullPath,
    _Out_writes_(ME_IMAGE_NAME_CHARS) me_u16 *name)
{
    USHORT i;
    USHORT start = 0;

    RtlZeroMemory(name, ME_IMAGE_NAME_CHARS * sizeof(me_u16));
    if (fullPath == NULL || fullPath->Buffer == NULL || fullPath->Length == 0) {
        return;
    }

    for (i = 0; i < fullPath->Length / sizeof(WCHAR); ++i) {
        if (fullPath->Buffer[i] == L'\\' || fullPath->Buffer[i] == L'/') {
            start = (USHORT)(i + 1);
        }
    }

    for (i = 0; i < ME_IMAGE_NAME_CHARS - 1; ++i) {
        USHORT idx = (USHORT)(start + i);
        if (idx >= fullPath->Length / sizeof(WCHAR)) {
            break;
        }
        name[i] = (me_u16)fullPath->Buffer[idx];
    }
}

static BOOLEAN
MeUpcaseNameEqual(
    _In_reads_(ME_IMAGE_NAME_CHARS) const me_u16 *a,
    _In_reads_(ME_IMAGE_NAME_CHARS) const me_u16 *b)
{
    /* Çekirdek CRT yok: yalnız belgelenmiş dışa aktarım RtlUpcaseUnicodeChar. */
    ULONG i;
    for (i = 0; i < ME_IMAGE_NAME_CHARS; ++i) {
        WCHAR ca = RtlUpcaseUnicodeChar((WCHAR)a[i]);
        WCHAR cb = RtlUpcaseUnicodeChar((WCHAR)b[i]);
        if (ca != cb) {
            return FALSE;
        }
        if (ca == L'\0') {
            return TRUE;
        }
    }
    return TRUE;
}

static BOOLEAN
MeWatchListContains_NoLock(
    _In_ me_u32 pid)
{
    PLIST_ENTRY entry;

    for (entry = g_WatchList.Flink; entry != &g_WatchList; entry = entry->Flink) {
        ME_WATCH_NODE *node = CONTAINING_RECORD(entry, ME_WATCH_NODE, link);
        if (node->pid == pid) {
            return TRUE;
        }
    }
    return FALSE;
}

static void
MePushEvent_NoLock(
    _In_ const ME_EVENT *event)
{
    ME_EVENT_NODE *node;

    if (g_EventCount >= ME_MAX_EVENTS) {
        /* Halka dolu: en eski kaydı düşür (yeni kayıt daha taze). */
        PLIST_ENTRY oldest = RemoveHeadList(&g_EventRing);
        ExFreePoolWithTag(CONTAINING_RECORD(oldest, ME_EVENT_NODE, link), ME_POOL_TAG);
        --g_EventCount;
    }

    node = (ME_EVENT_NODE *)ExAllocatePool2(POOL_FLAG_NON_PAGED, sizeof(*node), ME_POOL_TAG);
    if (node == NULL) {
        return; /* bellek sıkışıklığında kayıt sessizce düşer; olay akışı bozulmaz */
    }
    RtlZeroMemory(node, sizeof(*node));
    node->event = *event;
    InsertTailList(&g_EventRing, &node->link);
    ++g_EventCount;
}

/* --------------------------------------------------------------------------
 * Bildirim geri çağrısı (PCREATE_PROCESS_NOTIFY_ROUTINE_EX)
 * -------------------------------------------------------------------------- */
static void
MeProcessEvent(
    _Inout_ PEPROCESS process,
    _In_ HANDLE processId,
    _Inout_opt_ PPS_CREATE_NOTIFY_INFO createInfo)
{
    me_u32 pid = (me_u32)(ULONG_PTR)processId;
    ME_EVENT event;
    BOOLEAN tracked;

    UNREFERENCED_PARAMETER(process);

    if (!g_Ready) {
        return;
    }

    ExAcquireResourceSharedLite(&g_StateLock, TRUE);

    /* İzleme listesi geniş eşleşmede korunur: yaratılışta listeye eklenen
     * PID için ya o PID'nin kendisi ya da aynı görüntü adı kaydı tutulur. */
    tracked = MeWatchListContains_NoLock(pid);
    if (!tracked && createInfo != NULL) {
        me_u16 baseName[ME_IMAGE_NAME_CHARS];
        PLIST_ENTRY entry;

        MeCopyBaseName(createInfo->ImageFileName, baseName);
        for (entry = g_WatchList.Flink; entry != &g_WatchList; entry = entry->Flink) {
            ME_WATCH_NODE *node = CONTAINING_RECORD(entry, ME_WATCH_NODE, link);
            if (baseName[0] != 0 && MeUpcaseNameEqual(node->imageName, baseName)) {
                tracked = TRUE;
                break;
            }
        }
    }

    if (tracked) {
        RtlZeroMemory(&event, sizeof(event));
        event.recordType = (createInfo != NULL) ? ME_EVENT_CREATE : ME_EVENT_EXIT;
        event.pid = pid;
        event.parentPid = (createInfo != NULL) ? (me_u64)(ULONG_PTR)createInfo->ParentProcessId : 0;
        event.time100ns = (me_u64)KeQueryInterruptTime();
        if (createInfo != NULL) {
            MeCopyBaseName(createInfo->ImageFileName, event.imageName);
        }
        MePushEvent_NoLock(&event);
    }

    ExReleaseResourceLite(&g_StateLock);
}

/* --------------------------------------------------------------------------
 * IOCTL_ME_PROTECT
 * -------------------------------------------------------------------------- */
NTSTATUS
MeProtectIoctl(
    _In_reads_bytes_(inLen) const ME_PROTECT_IN *in,
    _In_ ULONG inLen,
    _Out_writes_bytes_opt_(outLen) PVOID outBuf,
    _In_ ULONG outLen,
    _Out_ PULONG_PTR information)
{
    *information = 0;

    if (KeGetCurrentIrql() != PASSIVE_LEVEL) {
        return STATUS_INVALID_DEVICE_STATE;
    }
    if (!g_Ready) {
        return STATUS_DEVICE_NOT_READY;
    }
    if (in == NULL || inLen < sizeof(ME_PROTECT_IN)) {
        return STATUS_BUFFER_TOO_SMALL;
    }

    switch (in->opcode) {

    case ME_PROTECT_ADD: {
        ME_WATCH_NODE *node;
        NTSTATUS addStatus;
        if (in->pid == 0) {
            return STATUS_INVALID_PARAMETER;
        }
        node = (ME_WATCH_NODE *)ExAllocatePool2(POOL_FLAG_NON_PAGED, sizeof(*node), ME_POOL_TAG);
        if (node == NULL) {
            return STATUS_INSUFFICIENT_RESOURCES;
        }
        RtlZeroMemory(node, sizeof(*node));
        node->pid = in->pid;

        ExAcquireResourceExclusiveLite(&g_StateLock, TRUE);
        if (MeWatchListContains_NoLock(in->pid)) {
            addStatus = STATUS_ALREADY_REGISTERED;
        } else if (g_WatchCount >= ME_MAX_WATCH_PIDS) {
            addStatus = STATUS_QUOTA_EXCEEDED;
        } else {
            InsertTailList(&g_WatchList, &node->link);
            ++g_WatchCount;
            addStatus = STATUS_SUCCESS;
        }
        ExReleaseResourceLite(&g_StateLock);

        if (!NT_SUCCESS(addStatus)) {
            ExFreePoolWithTag(node, ME_POOL_TAG);
        }
        return addStatus;
    }

    case ME_PROTECT_REMOVE: {
        PLIST_ENTRY entry;
        ExAcquireResourceExclusiveLite(&g_StateLock, TRUE);
        for (entry = g_WatchList.Flink; entry != &g_WatchList; entry = entry->Flink) {
            ME_WATCH_NODE *node = CONTAINING_RECORD(entry, ME_WATCH_NODE, link);
            if (node->pid == in->pid) {
                RemoveEntryList(&node->link);
                --g_WatchCount;
                ExReleaseResourceLite(&g_StateLock);
                ExFreePoolWithTag(node, ME_POOL_TAG);
                return STATUS_SUCCESS;
            }
        }
        ExReleaseResourceLite(&g_StateLock);
        return STATUS_NOT_FOUND;
    }

    case ME_PROTECT_CLEAR: {
        ExAcquireResourceExclusiveLite(&g_StateLock, TRUE);
        while (!IsListEmpty(&g_WatchList)) {
            PLIST_ENTRY entry = RemoveHeadList(&g_WatchList);
            ExFreePoolWithTag(CONTAINING_RECORD(entry, ME_WATCH_NODE, link), ME_POOL_TAG);
        }
        g_WatchCount = 0;
        ExReleaseResourceLite(&g_StateLock);
        return STATUS_SUCCESS;
    }

    case ME_PROTECT_DRAIN: {
        ULONG maxEvents;
        ULONG delivered = 0;
        ULONG outCapacity;

        if (outBuf == NULL) {
            return STATUS_BUFFER_TOO_SMALL;
        }
        maxEvents = (in->maxEvents != 0) ? in->maxEvents : ME_MAX_EVENTS;
        outCapacity = outLen / (ULONG)sizeof(ME_EVENT);
        if (outCapacity == 0) {
            return STATUS_BUFFER_TOO_SMALL;
        }
        if (maxEvents > outCapacity) {
            maxEvents = outCapacity;
        }

        ExAcquireResourceExclusiveLite(&g_StateLock, TRUE);
        while (delivered < maxEvents && !IsListEmpty(&g_EventRing)) {
            PLIST_ENTRY entry = RemoveHeadList(&g_EventRing);
            ME_EVENT_NODE *node = CONTAINING_RECORD(entry, ME_EVENT_NODE, link);
            RtlCopyMemory((PUCHAR)outBuf + delivered * sizeof(ME_EVENT),
                          &node->event,
                          sizeof(ME_EVENT));
            ExFreePoolWithTag(node, ME_POOL_TAG);
            --g_EventCount;
            ++delivered;
        }
        ExReleaseResourceLite(&g_StateLock);

        *information = delivered * sizeof(ME_EVENT);
        return STATUS_SUCCESS;
    }

    default:
        return STATUS_INVALID_PARAMETER;
    }
}

/* --------------------------------------------------------------------------
 * Yaşam döngüsü
 * -------------------------------------------------------------------------- */
NTSTATUS
MeProtectInit(void)
{
    NTSTATUS status;

    status = ExInitializeResourceLite(&g_StateLock);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    InitializeListHead(&g_WatchList);
    InitializeListHead(&g_EventRing);
    g_WatchCount = 0;
    g_EventCount = 0;

    status = PsSetCreateProcessNotifyRoutineEx(MeProcessEvent, FALSE);
    if (!NT_SUCCESS(status)) {
        ExDeleteResourceLite(&g_StateLock);
        return status;
    }

    g_NotifyRegistered = TRUE;
    g_Ready = TRUE;
    return STATUS_SUCCESS;
}

void
MeProtectShutdown(void)
{
    g_Ready = FALSE;

    if (g_NotifyRegistered) {
        /* Windows bu çağrı sırasında devam eden bildirim geri
         * çağrılarının bitmesini bekler; sonrasında kuyruk güvenle
         * boşaltılabilir. */
        (void)PsSetCreateProcessNotifyRoutineEx(MeProcessEvent, TRUE);
        g_NotifyRegistered = FALSE;
    }

    while (!IsListEmpty(&g_WatchList)) {
        PLIST_ENTRY entry = RemoveHeadList(&g_WatchList);
        ExFreePoolWithTag(CONTAINING_RECORD(entry, ME_WATCH_NODE, link), ME_POOL_TAG);
    }
    g_WatchCount = 0;

    while (!IsListEmpty(&g_EventRing)) {
        PLIST_ENTRY entry = RemoveHeadList(&g_EventRing);
        ExFreePoolWithTag(CONTAINING_RECORD(entry, ME_EVENT_NODE, link), ME_POOL_TAG);
    }
    g_EventCount = 0;

    ExDeleteResourceLite(&g_StateLock);
}