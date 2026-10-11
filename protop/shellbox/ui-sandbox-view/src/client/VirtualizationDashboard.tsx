/**
 * Virtualization manager dashboard: list, create, attach, and terminate virtual environments.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './ShellboxDock.module.css'

export interface SessionSummary {
  readonly title?: string | undefined
  readonly cwd?: string | undefined
}

export interface VirtualInstanceItem {
  readonly id: string
  readonly ownerSessionId: string
  readonly boundSessionIds: readonly string[]
  readonly type: 'win32' | 'hyperv' | 'wsl-ubuntu'
  readonly name: string
  readonly desktopName: string
  readonly vmName?: string | undefined
  readonly createdAt: number
  readonly active: boolean
}

export interface VirtualizationDashboardProps {
  readonly sessionId: string
  readonly sessionsById: Record<string, SessionSummary | undefined>
  readonly t: TranslateNS<'sandboxView'>
  readonly onClose: () => void
  readonly onOpenSidebar?: ((sessionId?: string) => void) | undefined
}

const INSTANCES_URL = '/api/server/sandbox/instances'

export function VirtualizationDashboard({
  sessionId,
  sessionsById,
  t,
  onClose,
  onOpenSidebar,
}: VirtualizationDashboardProps): ReactNode {
  const [activeTab, setActiveTab] = useState<'session' | 'all'>('session')
  const [instances, setInstances] = useState<readonly VirtualInstanceItem[]>([])
  const [loading, setLoading] = useState(false)

  const fetchInstances = async (): Promise<void> => {
    try {
      setLoading(true)
      const res = await fetch(`${INSTANCES_URL}?session=${encodeURIComponent(sessionId)}`)
      if (res.ok) {
        const data = await res.json() as { ok: boolean; instances: VirtualInstanceItem[] }
        if (data.ok && Array.isArray(data.instances)) {
          setInstances(data.instances)
        }
      }
    } catch {
      // Ignore network errors
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchInstances()
  }, [sessionId])

  const handleCreate = async (type: 'win32' | 'hyperv' | 'wsl-ubuntu'): Promise<void> => {
    try {
      await fetch(`${INSTANCES_URL}/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, type }),
      })
      await fetchInstances()
    } catch {
      // Ignore network errors
    }
  }

  const handleAttach = async (instanceId: string): Promise<void> => {
    try {
      await fetch(`${INSTANCES_URL}/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetSessionId: sessionId, instanceId }),
      })
      await fetchInstances()
    } catch {
      // Ignore network errors
    }
  }

  const handleDetach = async (instanceId: string): Promise<void> => {
    try {
      await fetch(`${INSTANCES_URL}/detach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, instanceId }),
      })
      await fetchInstances()
    } catch {
      // Ignore network errors
    }
  }

  const handleTerminate = async (instanceId: string): Promise<void> => {
    try {
      await fetch(`${INSTANCES_URL}/terminate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId }),
      })
      await fetchInstances()
    } catch {
      // Ignore network errors
    }
  }

  const sessionInstances = instances.filter(i => i.boundSessionIds.includes(sessionId))

  return (
    <div className={css.panel} role="dialog" aria-modal="true" aria-label={t('dock.title')}>
      <div className={css.panelHead}>
        <span>{t('dock.title')}</span>
        <button
          type="button"
          className={css.closeBtn}
          title="Kapat"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className={css.tabs}>
        <button
          type="button"
          className={activeTab === 'session' ? css.tabBtnActive : css.tabBtn}
          onClick={() => { setActiveTab('session') }}
        >
          {t('dock.tab.session')} ({sessionInstances.length})
        </button>
        <button
          type="button"
          className={activeTab === 'all' ? css.tabBtnActive : css.tabBtn}
          onClick={() => { setActiveTab('all') }}
        >
          {t('dock.tab.all')} ({instances.length})
        </button>
      </div>

      <div className={css.panelBody}>
        {loading && instances.length === 0 ? (
          <div className={css.emptyNotice}>Yükleniyor...</div>
        ) : activeTab === 'session' ? (
          <>
            <div className={css.actionsRow}>
              <button
                type="button"
                className={css.addBtn}
                onClick={() => void handleCreate('win32')}
              >
                {t('dock.action.addWin32')}
              </button>
              <button
                type="button"
                className={css.addBtn}
                onClick={() => void handleCreate('wsl-ubuntu')}
              >
                {t('dock.action.addUbuntu')}
              </button>
              <button
                type="button"
                className={css.addBtn}
                onClick={() => void handleCreate('hyperv')}
              >
                {t('dock.action.addHyperV')}
              </button>
            </div>

            {sessionInstances.length === 0 ? (
              <div className={css.emptyNotice}>{t('dock.empty.session')}</div>
            ) : (
              sessionInstances.map((item) => {
                const isOwner = item.ownerSessionId === sessionId
                return (
                  <div key={item.id} className={css.card}>
                    <div className={css.cardHeader}>
                      <span className={css.cardTitle}>
                        {item.type === 'wsl-ubuntu' ? '🐧' : item.type === 'win32' ? '🖥️' : '🪟'} {item.name}
                      </span>
                      <span className={item.active ? css.badgeActive : css.badgeIdle}>
                        {item.active ? t('dock.status.active') : t('dock.status.idle')}
                      </span>
                    </div>
                    <div className={css.cardMeta}>
                      <span>Masaüstü: {item.desktopName}</span>
                      {item.vmName ? <span>VM: {item.vmName}</span> : null}
                    </div>
                    <div className={css.cardActions}>
                      <button
                        type="button"
                        className={css.cardBtn}
                        onClick={() => {
                          onOpenSidebar?.(sessionId)
                          onClose()
                        }}
                      >
                        {t('dock.action.view')}
                      </button>
                      {!isOwner ? (
                        <button
                          type="button"
                          className={css.cardBtn}
                          onClick={() => void handleDetach(item.id)}
                        >
                          {t('dock.action.detach')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={css.cardBtnDanger}
                        onClick={() => void handleTerminate(item.id)}
                      >
                        {t('dock.action.terminate')}
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </>
        ) : (
          <>
            {instances.length === 0 ? (
              <div className={css.emptyNotice}>{t('dock.empty.all')}</div>
            ) : (
              instances.map((item) => {
                const isBound = item.boundSessionIds.includes(sessionId)
                const ownerSession = sessionsById[item.ownerSessionId]
                const sessionTitle = ownerSession?.title || item.ownerSessionId
                const sessionCwd = ownerSession?.cwd || '—'

                return (
                  <div key={item.id} className={css.card}>
                    <div className={css.cardHeader}>
                      <span className={css.cardTitle}>
                        {item.type === 'wsl-ubuntu' ? '🐧' : item.type === 'win32' ? '🖥️' : '🪟'} {item.name}
                      </span>
                      <span className={item.active ? css.badgeActive : css.badgeIdle}>
                        {item.active ? t('dock.status.active') : t('dock.status.idle')}
                      </span>
                    </div>
                    <div className={css.cardMeta}>
                      <span>Oturum: {sessionTitle} ({item.ownerSessionId.slice(0, 10)})</span>
                      <span>Dizin: {sessionCwd}</span>
                      <span>Masaüstü: {item.desktopName}</span>
                    </div>
                    <div className={css.cardActions}>
                      {isBound ? (
                        <span className={css.badgeActive}>{t('dock.status.attached')} ✓</span>
                      ) : (
                        <button
                          type="button"
                          className={css.cardBtn}
                          onClick={() => void handleAttach(item.id)}
                        >
                          {t('dock.action.attach')}
                        </button>
                      )}
                      <button
                        type="button"
                        className={css.cardBtnDanger}
                        onClick={() => void handleTerminate(item.id)}
                      >
                        {t('dock.action.terminate')}
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </>
        )}
      </div>
    </div>
  )
}
