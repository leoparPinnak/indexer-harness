/**
 * `autopush` namespace dictionaries: the toggle chip, its counter, and the
 * dashboard's history lines.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'chip.label': 'AUTO-PUSH',
  'chip.on.title': '自动推送已开启 — 请求完成后会带土耳其语说明推送',
  'chip.off.title': '自动推送已关闭 — 点击开启',
  'chip.on.aria': '自动推送已开启，按下关闭',
  'chip.off.aria': '自动推送已关闭，按下开启',
  'chip.count': '{count} 次推送',
  'dashboard.title': '自动推送',
  'dashboard.session': '本次会话',
  'dashboard.count': '推送次数',
  'dashboard.last': '上次推送',
  'dashboard.none': '尚未推送',
  'dashboard.history': '推送历史',
  'dashboard.empty': '本次会话还没有推送。',
  'dashboard.emptyProject': '本项目暂无已记录推送。',
  'dashboard.close': '关闭面板',
  'dashboard.files': '{files} 个文件',
  'dashboard.tab.session': '本次会话',
  'dashboard.tab.project': '项目历史',
} satisfies Record<string, string>

/** The autopush namespace key union. */
export type AutoPushKey = keyof typeof zh

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'chip.label': 'AUTO-PUSH',
  'chip.on.title': 'Auto-push is on — a finished request is pushed with a Turkish description',
  'chip.off.title': 'Auto-push is off — click to turn it on',
  'chip.on.aria': 'Auto-push is on, press to turn off',
  'chip.off.aria': 'Auto-push is off, press to turn on',
  'chip.count': '{count} pushes',
  'dashboard.title': 'Auto-push',
  'dashboard.session': 'This session',
  'dashboard.count': 'Pushes',
  'dashboard.last': 'Last push',
  'dashboard.none': 'Nothing pushed yet',
  'dashboard.history': 'Push history',
  'dashboard.empty': 'Nothing has been pushed in this session yet.',
  'dashboard.emptyProject': 'Nothing has been pushed in this project yet.',
  'dashboard.close': 'Close the panel',
  'dashboard.files': '{files} files',
  'dashboard.tab.session': 'This session',
  'dashboard.tab.project': 'Project history',
} satisfies Record<AutoPushKey, string>

/** Turkish dictionary, checked complete against the Chinese key set. */
export const tr = {
  'chip.label': 'AUTO-PUSH',
  'chip.on.title': 'Oto-push açık — tamamlanan istek Türkçe açıklamayla pushlanır',
  'chip.off.title': 'Oto-push kapalı — açmak için tıkla',
  'chip.on.aria': 'Oto-push açık, kapatmak için basın',
  'chip.off.aria': 'Oto-push kapalı, açmak için basın',
  'chip.count': '{count} push',
  'dashboard.title': 'Oto-push',
  'dashboard.session': 'Bu oturum',
  'dashboard.count': 'Push sayısı',
  'dashboard.last': 'Son push',
  'dashboard.none': 'Henüz push yok',
  'dashboard.history': 'Push geçmişi',
  'dashboard.empty': 'Bu oturumda henüz push yapılmadı.',
  'dashboard.emptyProject': 'Bu projede henüz push yapılmadı.',
  'dashboard.close': 'Paneli kapat',
  'dashboard.files': '{files} dosya',
  'dashboard.tab.session': 'Bu oturum',
  'dashboard.tab.project': 'Proje geçmişi',
} satisfies Record<AutoPushKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Auto-push chip and dashboard copy. */
    autopush: AutoPushKey
  }
}
