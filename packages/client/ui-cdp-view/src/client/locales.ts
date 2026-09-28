/**
 * `cdpView` namespace dictionaries, and the namespace's declaration.
 *
 * The tab type's label, its one-line description, the body's load and failure
 * lines, the retry verb, and the status field labels and values. Version
 * strings and target titles stay wire data and never enter this file.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'cdpView'>` or `PropsLocale<'cdpView'>` needs only this file,
 * whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** CDP tab type name, status field labels and values, and the body's load and failure lines. */
    cdpView: CdpViewKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': 'CDP',
  'type.description': '在右侧栏中查看 Chrome DevTools Protocol 扩展的状态与实时目标。',
  'status.loading': '正在加载 CDP 状态...',
  'status.error': '无法加载 CDP 状态。',
  'status.ok': '可用',
  'status.unavailable': '不可用',
  'action.retry': '重试',
  'field.version': '版本',
  'field.targets': '目标',
  'field.proxy': '代理',
  'value.active': '已启用',
  'value.inactive': '未启用',
} satisfies Record<string, string>

/** Cdp-view dictionary key union. */
export type CdpViewKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'CDP',
  'type.description': 'Watch the Chrome DevTools Protocol extension status and live targets in the right sidebar.',
  'status.loading': 'Loading CDP status...',
  'status.error': 'The CDP status could not be loaded.',
  'status.ok': 'Available',
  'status.unavailable': 'Unavailable',
  'action.retry': 'Retry',
  'field.version': 'Version',
  'field.targets': 'Targets',
  'field.proxy': 'Proxy',
  'value.active': 'Active',
  'value.inactive': 'Inactive',
} satisfies Record<CdpViewKey, string>

/** Turkish dictionary, checked against the Chinese key set. */
export const tr = {
  'type.label': 'CDP',
  'type.description': 'Chrome DevTools Protocol uzantısının durumunu ve canlı hedeflerini sağ kenar çubuğunda izleyin.',
  'status.loading': 'CDP durumu yükleniyor...',
  'status.error': 'CDP durumu yüklenemedi.',
  'status.ok': 'Kullanılabilir',
  'status.unavailable': 'Kullanılamıyor',
  'action.retry': 'Tekrar Dene',
  'field.version': 'Sürüm',
  'field.targets': 'Hedefler',
  'field.proxy': 'Proxy',
  'value.active': 'Etkin',
  'value.inactive': 'Devre dışı',
} satisfies Record<CdpViewKey, string>
