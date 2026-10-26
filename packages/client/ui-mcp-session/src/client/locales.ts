/** Copy dictionaries for the composer's per-session MCP server switches. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  label: 'MCP',
  title: '本会话的 MCP 服务器',
  loading: '正在读取 MCP 服务器…',
  error: '暂时无法读取 MCP 服务器。',
  retry: '重试',
  writeFailed: '切换失败，请重试。',
  empty: '没有可用的 MCP 服务器。',
  tools: '{count} 个工具',
  pending: '正在应用…',
  toggle: '{name} MCP 服务器',
  hostDisabledNote: '已在宿主层停用',
} satisfies Record<string, string>

/** MCP session control locale key union. */
export type McpSessionLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  label: 'MCP',
  title: 'MCP servers for this session',
  loading: 'Reading MCP servers…',
  error: 'MCP servers are temporarily unavailable.',
  retry: 'Retry',
  writeFailed: 'The change was not applied. Try again.',
  empty: 'No MCP servers are available.',
  tools: '{count} tools',
  pending: 'Applying…',
  toggle: '{name} MCP server',
  hostDisabledNote: 'Disabled at the Host level',
} satisfies Record<McpSessionLocaleKey, string>

/** Turkish dictionary checked against the Chinese key set. */
export const tr = {
  label: 'MCP',
  title: 'Bu oturumun MCP sunucuları',
  loading: 'MCP sunucuları okunuyor…',
  error: 'MCP sunucuları geçici olarak kullanılamıyor.',
  retry: 'Yeniden dene',
  writeFailed: 'Değişiklik uygulanmadı. Yeniden deneyin.',
  empty: 'Kullanılabilir MCP sunucusu yok.',
  tools: '{count} araç',
  pending: 'Uygulanıyor…',
  toggle: '{name} MCP sunucusu',
  hostDisabledNote: 'Host düzeyinde kapalı',
} satisfies Record<McpSessionLocaleKey, string>
