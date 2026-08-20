import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  HardDriveIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatBytes } from '@/components/transfers/format'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'

export interface RemoteFolder {
  id: string
  name: string
}

/** A row of the contents pane: a folder to descend into, or a file for context. */
interface RemoteEntry extends RemoteFolder {
  isDir: boolean
  size: number | null
  modifiedAt: string | null
}

/** Shared drives are the roots; everything else hangs off one of them. */
const ROOT_KEY = '__roots__'

/** Short searches match half a drive, so they are not worth a round trip. */
const MIN_SEARCH_LENGTH = 2

/** Long enough that typing does not fire a search per keystroke. */
const SEARCH_DEBOUNCE_MS = 400

/** Matches the backend cap, so the UI can say when it was hit. */
const MAX_SEARCH_RESULTS = 200

interface TreeState {
  childrenById: Record<string, RemoteFolder[]>
  loadingById: Record<string, boolean>
  errorById: Record<string, string>
  expandedById: Record<string, boolean>
}

const INITIAL_TREE: TreeState = {
  childrenById: {},
  loadingById: { [ROOT_KEY]: true },
  errorById: {},
  expandedById: {},
}

/** Where the contents pane is pointed, and how it got there. */
interface Location {
  /** Root drive down to the open folder. Empty while nothing is open. */
  trail: RemoteFolder[]
}

interface SearchGroup {
  drive: RemoteFolder
  folders: RemoteFolder[]
  error?: string
}

interface SearchResult {
  query: string
  groups: SearchGroup[]
}

function fetchFolders(parentId: string): Promise<RemoteFolder[]> {
  return parentId === ROOT_KEY
    ? invoke<RemoteFolder[]>('list_shared_drives')
    : invoke<RemoteFolder[]>('list_remote_folders', {
        args: { folderId: parentId },
      })
}

function fetchEntries(folderId: string): Promise<RemoteEntry[]> {
  return invoke<RemoteEntry[]>('list_remote_entries', {
    args: { folderId },
  })
}

/**
 * Searches every reachable drive at once.
 *
 * Drive runs each search server-side, so this is a handful of quick calls
 * rather than a walk of the tree. One drive failing does not lose the others -
 * its own row reports why.
 */
async function searchAllDrives(
  drives: RemoteFolder[],
  query: string
): Promise<SearchGroup[]> {
  return Promise.all(
    drives.map(async drive => {
      try {
        const folders = await invoke<RemoteFolder[]>('search_remote_folders', {
          args: { driveId: drive.id, query },
        })
        return { drive, folders }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('Drive folder search failed', {
          drive: drive.name,
          error: message,
        })
        return { drive, folders: [], error: message }
      }
    })
  )
}

