import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  HardDriveIcon,
  Loader2Icon,
  RefreshCwIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'

export interface RemoteFolder {
  id: string
  name: string
}

/** Shared drives are the roots; everything else hangs off one of them. */
const ROOT_KEY = '__roots__'

interface BrowserState {
  childrenById: Record<string, RemoteFolder[]>
  loadingById: Record<string, boolean>
  errorById: Record<string, string>
  expandedById: Record<string, boolean>
}

/** Roots are already being fetched by the time the first render happens. */
const INITIAL_STATE: BrowserState = {
  childrenById: {},
  loadingById: { [ROOT_KEY]: true },
  errorById: {},
  expandedById: {},
}

/** One level of the tree. Kept free of state so effects can call it directly. */
function fetchFolders(parentId: string): Promise<RemoteFolder[]> {
  return parentId === ROOT_KEY
    ? invoke<RemoteFolder[]>('list_shared_drives')
    : invoke<RemoteFolder[]>('list_remote_folders', {
        args: { folderId: parentId },
      })
}

/**
 * Picks a Drive destination from a tree instead of a pasted URL.
 *
 * Levels load on demand: Drive costs a round trip per folder, so walking a
 * whole shared drive up front would make the dialog unusable on any real drive.
 */
export function RemoteFolderBrowser({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (folder: RemoteFolder) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* The body is unmounted while the dialog is closed, so the tree and
            the selection start fresh on every open without an effect that
            resets them. Reloading each time is deliberate too: folders get
            created between uploads, and a stale tree that quietly misses one
            is worse than a short wait. */}
        {open ? (
          <FolderTree onOpenChange={onOpenChange} onSelect={onSelect} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function FolderTree({
  onOpenChange,
  onSelect,
}: {
  onOpenChange: (open: boolean) => void
  onSelect: (folder: RemoteFolder) => void
}) {
  const [state, setState] = useState<BrowserState>(INITIAL_STATE)
  const [selected, setSelected] = useState<RemoteFolder | null>(null)

  const applyFolders = useCallback(
    (parentId: string, folders: RemoteFolder[]) =>
      setState(current => ({
        ...current,
        childrenById: { ...current.childrenById, [parentId]: folders },
        loadingById: omitKey(current.loadingById, parentId),
        errorById: omitKey(current.errorById, parentId),
      })),
    []
  )

  const applyError = useCallback((parentId: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('Failed to list Drive folders', { parentId, error: message })
    setState(current => ({
      ...current,
      loadingById: omitKey(current.loadingById, parentId),
      errorById: { ...current.errorById, [parentId]: message },
    }))
  }, [])

  // The roots start loading with the dialog. `INITIAL_STATE` already says so,
  // so nothing has to be set before the request settles.
  useEffect(() => {
    let cancelled = false
    fetchFolders(ROOT_KEY)
      .then(folders => {
        if (!cancelled) applyFolders(ROOT_KEY, folders)
      })
      .catch(error => {
        if (!cancelled) applyError(ROOT_KEY, error)
      })
    return () => {
      cancelled = true
    }
  }, [applyFolders, applyError])

  const load = useCallback(
    (parentId: string) => {
      fetchFolders(parentId)
        .then(folders => applyFolders(parentId, folders))
        .catch(error => applyError(parentId, error))
    },
    [applyFolders, applyError]
  )

  /** Marks a node as loading and fetches it. For event handlers only. */
  const reload = useCallback(
    (parentId: string) => {
      setState(current => ({
        ...current,
        loadingById: { ...current.loadingById, [parentId]: true },
        errorById: omitKey(current.errorById, parentId),
      }))
      load(parentId)
    },
    [load]
  )

  const toggle = useCallback(
    (folder: RemoteFolder) => {
      const isExpanded = Boolean(state.expandedById[folder.id])
      const needsFetch = !isExpanded && !state.childrenById[folder.id]
      setState(current => ({
        ...current,
        expandedById: { ...current.expandedById, [folder.id]: !isExpanded },
        loadingById: needsFetch
          ? { ...current.loadingById, [folder.id]: true }
          : current.loadingById,
      }))
      if (needsFetch) load(folder.id)
    },
    [load, state.childrenById, state.expandedById]
  )

  const roots = state.childrenById[ROOT_KEY]
  const rootError = state.errorById[ROOT_KEY]
  const isLoadingRoots = Boolean(state.loadingById[ROOT_KEY])

  return (
    <>
      <DialogHeader>
        <DialogTitle>Choose a destination folder</DialogTitle>
        <DialogDescription>
          Shared drives your service accounts can reach. Expand one to pick a
          folder inside it.
        </DialogDescription>
      </DialogHeader>

      <div
        className="h-72 overflow-auto rounded-md border bg-card p-1"
        role="tree"
        aria-label="Drive folders"
      >
        {isLoadingRoots ? (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Loading shared drives…
          </p>
        ) : rootError ? (
          <div className="space-y-3 px-3 py-8 text-center">
            <p className="flex items-center justify-center gap-1.5 text-sm text-status-danger">
              <AlertCircleIcon className="size-4 shrink-0" />
              Could not list shared drives
            </p>
            <p className="text-xs text-muted-foreground">{rootError}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => reload(ROOT_KEY)}
            >
              <RefreshCwIcon />
              Try again
            </Button>
          </div>
        ) : roots && roots.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            No shared drives are visible to your service accounts. Share a drive
            with them, or paste a folder link instead.
          </p>
        ) : (
          (roots ?? []).map(root => (
            <FolderNode
              key={root.id}
              folder={root}
              depth={0}
              isDrive
              state={state}
              selectedId={selected?.id ?? null}
              onToggle={toggle}
              onSelect={setSelected}
              onRetry={reload}
            />
          ))
        )}
      </div>

      <DialogFooter className="sm:items-center sm:justify-between">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {selected ? `Selected: ${selected.name}` : 'Nothing selected yet'}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!selected}
            onClick={() => {
              if (!selected) return
              onSelect(selected)
              onOpenChange(false)
            }}
          >
            Use folder
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

function FolderNode({
  folder,
  depth,
  isDrive,
  state,
  selectedId,
  onToggle,
  onSelect,
  onRetry,
}: {
  folder: RemoteFolder
  depth: number
  isDrive: boolean
  state: BrowserState
  selectedId: string | null
  onToggle: (folder: RemoteFolder) => void
  onSelect: (folder: RemoteFolder) => void
  onRetry: (parentId: string) => void
}) {
  const isExpanded = Boolean(state.expandedById[folder.id])
  const isLoading = Boolean(state.loadingById[folder.id])
  const error = state.errorById[folder.id]
  const children = state.childrenById[folder.id]
  const isSelected = selectedId === folder.id
  const Icon = isDrive ? HardDriveIcon : FolderIcon

  return (
    <div role="treeitem" aria-expanded={isExpanded} aria-selected={isSelected}>
      <div
        className={cn(
          'flex items-center gap-1 rounded px-1',
          isSelected ? 'bg-status-info/10' : 'hover:bg-accent/60'
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <button
          type="button"
          onClick={() => onToggle(folder)}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={
            isExpanded ? `Collapse ${folder.name}` : `Expand ${folder.name}`
          }
        >
          {isLoading ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : isExpanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={() => onSelect(folder)}
          onDoubleClick={() => onToggle(folder)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{folder.name}</span>
        </button>
      </div>

      {isExpanded ? (
        error ? (
          <div
            className="flex items-center gap-1.5 py-1 text-xs text-status-danger"
            style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
          >
            <AlertCircleIcon className="size-3.5 shrink-0" />
            <span className="truncate">{error}</span>
            <button
              type="button"
              onClick={() => onRetry(folder.id)}
              className="shrink-0 underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        ) : children && children.length === 0 ? (
          <p
            className="py-1 text-xs text-muted-foreground"
            style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
          >
            No subfolders
          </p>
        ) : (
          (children ?? []).map(child => (
            <FolderNode
              key={child.id}
              folder={child}
              depth={depth + 1}
              isDrive={false}
              state={state}
              selectedId={selectedId}
              onToggle={onToggle}
              onSelect={onSelect}
              onRetry={onRetry}
            />
          ))
        )
      ) : null}
    </div>
  )
}

function omitKey<T extends Record<string, unknown>>(obj: T, key: string): T {
  if (!(key in obj)) return obj
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { [key]: _removed, ...rest } = obj as any
  return rest as T
}
