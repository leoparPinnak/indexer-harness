/**
 * First-party MCP server classification shared by every session-plane reader:
 * one Loader entry is an MCP server exactly when it names the mcp-client
 * bridge module — however the deployment spelled that specifier — and carries
 * a configured `serverName`.
 *
 * @module @deepseek-ai/dsh-mcp-client/server-name
 */

/** The bridge module name every MCP Loader row ends with. */
export const MCP_CLIENT_MODULE_SUFFIX = 'dsh-mcp-client'

/**
 * The one explicit classify step from a Loader row to the MCP server it
 * configures. The session plane and the plugin inventory both read Loader
 * entries, so module-spelling and config-shape tolerance live here once.
 *
 * @param entry - Loader entry options: the module name and resolved config.
 * @returns The row's `serverName`, or `undefined` when the entry is not an MCP server.
 */
export function serverNameOfLoaderEntry(
  entry: { name: string; config?: unknown },
): string | undefined {
  if (!entry.name.endsWith(MCP_CLIENT_MODULE_SUFFIX)) return undefined
  const config = entry.config as { serverName?: unknown } | undefined
  const serverName = typeof config?.serverName === 'string' ? config.serverName : ''
  return serverName === '' ? undefined : serverName
}

/** Valid `serverName`: kept in step with the bridge's own loader-frame regexp. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