function formatModified(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Picks a Drive destination: a tree of drives on the left, the contents of
 * whatever is selected on the right.
 *
 * Levels load on demand. Drive costs a round trip per folder, so walking a
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
      <DialogContent className="flex h-[min(88vh,640px)] flex-col gap-3 sm:max-w-[min(94vw,1000px)]">
        {/* The body is unmounted while the dialog is closed, so the tree and
            the selection start fresh on every open without an effect that
            resets them. Reloading each time is deliberate too: folders get
            created between uploads, and a stale tree that quietly misses one
            is worse than a short wait. */}
        {open ? (
          <BrowserBody onOpenChange={onOpenChange} onSelect={onSelect} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function BrowserBody({
  onOpenChange,
  onSelect,
}: {
  onOpenChange: (open: boolean) => void
  onSelect: (folder: RemoteFolder) => void
}) {
  const [tree, setTree] = useState<TreeState>(INITIAL_TREE)
  const [location, setLocation] = useState<Location>({ trail: [] })
  const [selected, setSelected] = useState<RemoteFolder | null>(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
  const [entriesById, setEntriesById] = useState<Record<string, RemoteEntry[]>>(
    {}
  )
  const [entriesErrorById, setEntriesErrorById] = useState<
    Record<string, string>
  >({})

  const applyFolders = useCallback(
    (parentId: string, folders: RemoteFolder[]) =>
      setTree(current => ({
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
    setTree(current => ({
      ...current,
      loadingById: omitKey(current.loadingById, parentId),
      errorById: { ...current.errorById, [parentId]: message },
    }))
  }, [])

  // The roots start loading with the dialog. `INITIAL_TREE` already says so,
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

  const loadFolders = useCallback(
    (parentId: string) => {
      fetchFolders(parentId)
        .then(folders => applyFolders(parentId, folders))
        .catch(error => applyError(parentId, error))
    },
    [applyFolders, applyError]
  )

  /**
   * Loads a folder's contents for the right-hand pane.
   *
   * Cached per folder for the life of the dialog: clicking back up a trail you
   * have already walked should not re-ask Drive for the same listing.
   */
  const loadEntries = useCallback((folderId: string) => {
    fetchEntries(folderId)
      .then(entries =>
        setEntriesById(current => ({ ...current, [folderId]: entries }))
      )
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('Failed to list Drive contents', {
          folderId,
          error: message,
        })
        setEntriesErrorById(current => ({ ...current, [folderId]: message }))
      })
  }, [])

  /** Points the contents pane at a folder, loading it if it is new. */
  const openFolder = useCallback(
    (trail: RemoteFolder[]) => {
      const folder = trail[trail.length - 1]
      if (!folder) return
      setLocation({ trail })
      setSelected(folder)
      setEntriesErrorById(current => omitKey(current, folder.id))
      setEntriesById(current => {
        if (!current[folder.id]) loadEntries(folder.id)
        return current
      })
    },
    [loadEntries]
  )

  const toggleExpanded = useCallback(
    (folder: RemoteFolder) => {
      const isExpanded = Boolean(tree.expandedById[folder.id])
      const needsFetch = !isExpanded && !tree.childrenById[folder.id]
      setTree(current => ({
        ...current,
        expandedById: { ...current.expandedById, [folder.id]: !isExpanded },
        loadingById: needsFetch
          ? { ...current.loadingById, [folder.id]: true }
          : current.loadingById,
      }))
      if (needsFetch) loadFolders(folder.id)
    },
    [loadFolders, tree.childrenById, tree.expandedById]
  )

  const roots = tree.childrenById[ROOT_KEY]
  const rootError = tree.errorById[ROOT_KEY]
  const isLoadingRoots = Boolean(tree.loadingById[ROOT_KEY])

  const trimmedQuery = query.trim()
  const isSearchActive = trimmedQuery.length >= MIN_SEARCH_LENGTH
  // No separate loading flag: results carry the term they belong to, so
  // anything else means the answer for what is typed has not arrived. That
  // also makes a stale response from a previous term impossible to show.
  const isSearching = isSearchActive && searchResult?.query !== debouncedQuery

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedQuery(query.trim()),
      SEARCH_DEBOUNCE_MS
    )
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (debouncedQuery.length < MIN_SEARCH_LENGTH) return
    if (!roots || roots.length === 0) return

    let cancelled = false
    searchAllDrives(roots, debouncedQuery)
      .then(groups => {
        if (!cancelled) setSearchResult({ query: debouncedQuery, groups })
      })
      .catch(error => {
        logger.warn('Folder search failed', { error: String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [debouncedQuery, roots])

  const openFolderId = location.trail[location.trail.length - 1]?.id ?? null
  const entries = openFolderId ? entriesById[openFolderId] : undefined
  const entriesError = openFolderId ? entriesErrorById[openFolderId] : undefined

  const selectedPath = useMemo(() => {
    if (!selected) return null
    const trailIds = location.trail.map(folder => folder.id)
    // A folder picked from the contents pane is one level below the trail.
    if (trailIds.includes(selected.id)) {
      return location.trail
        .slice(0, trailIds.indexOf(selected.id) + 1)
        .map(folder => folder.name)
        .join(' / ')
    }
    return [...location.trail.map(folder => folder.name), selected.name].join(
      ' / '
    )
  }, [location.trail, selected])

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle>Choose a destination folder</DialogTitle>
        <DialogDescription>
          Shared drives your service accounts can reach. Pick a folder on either
          side, or search every drive by name.
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-2">
        <Breadcrumb trail={location.trail} onNavigate={openFolder} />

        <div className="relative w-64 shrink-0">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search folders in all drives…"
            spellCheck={false}
            autoComplete="off"
            aria-label="Search folders by name"
            disabled={!roots || roots.length === 0}
            className="h-9 px-8"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear the search"
              className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>

        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-9 shrink-0"
          aria-label="Reload"
          onClick={() => {
            if (openFolderId) {
              setEntriesById(current => omitKey(current, openFolderId))
              setEntriesErrorById(current => omitKey(current, openFolderId))
              loadEntries(openFolderId)
            }
            setTree(current => ({
              ...current,
              loadingById: { ...current.loadingById, [ROOT_KEY]: true },
              errorById: omitKey(current.errorById, ROOT_KEY),
            }))
            loadFolders(ROOT_KEY)
          }}
        >
          <RefreshCwIcon />
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr] overflow-hidden rounded-lg border bg-card">
        <div
          className="overflow-auto border-r py-1"
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
              <p className="text-xs break-words text-muted-foreground">
                {rootError}
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setTree(current => ({
                    ...current,
                    loadingById: { ...current.loadingById, [ROOT_KEY]: true },
                    errorById: omitKey(current.errorById, ROOT_KEY),
                  }))
                  loadFolders(ROOT_KEY)
                }}
              >
                <RefreshCwIcon />
                Try again
              </Button>
            </div>
          ) : roots && roots.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              No shared drives are visible to your service accounts. Share a
              drive with them, or paste a folder link instead.
            </p>
          ) : (
            (roots ?? []).map(root => (
              <TreeNode
                key={root.id}
                folder={root}
                trail={[root]}
                depth={0}
                isDrive
                tree={tree}
                selectedId={selected?.id ?? null}
                onToggle={toggleExpanded}
                onOpen={openFolder}
              />
            ))
          )}
        </div>

        {isSearchActive ? (
          <SearchResults
            isSearching={isSearching}
            result={searchResult}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
        ) : (
          <ContentsPane
            hasLocation={Boolean(openFolderId)}
            entries={entries}
            error={entriesError}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            onOpen={folder => openFolder([...location.trail, folder])}
          />
        )}
      </div>

      <DialogFooter className="sm:items-center sm:justify-between">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {selectedPath ? (
            <>
              Selected <span className="text-foreground">{selectedPath}</span>
            </>
          ) : (
            'Nothing selected yet'
          )}
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

/** Path to the open folder, each segment clickable to jump back up. */
function Breadcrumb({
  trail,
  onNavigate,
}: {
  trail: RemoteFolder[]
  onNavigate: (trail: RemoteFolder[]) => void
}) {
  return (
    <div className="flex h-9 min-w-0 flex-1 items-center gap-0.5 overflow-hidden rounded-md border border-input bg-transparent px-2 text-sm">
      {trail.length === 0 ? (
        <span className="truncate px-1 text-muted-foreground">
          Pick a drive to start
        </span>
      ) : (
        trail.map((folder, index) => (
          <span key={folder.id} className="flex min-w-0 items-center gap-0.5">
            {index > 0 ? (
              <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60" />
            ) : null}
            <button
              type="button"
              onClick={() => onNavigate(trail.slice(0, index + 1))}
              className={cn(
                'truncate rounded px-1.5 py-0.5 transition-colors hover:bg-accent',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                index === trail.length - 1
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground'
              )}
            >
              {folder.name}
            </button>
          </span>
        ))
      )}
    </div>
  )
}

/** Right-hand pane: what is inside the open folder. */
function ContentsPane({
  hasLocation,
  entries,
  error,
  selectedId,
  onSelect,
  onOpen,
}: {
  hasLocation: boolean
  entries: RemoteEntry[] | undefined
  error: string | undefined
  selectedId: string | null
  onSelect: (folder: RemoteFolder) => void
  onOpen: (folder: RemoteFolder) => void
}) {
  if (!hasLocation) {
    return (
      <p className="flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Choose a drive on the left to see what is inside it.
      </p>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="flex items-center gap-1.5 text-sm text-status-danger">
          <AlertCircleIcon className="size-4 shrink-0" />
          Could not open this folder
        </p>
        <p className="text-xs break-words text-muted-foreground">{error}</p>
      </div>
    )
  }

  if (!entries) {
    return (
      <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Loading…
      </p>
    )
  }

  if (entries.length === 0) {
    return (
      <p className="flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
        This folder is empty. You can still upload into it.
      </p>
    )
  }

  return (
    <div className="flex min-w-0 flex-col">
      <div className="grid h-8 shrink-0 grid-cols-[1fr_96px_120px] items-center gap-3 border-b bg-muted/30 px-3 text-[11px] font-medium text-muted-foreground">
        <div>Name</div>
        <div>Size</div>
        <div>Modified</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {entries.map(entry => {
          const isSelected = entry.isDir && selectedId === entry.id
          return (
            <div
              key={entry.id}
              role={entry.isDir ? 'button' : undefined}
              tabIndex={entry.isDir ? 0 : undefined}
              onClick={entry.isDir ? () => onSelect(entry) : undefined}
              onDoubleClick={entry.isDir ? () => onOpen(entry) : undefined}
              onKeyDown={
                entry.isDir
                  ? event => {
                      if (event.key === 'Enter') onOpen(entry)
                      if (event.key === ' ') {
                        event.preventDefault()
                        onSelect(entry)
                      }
                    }
                  : undefined
              }
              className={cn(
                'grid h-9 grid-cols-[1fr_96px_120px] items-center gap-3 border-b border-border/40 px-3 text-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                entry.isDir
                  ? 'cursor-pointer'
                  : // Files are context only: they show you are in the right
                    // folder, but an upload destination is always a folder.
                    'text-muted-foreground/60',
                isSelected
                  ? 'bg-status-info/10'
                  : entry.isDir && 'hover:bg-accent/60'
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                {entry.isDir ? (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileIcon className="size-4 shrink-0" />
                )}
                <span className="truncate">{entry.name}</span>
              </div>
              <div className="truncate text-xs tabular-nums text-muted-foreground">
                {entry.size === null ? '—' : formatBytes(entry.size)}
              </div>
              <div className="truncate text-xs tabular-nums text-muted-foreground">
                {formatModified(entry.modifiedAt)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Search takes over the right-hand pane while the tree stays put, so a search
 * does not cost you the place you had navigated to.
 */
function SearchResults({
  isSearching,
  result,
  selectedId,
  onSelect,
}: {
  isSearching: boolean
  result: SearchResult | null
  selectedId: string | null
  onSelect: (folder: RemoteFolder) => void
}) {
  if (isSearching && !result) {
    return (
      <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Searching every drive…
      </p>
    )
  }

  if (!result) return null

  const matches = result.groups.flatMap(group =>
    group.folders.map(folder => ({ folder, group }))
  )
  const failures = result.groups.filter(group => group.error)

  if (matches.length === 0 && failures.length === 0) {
    return (
      <p className="flex items-center justify-center px-8 text-center text-xs text-muted-foreground">
        No folders match “{result.query}”. Drive matches from the start of a
        word, so try the beginning of the name.
      </p>
    )
  }

  return (
    <div className={cn('flex min-w-0 flex-col', isSearching && 'opacity-60')}>
      <div className="grid h-8 shrink-0 grid-cols-[1fr_200px] items-center gap-3 border-b bg-muted/30 px-3 text-[11px] font-medium text-muted-foreground">
        <div>
          {matches.length} match{matches.length === 1 ? '' : 'es'} for “
          {result.query}”
        </div>
        <div>In drive</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {failures.map(group => (
          <p
            key={group.drive.id}
            className="flex items-start gap-1.5 border-b border-border/40 px-3 py-1.5 text-xs text-status-danger"
          >
            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">
              {group.drive.name}: {group.error}
            </span>
          </p>
        ))}
        {matches.map(({ folder, group }) => (
          <button
            key={`${group.drive.id}:${folder.id}`}
            type="button"
            onClick={() => onSelect(folder)}
            className={cn(
              'grid h-9 w-full grid-cols-[1fr_200px] items-center gap-3 border-b border-border/40 px-3 text-left text-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
              selectedId === folder.id
                ? 'bg-status-info/10'
                : 'hover:bg-accent/60'
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{folder.name}</span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {group.drive.name}
            </div>
          </button>
        ))}
        {result.groups.some(
          group => group.folders.length >= MAX_SEARCH_RESULTS
        ) ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Showing the first {MAX_SEARCH_RESULTS} matches per drive — narrow
            the search to see the rest.
          </p>
        ) : null}
      </div>
    </div>
  )
}

function TreeNode({
  folder,
  trail,
  depth,
  isDrive,
  tree,
  selectedId,
  onToggle,
  onOpen,
}: {
  folder: RemoteFolder
  trail: RemoteFolder[]
  depth: number
  isDrive: boolean
  tree: TreeState
  selectedId: string | null
  onToggle: (folder: RemoteFolder) => void
  onOpen: (trail: RemoteFolder[]) => void
}) {
  const isExpanded = Boolean(tree.expandedById[folder.id])
  const isLoading = Boolean(tree.loadingById[folder.id])
  const error = tree.errorById[folder.id]
  const children = tree.childrenById[folder.id]
  const isSelected = selectedId === folder.id
  const Icon = isDrive ? HardDriveIcon : FolderIcon

  return (
    <div role="treeitem" aria-expanded={isExpanded} aria-selected={isSelected}>
      <div
        className={cn(
          'flex items-center gap-1 rounded px-1',
          isSelected ? 'bg-status-info/10' : 'hover:bg-accent/60'
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
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
          onClick={() => onOpen(trail)}
          onDoubleClick={() => onToggle(folder)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{folder.name}</span>
        </button>
      </div>

      {isExpanded ? (
        error ? (
          <p
            className="py-1 pr-2 text-xs break-words text-status-danger"
            style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
          >
            {error}
          </p>
        ) : children && children.length === 0 ? (
          <p
            className="py-1 text-xs text-muted-foreground"
            style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
          >
            No subfolders
          </p>
        ) : (
          (children ?? []).map(child => (
            <TreeNode
              key={child.id}
              folder={child}
              trail={[...trail, child]}
              depth={depth + 1}
              isDrive={false}
              tree={tree}
              selectedId={selectedId}
              onToggle={onToggle}
              onOpen={onOpen}
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
