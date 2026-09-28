/** Context-control locale namespace and dictionaries. */

/** Namespace for the composer context meter and compaction-mode copy. */
export const NS = 'ui-context-control'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'context.aria': '上下文已用 {percent}',
  'context.used': '上下文用量',
  'context.system': '系统提示词',
  'context.tools': '工具定义',
  'context.messages': '对话消息',
  'number.thousand': '{value}K',
  'number.million': '{value}M',
  'compact.run': '压缩',
  'compact.aria': '立即压缩上下文',
  'scope.global': '全局',
  'scope.session': '仅本会话',
  'settings.open': '设置',
  'settings.title': '压缩设置',
  'settings.strategy': '摘要策略',
  'settings.strategy.conversation': '对话中选定的模型（分窗口）',
  'settings.strategy.dedicated': '专用摘要模型',
  'settings.trigger': '触发点',
  'settings.provider': '提供商',
  'settings.model': '模型',
  'settings.budget': '上下文预算（tokens）',
  'settings.threshold': '触发点（tokens）',
  'settings.summaryCap': '压缩上限（tokens）',
  'settings.capHint': '压缩摘要的输出上限；留空使用 8192。',
  'settings.auto': '跟随默认值',
  'settings.save': '保存',
  'settings.saved': '已保存',
  'settings.failed': '保存失败：{error}',
} as const

/** English dictionary. */
export const en: Record<keyof typeof zh, string> = {
  'context.aria': '{percent} of context used',
  'context.used': 'Context usage',
  'context.system': 'System prompt',
  'context.tools': 'Tool definitions',
  'context.messages': 'Conversation',
  'number.thousand': '{value}K',
  'number.million': '{value}M',
  'compact.run': 'Compact',
  'compact.aria': 'Compact the context now',
  'scope.global': 'Global',
  'scope.session': 'This session only',
  'settings.open': 'Settings',
  'settings.title': 'Compaction settings',
  'settings.strategy': 'Summarization strategy',
  'settings.strategy.conversation': "The chat's selected model (windowed)",
  'settings.strategy.dedicated': 'Dedicated summarization model',
  'settings.trigger': 'Trigger point',
  'settings.provider': 'Provider',
  'settings.model': 'Model',
  'settings.budget': 'Context budget (tokens)',
  'settings.threshold': 'Trigger point (tokens)',
  'settings.summaryCap': 'Compaction cap (tokens)',
  'settings.capHint': 'Output cap for compaction summaries; empty keeps 8192.',
  'settings.auto': 'Follow default',
  'settings.save': 'Save',
  'settings.saved': 'Saved',
  'settings.failed': 'Could not save: {error}',
}

/** Turkish dictionary. */
export const tr: Record<keyof typeof zh, string> = {
  'context.aria': 'Bağlam kullanımı: {percent}',
  'context.used': 'Bağlam kullanımı',
  'context.system': 'Sistem istemi',
  'context.tools': 'Araç tanımları',
  'context.messages': 'Konuşma',
  'number.thousand': '{value}B',
  'number.million': '{value}Mn',
  'compact.run': 'Sıkıştır',
  'compact.aria': 'Bağlamı şimdi sıkıştır',
  'scope.global': 'Global',
  'scope.session': 'Yalnızca bu oturum',
  'settings.open': 'Ayar',
  'settings.title': 'Sıkıştırma ayarları',
  'settings.strategy': 'Özetleme stratejisi',
  'settings.strategy.conversation': 'Sohbette seçili model (pencereli)',
  'settings.strategy.dedicated': 'Özel özetleme modeli',
  'settings.trigger': 'Tetik noktası',
  'settings.provider': 'Sağlayıcı',
  'settings.model': 'Model',
  'settings.budget': 'Bağlam bütçesi (token)',
  'settings.threshold': 'Tetik noktası (token)',
  'settings.summaryCap': 'Sıkıştırma tavanı (token)',
  'settings.capHint': 'Sıkıştırma özetlerinin çıktı tavanı; boş bırakılırsa 8192 kullanılır.',
  'settings.auto': 'Varsayılanı izle',
  'settings.save': 'Kaydet',
  'settings.saved': 'Kaydedildi',
  'settings.failed': 'Kaydedilemedi: {error}',
}

/** Dictionary key union. */
export type ContextControlKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'ui-context-control': ContextControlKey
  }
}
