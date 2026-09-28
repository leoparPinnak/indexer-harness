/**
 * Workspace pick/add flow. WorkspacePickFlow is the reusable core (menu +
 * path error dialog) consumed directly by WorkspaceBrowser (same package) and
 * wrapped by WorkspacePicker for the conversation empty-state slot
 * registration. Directory picking itself lives in the composed flow package's
 * slot occupant (see the contract module doc): this core only opens the flow,
 * adopts the picked path, and owns the error surface. Adding a workspace has
 * exactly one route — pick a host directory, new or existing — because the
 * occupant's own create-folder affordance already covers creating one.
 */
import type { ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, IconFolderClose16, IconFolderOpenOutline16, IconPlusOutline16, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceCreateRequest,
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

const ADD_WORKSPACE = '::add-workspace'
const CREATE_ON_DESKTOP = '::create-on-desktop'

/** Core flow props: the owner supplies popover control and pick semantics. */
export interface WorkspacePickFlowProps {
  /** The standard locale seat, forwarded by whichever slot entry hosts the flow. */
  t: WorkspacePickerProps['t']
  /** Popover visibility (anchor button toggle state, owner-local). */
  open: boolean
  /** The anchor button element — the popover's placement anchor. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  /** Selector hook over the workspace list (framework standard hook). */
  useWorkspaces: <S>(selector: (state: WorkspaceSnapshot) => S) => S
  /** Adopt a picked host directory or create one on desktop as a real Workspace. */
  createWorkspace: (input: WorkspaceCreateRequest) => Promise<WorkspaceView>
  /** Bound occupancy selector hook for this surface's directory-flow hole (empty leaves the surface with no add action). */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** Render this surface's directory-flow hole with the owner conversation (the entry's narrowed renderSlot). */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  /** A real Workspace was picked or created. */
  onPick: (workspaceId: WorkspaceId) => void
  /** Close the popover (outside click / Escape / post-pick). */
  onClose: () => void
  /** Only offer the add action, hide existing workspaces. */
  addOnly?: boolean
  /** Whether to offer the create-on-desktop action (defaults to !addOnly). */
  allowDesktopCreate?: boolean
  /** Menu opening direction relative to the anchor. */
  side?: 'bottom' | 'top' | 'right'
  /** Currently active workspace (trailing check in the picker list). */
  selectedId?: WorkspaceId | undefined
}

/**
 * Render the pick menu plus the adoption error dialog.
 * @param props - owner-controlled flow props.
 * @returns menu + dialog elements.
 */
