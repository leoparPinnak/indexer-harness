/**
 * `sandboxView` namespace dictionaries, and the namespace's declaration.
 *
 * The tab type's label, the stream's own lines, the live-process widget's
 * states and actions, the input-control statuses, and the change badge's
 * tooltip. Window titles and executable names stay user data and never
 * enter this file.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'sandboxView'>` or `PropsLocale<'sandboxView'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sandbox tab type name, stream lines, live-process widget copy, input-control statuses, and change badge tooltip. */
    sandboxView: SandboxViewKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': 'Daemon',
  'type.description': '在右侧栏中实时查看 Windows Daemon 隔离桌面。',
  'stream.alt': 'Windows Daemon 桌面',
  'stream.failed': 'Daemon 画面不可用。',
  'action.retry': '重试连接',
  'action.refresh': '刷新画面',
  'action.stop': '停止桌面',
  'action.start': '启动桌面',
  'status.connecting': '正在连接 Daemon 桌面...',
  'target.win32': '隔离桌面 (Win32)',
  'target.hyperv': 'Hyper-V 虚拟机',
  'target.desktop': '主屏幕桌面 (只读)',
  'card.idle.title': '此会话的桌面未启动',
  'card.idle.desc': '启动隔离桌面后，应用窗口将在此面板中实时呈现。',
  'dock.label': '虚拟化',
  'dock.tooltip': '管理此会话的虚拟桌面和 Hyper-V 环境',
  'dock.title': 'Daemon 虚拟化管理',
  'dock.tab.session': '此会话',
  'dock.tab.all': '所有活跃虚拟化',
  'dock.action.addWin32': '+ 添加隔离桌面 (Win32)',
  'dock.action.addUbuntu': '+ 添加 Ubuntu 24.04 (Linux)',
  'dock.action.addHyperV': '+ 添加 Hyper-V 虚拟机',
  'dock.action.attach': '关联到此会话',
  'dock.action.detach': '分离',
  'dock.action.terminate': '终止',
  'dock.action.view': '在侧边栏中查看',
  'dock.status.attached': '已关联',
  'dock.status.active': '运行中',
  'dock.status.idle': '就绪',
  'dock.empty.session': '此会话尚未添加任何虚拟桌面或 Hyper-V 环境。',
  'dock.empty.all': '目前没有任何会话启动虚拟环境。',
  'fps.label': '帧率 (FPS)',
  'fps.live': '实时帧率',
  'processes.title': '活动进程',
  'processes.loading': '正在加载窗口...',
  'processes.empty': '未检测到窗口。',
  'processes.error': '无法加载窗口。',
  'processes.action.focus': '聚焦',
  'processes.action.close': '关闭',
  'processes.action.refresh': '刷新',
  'processes.meta.pid': 'PID ',
  'control.label': '发送输入',
  'control.tooltip': '将此面板的点击、滚动和按键转发到隔离桌面。',
  'control.focusHint': '点击、滚动和按键将发送到桌面。',
  'control.released': '已释放输入控制。',
  'control.refused': '主机遇到了拒绝，操作未执行。',
  'changes.badge': '未查看的桌面变更',
} satisfies Record<string, string>

/** Sandbox-view dictionary key union. */
export type SandboxViewKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Daemon',
  'type.description': 'Watch the private Windows Daemon desktop live in the right sidebar.',
  'stream.alt': 'Windows Daemon desktop',
  'stream.failed': 'The Daemon stream is unavailable.',
  'action.retry': 'Retry Connection',
  'action.refresh': 'Refresh Stream',
  'action.stop': 'Stop Desktop',
  'action.start': 'Start Desktop',
  'status.connecting': 'Connecting to Daemon desktop...',
  'target.win32': 'Isolated Desktop (Win32)',
  'target.hyperv': 'Hyper-V VM',
  'target.desktop': 'Host Desktop (View-only)',
  'card.idle.title': 'Desktop not started for this session',
  'card.idle.desc': 'Start an isolated desktop to view and run applications inside this pane.',
  'dock.label': 'Virtualization',
  'dock.tooltip': 'Manage virtual desktops and Hyper-V environments for this session',
  'dock.title': 'Daemon Virtualization Manager',
  'dock.tab.session': 'This Session',
  'dock.tab.all': 'All Active Environments',
  'dock.action.addWin32': '+ Add Isolated Desktop (Win32)',
  'dock.action.addUbuntu': '+ Add Ubuntu 24.04 (Linux)',
  'dock.action.addHyperV': '+ Add Hyper-V VM',
  'dock.action.attach': 'Attach to this session',
  'dock.action.detach': 'Detach',
  'dock.action.terminate': 'Terminate',
  'dock.action.view': 'View in Sidebar',
  'dock.status.attached': 'Attached',
  'dock.status.active': 'Active',
  'dock.status.idle': 'Ready',
  'dock.empty.session': 'No virtual desktops or Hyper-V environments added to this session yet.',
  'dock.empty.all': 'No active virtual environments found across any session.',
  'fps.label': 'Frame Rate (FPS)',
  'fps.live': 'Live FPS',
  'processes.title': 'Live processes',
  'processes.loading': 'Loading windows...',
  'processes.empty': 'No windows detected.',
  'processes.error': 'Could not load windows.',
  'processes.action.focus': 'Focus',
  'processes.action.close': 'Close',
  'processes.action.refresh': 'Refresh',
  'processes.meta.pid': 'PID ',
  'control.label': 'Send input',
  'control.tooltip': 'Forward clicks, scrolling, and keys from this pane to the isolated desktop.',
  'control.focusHint': 'Clicks, scroll, and keys go to the desktop.',
  'control.released': 'Input control released.',
  'control.refused': 'The host refused this action.',
  'changes.badge': 'Unreviewed desktop changes',
} satisfies Record<SandboxViewKey, string>

