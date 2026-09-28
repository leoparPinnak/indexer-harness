/**
 * `plan` namespace dictionaries (the composer plan chip and the Plan tab's copy).
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'plan'>` or `PropsLocale<'plan'>` needs only this file, whichever
 * entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer plan chip's and the Plan tab's copy. */
    plan: PlanKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'chip.label': 'Plan',
  'chip.on.aria': 'plan mode 已开启，按下关闭',
  'chip.on.title': 'plan mode 已开启 — 点击关闭（/plan off）',
  'chip.off.aria': 'plan mode 已关闭，按下开启',
  'chip.off.title': 'plan mode 已关闭 — 点击开启（/plan）',
  'chip.exitFailed': '退出 plan mode 失败',
  'tab.label': '计划',
  'tab.description': '阅读本次会话中最新提交的计划。',
  'tab.current': '当前',
  'tab.history': '历史',
  'tab.empty': '本次会话还没有提交过计划。',
  'tab.historyEmpty': '本次会话还没有更早的计划。',
  'tab.untitled': '未命名计划',
  'tab.new': '新',
  'tab.ymd': '{y}-{m}-{d}',
  'apply.label': '应用计划',
  'apply.failed': '应用计划失败',
} satisfies Record<string, string>

/** The plan namespace key union. */
export type PlanKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'chip.label': 'Plan',
  'chip.on.aria': 'Plan mode on, press to turn off',
  'chip.on.title': 'Plan mode on — click to turn off (/plan off)',
  'chip.off.aria': 'Plan mode off, press to turn on',
  'chip.off.title': 'Plan mode off — click to turn on (/plan)',
  'chip.exitFailed': 'Failed to exit plan mode',
  'tab.label': 'Plan',
  'tab.description': 'Read the latest plan presented in this session.',
  'tab.current': 'Current',
  'tab.history': 'History',
  'tab.empty': 'No plan has been presented in this session yet.',
  'tab.historyEmpty': 'No earlier plan has been presented in this session yet.',
  'tab.untitled': 'Untitled plan',
  'tab.new': 'New',
  'tab.ymd': '{y}-{m}-{d}',
  'apply.label': 'Apply plan',
  'apply.failed': 'Failed to apply the plan',
} satisfies Record<PlanKey, string>

/** Turkish dictionary, checked complete against the zh key set. */
export const tr = {
  'chip.label': 'Plan',
  'chip.on.aria': 'Plan modu açık, kapatmak için basın',
  'chip.on.title': 'Plan modu açık — kapatmak için tıklayın (/plan off)',
  'chip.off.aria': 'Plan modu kapalı, açmak için basın',
  'chip.off.title': 'Plan modu kapalı — açmak için tıklayın (/plan)',
  'chip.exitFailed': 'Plan modundan çıkılamadı',
  'tab.label': 'Plan',
  'tab.description': 'Bu oturumda sunulan en son planı okuyun.',
  'tab.current': 'Güncel',
  'tab.history': 'Geçmiş',
  'tab.empty': 'Bu oturumda henüz bir plan sunulmadı.',
  'tab.historyEmpty': 'Bu oturumda henüz daha eski bir plan sunulmadı.',
  'tab.untitled': 'Adsız plan',
  'tab.new': 'Yeni',
  'tab.ymd': '{d}.{m}.{y}',
  'apply.label': 'Planı uygula',
  'apply.failed': 'Plan uygulanamadı',
} satisfies Record<PlanKey, string>