export function WorkspacePickFlow({
  t,
  open,
  anchorRef,
  useWorkspaces,
  createWorkspace,
  useDirectoryFlow,
  renderDirectoryFlow,
  onPick,
  onClose,
  addOnly = false,
  allowDesktopCreate = !addOnly,
  side = 'bottom',
  selectedId,
}: WorkspacePickFlowProps) {
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const getAnchorRect = useCallback(
    () => anchorRef?.current?.getBoundingClientRect() ?? null,
    [anchorRef],
  )
  const [errorOpen, setErrorOpen] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [flowOpen, setFlowOpen] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [desktopModalOpen, setDesktopModalOpen] = useState(false)
  const [folderDraft, setFolderDraft] = useState('')
  const [creatingDesktop, setCreatingDesktop] = useState(false)
  const [desktopError, setDesktopError] = useState<string | null>(null)
  const composingRef = useRef(false)
  // One picking interaction at a time: while the flow is open (native chooser
  // pending, browse dialog up), its pick is being adopted, or desktop creation
  // is in flight, every other menu action stays disabled.
  const flowBusy = flowOpen || pickingFolder || creatingDesktop

  // The occupied hole gates the picking affordance: with no composed flow the
  // entry simply is not there (the seam's documented no-flow default). The
  // framework-bound hook keeps occupancy live: flow plugins activate (and
  // HMR-reload) independently of this menu's renders.
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  // An occupant that unloads mid-interaction leaves nobody to cancel: an
  // open flow over an empty hole withdraws so the menu actions come back.
  // flowOpen is a dependency because the flow can also OPEN over an already
  // empty hole (Choose again after the occupant unloaded with the error
  // dialog up) — that transition must snap back too, not just occupancy loss.
  useEffect(() => {
    if (flowOpen && !flowAvailable) setFlowOpen(false)
  }, [flowOpen, flowAvailable])
  const addEntries: MenuEntry[] = flowAvailable
    ? [
      ...(allowDesktopCreate
        ? [{
          id: CREATE_ON_DESKTOP,
          label: t('menu.createOnDesktop'),
          icon: <IconFolderOpenOutline16 size={16} />,
          disabled: flowBusy,
        }]
        : []),
      {
        id: ADD_WORKSPACE,
        label: t('menu.addWorkspace'),
        icon: <IconPlusOutline16 size={16} />,
        disabled: flowBusy,
      },
    ]
    : []
  // With workspaces listed, the add action pins below the scroll region
  // (divider + always visible); otherwise it IS the menu.
  const pinAdd = !addOnly && workspaces.length > 0
  const items: MenuEntry[] = pinAdd
    ? workspaces.map(workspace => ({
      id: workspace.workspaceId,
      label: workspace.title,
      icon: <IconFolderClose16 size={16} />,
      disabled: flowBusy,
    }))
    : addEntries
  // Nothing listed and nothing to add with (a composition that mounts this
  // package without any directory-picker): an empty popover would claim a
  // choice that does not exist, so the anchor gesture shows nothing at all.
  const menuIsEmpty = items.length === 0

  const closeModal = (): void => {
    setErrorOpen(false)
    setModalError(null)
  }

  const closeDesktopModal = (): void => {
    if (!creatingDesktop) {
      setDesktopModalOpen(false)
      setDesktopError(null)
    }
  }

  const confirmCreateDesktop = (): void => {
    const trimmed = folderDraft.trim()
    if (trimmed === '') {
      setDesktopError(t('error.folderNameEmpty'))
      return
    }
    if (/[/\\:*?"<>|]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
      setDesktopError(t('error.folderNameInvalid'))
      return
    }
    setCreatingDesktop(true)
    setDesktopError(null)
    createWorkspace({ onDesktop: true, name: trimmed })
      .then((workspace) => {
        setDesktopModalOpen(false)
        setFolderDraft('')
        onPick(workspace.workspaceId)
      })
      .catch((reason: unknown) => {
        setDesktopError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        setCreatingDesktop(false)
      })
  }

  /** Adopt a picked directory; failures land in the folder-error dialog (Choose again reopens the flow). */
  const adoptDirectory = (path: string): Promise<void> =>
    createWorkspace({ path }).then((workspace) => {
      setFlowOpen(false)
      onPick(workspace.workspaceId)
    }).catch((reason: unknown) => {
      setModalError(reason instanceof Error ? reason.message : String(reason))
      setFlowOpen(false)
      setErrorOpen(true)
    })

  const openDirectoryFlow = useCallback((): void => {
    onClose()
    setErrorOpen(false)
    setModalError(null)
    setFlowOpen(true)
  }, [onClose])

  // A menu exists to disambiguate between targets. With no workspaces listed
  // and the add action the only entry left, the anchor gesture IS that action:
  // a one-row popover would cost a click and offer nothing to choose between.
  // The owner's open request is consumed the same way selecting the entry
  // would consume it (close the popover, raise the flow). An empty list is
  // only final once the baseline lands — until then the menu stays up with its
  // loading status instead of jumping into a flow the arriving list would have
  // made unnecessary; the add-only surface lists nothing and never waits.
  const listSettled = addOnly || workspaceSnapshot.phase === 'ready'
  const addIsTheOnlyEntry = !pinAdd && listSettled && addEntries.length === 1 && flowAvailable
  // `flowBusy` gates this exactly as it disables the equivalent menu entry: a
  // pick still being adopted owns the surface until it settles.
  useEffect(() => {
    if (open && addIsTheOnlyEntry && !flowBusy) openDirectoryFlow()
  }, [open, addIsTheOnlyEntry, flowBusy, openDirectoryFlow])

  /** Owner side of the flow conversation: adopt keeps the flow open (busy) until the Host answers. */
  const flowOwner: DirectoryFlowOwnerProps = {
    open: flowOpen,
    busy: pickingFolder,
    onPicked: (path) => {
      setPickingFolder(true)
      void adoptDirectory(path).finally(() => { setPickingFolder(false) })
    },
    onCancel: () => { setFlowOpen(false) },
    onError: (message) => {
      setFlowOpen(false)
      setModalError(message)
      setErrorOpen(true)
    },
  }

  const handleSelect = (id: string): void => {
    if (id === CREATE_ON_DESKTOP) {
      onClose()
      setFolderDraft('')
      setDesktopError(null)
      setDesktopModalOpen(true)
      return
    }
    if (id === ADD_WORKSPACE) {
      openDirectoryFlow()
      return
    }
    onPick(id as WorkspaceId)
  }

  return (
    <>
      <Menu
        open={open && !addIsTheOnlyEntry && !menuIsEmpty}
        anchor={null}
        items={items}
        {...pinAdd ? { footer: addEntries } : {}}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={onClose}
        side={side}
        portal
        getAnchorRect={getAnchorRect}
      />
      {open && !addIsTheOnlyEntry && !menuIsEmpty && workspaceSnapshot.phase === 'pending' && <div className={css.menuStatus} role="status">{t('picker.loading')}</div>}
      {renderDirectoryFlow(flowOwner)}
      <Modal
        open={errorOpen}
        onClose={closeModal}
        closeLabel={t('close')}
        title={t('folderError.title')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeModal}>{t('cancel')}</Button>
            {/* Retrying needs an occupant to serve the flow; without one the
              * button would open a flow nobody can answer or cancel. */}
            <Button variant="primary" className={css.modalAction} disabled={!flowAvailable} onClick={openDirectoryFlow}>{t('folderError.retry')}</Button>
          </>
        )}
      >
        <div className={css.modalError} role="alert">{modalError}</div>
      </Modal>
      <Modal
        open={desktopModalOpen}
        onClose={closeDesktopModal}
        closeLabel={t('close')}
        title={t('modal.createDesktop.title')}
        footer={(
          <>
            <Button
              variant="outline"
              className={css.modalAction}
              disabled={creatingDesktop}
              onClick={closeDesktopModal}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              className={css.modalAction}
              disabled={creatingDesktop || folderDraft.trim() === ''}
              onClick={confirmCreateDesktop}
            >
              {creatingDesktop ? t('loading') : t('create')}
            </Button>
          </>
        )}
      >
        <div className={css.desktopModalBody}>
          <p className={css.desktopModalDesc}>{t('modal.createDesktop.desc')}</p>
          <input
            className={css.renameInput}
            value={folderDraft}
            aria-label={t('field.folderName')}
            placeholder={t('placeholder.folderName')}
            autoFocus
            disabled={creatingDesktop}
            onChange={(e) => {
              setFolderDraft(e.target.value)
              setDesktopError(null)
            }}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !composingRef.current) {
                e.preventDefault()
                confirmCreateDesktop()
              }
            }}
          />
          {desktopError !== null && (
            <div className={css.modalError} role="alert">{desktopError}</div>
          )}
        </div>
      </Modal>
    </>
  )
}

/**
 * The conversation empty-state registration: adapts the owner share to the
 * core flow (all state and semantics live in the flow / the owner).
 * @param props - empty-state slot props (owner share + injected creation callback).
 * @returns the flow element.
 */
export function WorkspacePicker({
  open,
  anchorRef,
  useWorkspaces,
  selectedId,
  onPick,
  onClose,
  createWorkspace,
  useDirectoryFlow,
  renderSlot,
  t,
}: WorkspacePickerProps) {
  return (
    <WorkspacePickFlow
      t={t}
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      useDirectoryFlow={useDirectoryFlow}
      renderDirectoryFlow={owner => renderSlot('conversation.hero.workspace.directoryFlow', owner)}
      selectedId={selectedId}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