/** Turkish dictionary, checked against the Chinese key set. */
export const tr = {
  'type.label': 'Daemon',
  'type.description': 'Windows Daemon izole masaüstünü sağ kenar çubuğunda canlı izleyin.',
  'stream.alt': 'Windows Daemon masaüstü',
  'stream.failed': 'Daemon akışı kullanılamıyor.',
  'action.retry': 'Tekrar Dene',
  'action.refresh': 'Akışı Yenile',
  'action.stop': 'Masaüstünü Durdur',
  'action.start': 'Masaüstünü Başlat',
  'status.connecting': 'Daemon masaüstüne bağlanılıyor...',
  'target.win32': 'İzole Masaüstü (Win32)',
  'target.hyperv': 'Hyper-V Sanal Makine',
  'target.desktop': 'Ana Masaüstüm (Salt Okunur)',
  'card.idle.title': 'Bu oturum için masaüstü henüz başlatılmadı',
  'card.idle.desc': 'İzole masaüstünü başlatarak uygulamaları bu panelden canlı izleyin.',
  'dock.label': 'Sanallaştırma',
  'dock.tooltip': 'Bu oturumun sanal masaüstü ve Hyper-V ortamlarını yönetin',
  'dock.title': 'Daemon Sanallaştırma Yöneticisi',
  'dock.tab.session': 'Bu Oturum',
  'dock.tab.all': 'Tüm Aktif Sanallaştırmalar',
  'dock.action.addWin32': '+ Yeni İzole Masaüstü (Win32) Ekle',
  'dock.action.addUbuntu': '+ Yeni Ubuntu 24.04 (Linux) Ekle',
  'dock.action.addHyperV': '+ Yeni Hyper-V Ekle',
  'dock.action.attach': 'Bu Oturuma Bağla',
  'dock.action.detach': 'Bağlantıyı Kes',
  'dock.action.terminate': 'Sonlandır',
  'dock.action.view': 'Sağ Panelde Aç',
  'dock.status.attached': 'Bağlı',
  'dock.status.active': 'Canlı',
  'dock.status.idle': 'Hazır',
  'dock.empty.session': 'Bu oturuma henüz eklenmiş bir sanal masaüstü veya Hyper-V bulunmuyor.',
  'dock.empty.all': 'Şu an hiçbir oturumda açık sanallaştırma bulunmuyor.',
  'fps.label': 'Kare Hızı (FPS)',
  'fps.live': 'Anlık FPS',
  'processes.title': 'Aktif süreçler',
  'processes.loading': 'Pencereler yükleniyor...',
  'processes.empty': 'Pencere algılanmadı.',
  'processes.error': 'Pencereler yüklenemedi.',
  'processes.action.focus': 'Odaklan',
  'processes.action.close': 'Kapat',
  'processes.action.refresh': 'Yenile',
  'processes.meta.pid': 'PID ',
  'control.label': 'Girdi gönder',
  'control.tooltip': 'Bu panelden tıklamaları, kaydırmayı ve tuşları izole masaüstüne iletir.',
  'control.focusHint': 'Tıklama, kaydırma ve tuşlar masaüstüne gider.',
  'control.released': 'Girdi kontrolü bırakıldı.',
  'control.refused': 'Ana bilgisayar bu işlemi reddetti.',
  'changes.badge': 'İncelenmemiş masaüstü değişiklikleri',
} satisfies Record<SandboxViewKey, string>
