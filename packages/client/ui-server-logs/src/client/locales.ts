/**
 * `serverLogs` namespace dictionaries, and the namespace's declaration.
 *
 * Copy for the settings Server Logs section: the nav label, the log pane,
 * and its filter/refresh/clear controls.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'serverLogs'>` or `PropsLocale<'serverLogs'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Server log viewer copy. */
    serverLogs: ServerLogsKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'nav': '服务器日志',
  'logs.description': 'Web 服务进程的日志文件末尾。刷新每两秒拉取一次；清空会截断文件。',
  'logs.filter.label': '过滤日志行',
  'logs.filter.placeholder': '包含的文本…',
  'logs.autorefresh': '自动刷新',
  'logs.action.refresh': '刷新',
  'logs.action.clear': '清空',
  'logs.error.load': '日志加载失败。',
  'logs.error.clear': '日志清空失败。',
  'logs.truncated': '仅显示末尾部分，更早的内容已被截断。',
  'logs.empty': '暂无日志行。',
} satisfies Record<string, string>

/** Server-log dictionary key union. */
export type ServerLogsKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'nav': 'Server Logs',
  'logs.description': 'The tail of the Web host process log file. Refresh pulls every two seconds; clear truncates the file.',
  'logs.filter.label': 'Filter log lines',
  'logs.filter.placeholder': 'Text to include…',
  'logs.autorefresh': 'Auto-refresh',
  'logs.action.refresh': 'Refresh',
  'logs.action.clear': 'Clear',
  'logs.error.load': 'Failed to load the log.',
  'logs.error.clear': 'Failed to clear the log.',
  'logs.truncated': 'Showing the tail only; older content is truncated.',
  'logs.empty': 'No log lines yet.',
} satisfies Record<ServerLogsKey, string>

/** Turkish dictionary, checked against the Chinese key set. */
export const tr = {
  'nav': 'Sunucu Logları',
  'logs.description': 'Web sunucu sürecinin log dosyasının sonu. Yenileme iki saniyede bir çeker; temizle dosyayı sıfırlar.',
  'logs.filter.label': 'Log satırlarını filtrele',
  'logs.filter.placeholder': 'İçermesi gereken metin…',
  'logs.autorefresh': 'Otomatik yenile',
  'logs.action.refresh': 'Yenile',
  'logs.action.clear': 'Temizle',
  'logs.error.load': 'Log yüklenemedi.',
  'logs.error.clear': 'Log temizlenemedi.',
  'logs.truncated': 'Yalnızca son kısım gösteriliyor; eski içerik kırpıldı.',
  'logs.empty': 'Henüz log satırı yok.',
} satisfies Record<ServerLogsKey, string>
