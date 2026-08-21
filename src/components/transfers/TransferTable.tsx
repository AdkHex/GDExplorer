import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
} from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { invoke } from '@tauri-apps/api/core'
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  type RowSelectionState,
  type Table,
  useReactTable,
} from '@tanstack/react-table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { usePreferences } from '@/services/preferences'
import { useTransferUiStore } from '@/store/transfer-ui-store'
import { ProgressBar } from './ProgressBar'
import { TRANSFER_STATUS, type TransferState } from './status'
import { formatBytes, formatEta, formatSpeed, type SpeedUnit } from './format'
import { cn } from '@/lib/utils'
import { extractDriveFolderId } from '@/lib/drive-url'
import {
  copyText,
  driveFileUrl,
  driveFolderUrl,
  resolveItemLinks,
} from '@/lib/drive-links'
import { RemoteFolderBrowser } from '@/components/upload/RemoteFolderBrowser'
import { PreflightDialog } from '@/components/preflight/PreflightPanel'
import { useUploadDestinationStore } from '@/store/upload-destination-store'
import { useUIStore } from '@/store/ui-store'
import { UploadHistoryBar } from './UploadHistoryBar'
import type { UploadHistoryEntry } from '@/store/upload-history-store'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import {
  BrushCleaningIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  FolderSearchIcon,
  LinkIcon,
  Loader2Icon,
  FolderSymlinkIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  UploadCloudIcon,
  XIcon,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * Column widths live in one place so the header, item rows and expanded file
 * rows can never drift apart. The fixed columns are sized to fit inside the
 * app's 1000px minimum window width with the sidebar open.
 */
const GRID_COLUMNS =
  'grid grid-cols-[28px_minmax(140px,2fr)_96px_minmax(110px,1.2fr)_88px_64px_76px_60px_52px] items-center gap-x-2.5 px-3'

function getPathName(path: string): string {
  const normalized = path.replace(/[/\\]+$/g, '')
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || normalized
}

/**
 * Files inside a folder arrive from two sources: `list_item_files` returns
 * absolute paths while rclone's progress events use paths relative to the
 * upload root. Trimming the parent prefix makes both render the same way.
 */
function displayFilePath(parentPath: string, filePath: string): string {
  const parent = parentPath.replace(/[/\\]+$/g, '')
  if (filePath.startsWith(parent)) {
    const rest = filePath.slice(parent.length).replace(/^[/\\]+/, '')
    if (rest) return rest
  }
  return filePath
}

type UploadRuntimeStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'paused'
  | 'done'
  | 'failed'

/**
 * Removing a row only drops it from the UI, so it is limited to items with no
 * rclone process behind them. Anything active has to be paused or cleared.
 */
function isRemovable(status: UploadRuntimeStatus): boolean {
  return status === 'queued' || status === 'done' || status === 'failed'
}

interface TransferRowData {
  id: string
  name: string
  path: string
  kind: 'file' | 'folder'
  status: UploadRuntimeStatus
  destinationFolderId: string | null
  destinationLabel: string | null
  uploadedToFolderId: string | null
  totalBytes: number | null
  bytesSent: number | null
  saEmail: string | null
  error: string | null
  progressPct: number
  progressState: TransferState
  statusLabel: string
  sizeLabel: string
  speedLabel: string
  etaLabel: string
}

export function TransferTable({
  isDropActive,
  onBrowse,
  onStartSelected,
  onPauseSelected,
  onRemoveSelected,
  isUploading,
}: {
  isDropActive: boolean
  onBrowse: (mode: 'files' | 'folder') => void
  onStartSelected: (itemIds: string[]) => void
  onPauseSelected: (itemIds: string[]) => void
  onRemoveSelected: (itemIds: string[]) => void
  isUploading: boolean
}) {
  const items = useLocalUploadQueue(s => s.items)
  const clear = useLocalUploadQueue(s => s.clear)
  const addItems = useLocalUploadQueue(s => s.addItems)
  const setItemsDestination = useLocalUploadQueue(s => s.setItemsDestination)
  const { data: preferences } = usePreferences()
  const speedUnit: SpeedUnit = preferences?.speedUnit ?? 'bytes'
  const destinationPresets = useMemo(
    () => preferences?.destinationPresets ?? [],
    [preferences?.destinationPresets]
  )
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [clearPending, setClearPending] = useState(false)
  // Owned by the UI store so the title bar's setup-check button can open it.
  const preflightOpen = useUIStore(s => s.preflightOpen)
  const setPreflightOpen = useUIStore(s => s.setPreflightOpen)
  // Rows awaiting an arbitrary destination from the paste dialog.
  const [customDestinationTargets, setCustomDestinationTargets] = useState<
    string[] | null
  >(null)

  const clearRemoved = useTransferUiStore(s => s.clearRemoved)
  const tick = useTransferUiStore(s => s.tick)

  const paused = useTransferUiStore(s => s.pausedById)
  const metrics = useTransferUiStore(s => s.metricsById)
  const fileProgressById = useTransferUiStore(s => s.fileProgressById)
  const fileOrderById = useTransferUiStore(s => s.fileOrderById)
  const fileMetricsById = useTransferUiStore(s => s.fileMetricsById)
  const recordFileList = useTransferUiStore(s => s.recordFileList)
  const setItemLinks = useTransferUiStore(s => s.setItemLinks)
  const globalDestinationId = useUploadDestinationStore(
    s => s.destinationFolderId
  )
  const listRequestRef = useRef<Record<string, boolean>>({})

  /**
   * Drive IDs are looked up on demand and cached, rather than tracked through
   * the upload: rclone never reports the IDs it creates, so there is nothing to
   * capture while a transfer runs.
   *
   * A lookup that found nothing is never cached. "Nothing in Drive yet" is a
   * fact about the moment it was asked, not about the item - caching it meant
   * one click while a folder was still being created left that row without a
   * link for the rest of the session, long after the upload had finished.
   */
  const ensureLinks = useCallback(
    async (row: TransferRowData, options?: { refresh?: boolean }) => {
      // Read the cache from the store instead of subscribing, for the same
      // reason as `toggleExpanded`: this callback feeds the column definitions,
      // so any dependency that changes mid-upload remounts every cell.
      const cached = useTransferUiStore.getState().linksById[row.id]
      const hasCachedLinks =
        cached && (cached.folderId || Object.keys(cached.files).length > 0)
      if (hasCachedLinks && !options?.refresh) return cached

      // Where the item actually went wins over where a new upload would go:
      // the sidebar destination may have changed since this row ran.
      const destination =
        row.uploadedToFolderId ?? row.destinationFolderId ?? globalDestinationId
      if (!destination) {
        throw new Error('This item has no destination folder yet.')
      }

      const links = await resolveItemLinks(row.path, row.kind, destination)
      const files: Record<string, string> = {}
      for (const entry of links.files) files[entry.filePath] = entry.fileId
      const resolved = { folderId: links.folderId, files }
      if (resolved.folderId || Object.keys(files).length > 0) {
        setItemLinks(row.id, resolved)
      }
      return resolved
    },
    [globalDestinationId, setItemLinks]
  )

  const copyItemLink = useCallback(
    async (row: TransferRowData) => {
      try {
        const links = await ensureLinks(row)
        const firstFileId = Object.values(links.files)[0]
        const url =
          row.kind === 'folder'
            ? links.folderId
              ? driveFolderUrl(links.folderId)
              : null
            : firstFileId
              ? driveFileUrl(firstFileId)
              : null
        if (!url) {
          toast.message('No link yet', {
            description:
              row.kind === 'folder'
                ? 'The folder has not been created in Drive yet.'
                : 'The file finishes uploading before it gets a link.',
          })
          return
        }
        await copyText(url)
        toast.success('Link copied', { description: row.name })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('copy link failed', { error: message })
        toast.error('Could not copy the link', { description: message })
      }
    },
    [ensureLinks]
  )

  const copyFileLink = useCallback(
    async (row: TransferRowData, filePath: string) => {
      try {
        const links = await ensureLinks(row)
        // A folder resolved mid-upload only lists the files that had arrived by
        // then, so a miss is worth one fresh look before saying no.
        const fileId =
          links.files[filePath] ??
          (await ensureLinks(row, { refresh: true })).files[filePath]
        if (!fileId) {
          toast.message('No link yet', {
            description: 'This file has not finished uploading.',
          })
          return
        }
        await copyText(driveFileUrl(fileId))
        toast.success('Link copied', { description: filePath })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('copy file link failed', { error: message })
        toast.error('Could not copy the link', { description: message })
      }
    },
    [ensureLinks]
  )

  const rows = useMemo((): TransferRowData[] => {
    return items.map(item => {
      const runtime = (item.status ?? 'queued') as UploadRuntimeStatus
      const rowPaused = Boolean(paused[item.id])
      const rowMetrics = metrics[item.id]

      const total =
        typeof item.totalBytes === 'number' && item.totalBytes > 0
          ? item.totalBytes
          : 0
      const sent =
        typeof item.bytesSent === 'number' && item.bytesSent > 0
          ? item.bytesSent
          : 0

      const progressState: TransferState =
        runtime === 'done'
          ? 'completed'
          : runtime === 'failed'
            ? 'failed'
            : runtime === 'paused'
              ? 'paused'
              : rowPaused
                ? 'paused'
                : runtime === 'uploading' || runtime === 'preparing'
                  ? 'uploading'
                  : 'queued'

      const rawPct = total > 0 ? (Math.min(sent, total) / total) * 100 : 0
      const progressPct =
        progressState === 'completed' ? 100 : Math.min(99.9, rawPct)

      const statusLabel =
        runtime === 'preparing' && progressState === 'uploading'
          ? 'Preparing'
          : TRANSFER_STATUS[progressState].label

      // A paused transfer has no meaningful rate, so both columns read as "no
      // value" rather than the previous "0 B/s" and "∞".
      const speedLabel =
        progressState === 'uploading'
          ? formatSpeed(rowMetrics?.speedBytesPerSec ?? 0, speedUnit)
          : '—'

      const etaLabel =
        progressState === 'uploading'
          ? formatEta(rowMetrics?.etaSeconds ?? null)
          : '—'

      const sizeLabel = total > 0 ? formatBytes(total) : '—'

      return {
        id: item.id,
        name: getPathName(item.path),
        path: item.path,
        kind: item.kind,
        status: runtime,
        destinationFolderId: item.destinationFolderId ?? null,
        destinationLabel: item.destinationLabel ?? null,
        uploadedToFolderId: item.uploadedToFolderId ?? null,
        totalBytes: item.totalBytes ?? null,
        bytesSent: item.bytesSent ?? null,
        saEmail: item.saEmail ?? null,
        error: item.message ?? null,
        progressPct,
        progressState,
        statusLabel,
        sizeLabel,
        speedLabel,
        etaLabel,
      }
    })
  }, [items, metrics, paused, speedUnit])

  // `items` gets a new identity on every progress event. Effects that only care
  // about which rows exist key off `itemIdsKey` instead, and the metrics timer
  // reads through a ref - otherwise the 500ms interval was torn down and
  // recreated on every event and rarely lived long enough to fire.
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  // Concatenating ids with no separator let different queues collapse to the
  // same key (['ab','c'] and ['a','bc'] both give 'abc'), so the cleanup
  // effects below could miss a change. JSON encoding is unambiguous.
  const itemIdsKey = useMemo(
    () => JSON.stringify(items.map(i => i.id)),
    [items]
  )

  useEffect(() => {
    clearRemoved(itemsRef.current.map(i => i.id))
  }, [clearRemoved, itemIdsKey])

  useEffect(() => {
    const interval = setInterval(() => {
      tick(
        itemsRef.current.map(i => ({
          id: i.id,
          status: i.status ?? 'queued',
          bytesSent: i.bytesSent ?? 0,
          totalBytes: i.totalBytes ?? 0,
        }))
      )
    }, 500)
    return () => clearInterval(interval)
  }, [tick])

  const hasAny = items.length > 0
  const hasCompleted = items.some(i => i.status === 'done')

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  // Read through a ref inside cell renderers: keeping `rowSelection` out of the
  // column deps means changing the selection does not remount every cell.
  const rowSelectionRef = useRef(rowSelection)
  useEffect(() => {
    rowSelectionRef.current = rowSelection
  }, [rowSelection])

  // The host re-renders on every progress event and rebuilds its handlers, so
  // these props change identity constantly. Calling them through a ref keeps
  // them out of the column deps and stops that churn remounting the cells.
  const onRemoveSelectedRef = useRef(onRemoveSelected)
  useEffect(() => {
    onRemoveSelectedRef.current = onRemoveSelected
  }, [onRemoveSelected])
  const removeSelected = useCallback(
    (itemIds: string[]) => onRemoveSelectedRef.current(itemIds),
    []
  )
  const lastIndexRef = useRef<number | null>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const valid = new Set(itemsRef.current.map(i => i.id))
    setRowSelection(prev => {
      let changed = false
      const next: RowSelectionState = {}
      for (const [id, v] of Object.entries(prev)) {
        if (v && valid.has(id)) next[id] = true
        else changed = true
      }
      return changed ? next : prev
    })
  }, [itemIdsKey])

  useEffect(() => {
    const valid = new Set(
      itemsRef.current
        .filter(item => item.kind === 'folder')
        .map(item => item.id)
    )
    setExpandedById(prev => {
      let changed = false
      const next: Record<string, boolean> = {}
      for (const [id, v] of Object.entries(prev)) {
        if (v && valid.has(id)) next[id] = v
        else changed = true
      }
      return changed ? next : prev
    })
  }, [itemIdsKey])

  const toggleExpanded = useCallback(
    (item: TransferRowData) => {
      const isExpanded = Boolean(expandedById[item.id])
      // Only claim the in-flight slot when a fetch actually starts. Claiming it
      // unconditionally meant a first expand that already had data blocked
      // every later fetch.
      //
      // Read the file list straight from the store rather than subscribing to
      // it: per-file progress rewrites `fileOrderById` several times a second
      // during an upload, and depending on it here rebuilt the columns and
      // remounted every cell, closing any open destination menu.
      const { fileOrderById: currentFileOrder } = useTransferUiStore.getState()
      const alreadyListed = (currentFileOrder[item.id]?.length ?? 0) > 0
      if (!isExpanded && !listRequestRef.current[item.id] && !alreadyListed) {
        listRequestRef.current[item.id] = true
        invoke<{ filePath: string; totalBytes: number }[]>('list_item_files', {
          path: item.path,
          kind: 'folder',
        })
          .then(files => {
            recordFileList(
              item.id,
              files.map(file => ({
                filePath: file.filePath,
                bytesSent: 0,
                totalBytes: file.totalBytes,
              }))
            )
          })
          .catch(() => {
            listRequestRef.current[item.id] = false
          })
      }
      setExpandedById(prev => ({ ...prev, [item.id]: !isExpanded }))
    },
    [expandedById, recordFileList]
  )

  /**
   * Copies every resolvable link for the chosen rows, one per line: the folder
   * link for a folder, then a line per file inside it.
   */
  const copyAllLinks = useCallback(
    async (targets: TransferRowData[]) => {
      if (targets.length === 0) return
      const lines: string[] = []
      const failures: string[] = []

      for (const row of targets) {
        try {
          const links = await ensureLinks(row)
          if (links.folderId) {
            lines.push(`${row.name}\t${driveFolderUrl(links.folderId)}`)
          }
          for (const [filePath, fileId] of Object.entries(links.files)) {
            const label =
              row.kind === 'folder' ? `${row.name}/${filePath}` : row.name
            lines.push(`${label}\t${driveFileUrl(fileId)}`)
          }
        } catch (error) {
          failures.push(row.name)
          logger.warn('copy all links: item failed', {
            item: row.name,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      if (lines.length === 0) {
        toast.message('No links yet', {
          description: 'Nothing in the selection has reached Drive.',
        })
        return
      }

      await copyText(lines.join('\n'))
      toast.success(
        `Copied ${lines.length} link${lines.length === 1 ? '' : 's'}`,
        {
          description:
            failures.length > 0
              ? `${failures.length} item(s) could not be resolved.`
              : undefined,
        }
      )
    },
    [ensureLinks]
  )

  /**
   * Re-queues a past upload. `addItems` keys on path and skips duplicates, so
   * an item still in the list is revealed rather than added twice.
   */
  const handleUploadAgain = useCallback(
    (entry: UploadHistoryEntry) => {
      const alreadyQueued = items.some(item => item.path === entry.path)
      if (alreadyQueued) {
        toast.message('Already in the queue', { description: entry.name })
        return
      }

      addItems([{ path: entry.path, kind: entry.kind }])
      // Pin it back to the folder it originally went to; the sidebar
      // destination may point somewhere else now.
      if (entry.destinationFolderId) {
        setItemsDestination(
          [entry.path],
          entry.destinationFolderId,
          entry.destinationLabel
        )
      }
      toast.success('Added to the queue', { description: entry.name })
    },
    [addItems, items, setItemsDestination]
  )

  // `flexRender` turns each `cell` function into a component, so React compares
  // them by identity. Rebuilding this array on every render handed React a new
  // component type each time and it unmounted and remounted every cell. During
  // an upload the table re-renders on each progress event, which tore the
  // destination menu down milliseconds after it opened. Keeping the identity
  // stable keeps open menus alive.
  const columns = useMemo<ColumnDef<TransferRowData>[]>(
    () => [
      {
        id: 'select',
        header: ({ table }: { table: Table<TransferRowData> }) => (
          <Checkbox
            checked={
              table.getIsAllRowsSelected()
                ? true
                : table.getIsSomeRowsSelected()
                  ? 'indeterminate'
                  : false
            }
            onCheckedChange={value =>
              table.toggleAllRowsSelected(value === true)
            }
            onClick={event => event.stopPropagation()}
            aria-label="Select all transfers"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={value => row.toggleSelected(value === true)}
            onClick={event => event.stopPropagation()}
            aria-label={`Select ${row.original.name}`}
          />
        ),
      },
      {
        header: 'Name',
        accessorKey: 'name',
        cell: ({ row }) => {
          const item = row.original
          const isExpanded = Boolean(expandedById[item.id])
          return (
            <div className="flex min-w-0 items-center gap-1.5">
              {item.kind === 'folder' ? (
                <button
                  type="button"
                  onClick={event => {
                    // Disclosure is navigation, not selection - expanding a
                    // folder used to wipe an existing multi-row selection.
                    event.stopPropagation()
                    toggleExpanded(item)
                  }}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  aria-expanded={isExpanded}
                  aria-label={
                    isExpanded ? `Collapse ${item.name}` : `Expand ${item.name}`
                  }
                >
                  {isExpanded ? (
                    <ChevronDownIcon className="size-3.5" />
                  ) : (
                    <ChevronRightIcon className="size-3.5" />
                  )}
                </button>
              ) : (
                <span className="size-5 shrink-0" aria-hidden="true" />
              )}
              {item.kind === 'folder' ? (
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              {/* Names are truncated, and the service account actually used
                  was previously tracked but never shown anywhere. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="truncate font-medium">{item.name}</div>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start">
                  <div className="max-w-[520px] space-y-1 text-xs">
                    <div className="break-all">{item.path}</div>
                    {item.saEmail ? (
                      <div className="break-all opacity-80">
                        Service account: {item.saEmail}
                      </div>
                    ) : null}
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          )
        },
      },
      {
        id: 'destination',
        header: 'Destination',
        cell: ({ row }) => (
          <DestinationCell
            item={row.original}
            presets={destinationPresets}
            onPick={(folderId, label) => {
              // Changing the destination of a row that is part of the current
              // selection applies to the whole selection, which is what you
              // want after selecting five folders that share a target.
              const selected = rowSelectionRef.current
              const ids = row.getIsSelected()
                ? Object.keys(selected).filter(id => selected[id])
                : [row.original.id]
              setItemsDestination(ids, folderId, label)
            }}
            onPickCustom={() => {
              const selected = rowSelectionRef.current
              const ids = row.getIsSelected()
                ? Object.keys(selected).filter(id => selected[id])
                : [row.original.id]
              setCustomDestinationTargets(ids)
            }}
          />
        ),
      },
      {
        header: 'Progress',
        accessorKey: 'progressPct',
        cell: ({ row }) => (
          <ProgressBar
            percent={row.original.progressPct}
            state={row.original.progressState}
            label={`${row.original.name} progress`}
          />
        ),
      },
      {
        header: 'Status',
        accessorKey: 'statusLabel',
        cell: ({ row }) => <StatusCell item={row.original} />,
      },
      {
        header: 'Size',
        accessorKey: 'sizeLabel',
        cell: ({ row }) => (
          <div className="truncate text-xs tabular-nums text-muted-foreground">
            {row.original.sizeLabel}
          </div>
        ),
      },
      {
        header: 'Speed',
        accessorKey: 'speedLabel',
        cell: ({ row }) => (
          <div className="truncate text-xs tabular-nums text-muted-foreground">
            {row.original.speedLabel}
          </div>
        ),
      },
      {
        header: 'ETA',
        accessorKey: 'etaLabel',
        cell: ({ row }) => (
          <div className="truncate text-xs tabular-nums text-muted-foreground">
            {row.original.etaLabel}
          </div>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const item = row.original
          const removable = isRemovable(item.status)
          // A folder exists in Drive as soon as rclone starts writing into it,
          // so its link is available mid-upload. A single file only gets one
          // once it has finished.
          const canCopyLink =
            item.kind === 'folder'
              ? item.status === 'uploading' ||
                item.status === 'paused' ||
                item.status === 'done'
              : item.status === 'done'
          return (
            <div className="flex items-center gap-0.5">
              {canCopyLink ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation()
                        void copyItemLink(item)
                      }}
                      className={cn(
                        'flex size-5 items-center justify-center rounded text-muted-foreground transition-colors',
                        'hover:bg-accent hover:text-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
                      )}
                      aria-label={`Copy Drive link for ${item.name}`}
                    >
                      <LinkIcon className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">Copy Drive link</TooltipContent>
                </Tooltip>
              ) : (
                <span className="size-5" aria-hidden="true" />
              )}
              {removable ? (
                <RemoveButton item={item} onRemove={removeSelected} />
              ) : null}
            </div>
          )
        },
      },
    ],
    [
      expandedById,
      toggleExpanded,
      destinationPresets,
      setItemsDestination,
      copyItemLink,
      removeSelected,
    ]
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { rowSelection },
    getRowId: row => row.id,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
  })

  const selectedIds = useMemo(
    () => Object.keys(rowSelection).filter(id => rowSelection[id]),
    [rowSelection]
  )

  /**
   * An empty selection used to leave Start and Pause permanently disabled with
   * no explanation. Acting on the whole queue instead is the obvious intent;
   * the button tooltips spell out which of the two scopes is in effect.
   */
  const targetRows = useMemo(
    () =>
      selectedIds.length > 0
        ? rows.filter(row => selectedIds.includes(row.id))
        : rows,
    [rows, selectedIds]
  )

  // 'failed' is startable so Start doubles as retry.
  const startTargets = useMemo(
    () =>
      targetRows.filter(
        row =>
          row.status === 'queued' ||
          row.status === 'paused' ||
          row.status === 'failed'
      ),
    [targetRows]
  )
  const pauseTargets = useMemo(
    () =>
      targetRows.filter(
        row => row.status === 'uploading' || row.status === 'preparing'
      ),
    [targetRows]
  )
  const removableSelected = useMemo(
    () =>
      rows.filter(
        row => selectedIds.includes(row.id) && isRemovable(row.status)
      ),
    [rows, selectedIds]
  )

  const isResume =
    startTargets.length > 0 &&
    startTargets.every(row => row.status === 'paused')
  const startLabel = isResume ? 'Resume' : 'Start'
  const startScope =
    selectedIds.length > 0
      ? `${startTargets.length} selected`
      : `all ${startTargets.length}`

  const focusRow = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, index))
      const target = rows[clamped]
      if (!target) return
      setFocusedIndex(clamped)
      rowRefs.current[target.id]?.focus()
    },
    [rows]
  )

  const handleRowClick = (rowId: string, rowIndex: number, e: MouseEvent) => {
    const isToggle = e.metaKey || e.ctrlKey
    const isRange = e.shiftKey

    if (isRange && lastIndexRef.current !== null) {
      const start = Math.min(lastIndexRef.current, rowIndex)
      const end = Math.max(lastIndexRef.current, rowIndex)
      const next: RowSelectionState = isToggle ? { ...rowSelection } : {}
      const all = table.getRowModel().rows
      for (let i = start; i <= end; i++) {
        const id = all[i]?.id
        if (id) next[id] = true
      }
      setRowSelection(next)
      setFocusedIndex(rowIndex)
      return
    }

    lastIndexRef.current = rowIndex
    setFocusedIndex(rowIndex)
    if (isToggle) {
      setRowSelection(prev => ({ ...prev, [rowId]: !prev[rowId] }))
      return
    }

    setRowSelection({ [rowId]: true })
  }

  const handleRowKeyDown = (
    rowId: string,
    rowIndex: number,
    e: KeyboardEvent
  ) => {
    const target = rows[rowIndex]

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = rows[Math.min(rows.length - 1, rowIndex + 1)]
        focusRow(rowIndex + 1)
        if (next && !e.shiftKey) {
          lastIndexRef.current = rowIndex + 1
          setRowSelection({ [next.id]: true })
        }
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prev = rows[Math.max(0, rowIndex - 1)]
        focusRow(rowIndex - 1)
        if (prev && !e.shiftKey) {
          lastIndexRef.current = rowIndex - 1
          setRowSelection({ [prev.id]: true })
        }
        break
      }
      case 'Enter':
      case ' ':
        e.preventDefault()
        lastIndexRef.current = rowIndex
        setRowSelection(prev => ({ ...prev, [rowId]: !prev[rowId] }))
        break
      case 'a':
      case 'A':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault()
          table.toggleAllRowsSelected(true)
        }
        break
      case 'Backspace':
      case 'Delete':
        e.preventDefault()
        if (target && isRemovable(target.status)) onRemoveSelected([target.id])
        break
      case 'ArrowRight':
        if (target?.kind === 'folder' && !expandedById[target.id]) {
          e.preventDefault()
          toggleExpanded(target)
        }
        break
      case 'ArrowLeft':
        if (target?.kind === 'folder' && expandedById[target.id]) {
          e.preventDefault()
          toggleExpanded(target)
        }
        break
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-sm font-semibold">Transfers</h2>
          <span className="truncate text-xs tabular-nums text-muted-foreground">
            {hasAny
              ? selectedIds.length > 0
                ? `${selectedIds.length} of ${items.length} selected`
                : `${items.length} ${items.length === 1 ? 'item' : 'items'}`
              : 'Empty'}
          </span>
        </div>

        {/* One prominent button per HIG guidance: Start carries the accent,
            everything else is secondary or tucked into the overflow menu. */}
        <div className="flex items-center gap-2">
          {/* Clearing finished transfers is the natural counterpart to adding
              them, so it sits beside Add instead of only in the overflow. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={!hasCompleted}
                  onClick={() =>
                    onRemoveSelected(
                      rows.filter(r => r.status === 'done').map(r => r.id)
                    )
                  }
                  aria-label="Clear completed"
                >
                  <BrushCleaningIcon />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {hasCompleted ? 'Clear completed' : 'No completed transfers'}
            </TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <PlusIcon />
                Add
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onBrowse('files')}>
                <FilePlusIcon />
                Add Files…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onBrowse('folder')}>
                <FolderPlusIcon />
                Add Folders…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => onPauseSelected(pauseTargets.map(r => r.id))}
                  disabled={pauseTargets.length === 0 || !isUploading}
                >
                  <PauseIcon />
                  Pause
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {pauseTargets.length === 0 || !isUploading
                ? 'Nothing is uploading'
                : `Pause ${pauseTargets.length} ${
                    pauseTargets.length === 1 ? 'transfer' : 'transfers'
                  }`}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onStartSelected(startTargets.map(r => r.id))}
                  disabled={startTargets.length === 0}
                >
                  <PlayIcon />
                  {startLabel}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {startTargets.length === 0
                ? 'Nothing left to start'
                : `${startLabel} ${startScope}`}
            </TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="More actions"
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!hasAny}
                onSelect={() => {
                  const targets =
                    selectedIds.length > 0
                      ? rows.filter(r => selectedIds.includes(r.id))
                      : rows
                  void copyAllLinks(targets)
                }}
              >
                <LinkIcon />
                Copy all links
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={removableSelected.length === 0}
                onSelect={() =>
                  onRemoveSelected(removableSelected.map(r => r.id))
                }
              >
                Remove selected
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={!hasAny}
                onSelect={() => setClearDialogOpen(true)}
              >
                Clear all…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog
        open={clearDialogOpen}
        onOpenChange={open => !clearPending && setClearDialogOpen(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all transfers?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops any upload in progress and empties the list. Files
              already uploaded to Drive are not removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={clearPending}
              onClick={async () => {
                setClearPending(true)
                try {
                  await invoke('cancel_upload')
                } catch {
                  // ignore; UI state still clears
                } finally {
                  clear()
                  setClearPending(false)
                  setClearDialogOpen(false)
                }
              }}
            >
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PreflightDialog open={preflightOpen} onOpenChange={setPreflightOpen} />

      <CustomDestinationDialog
        open={customDestinationTargets !== null}
        onOpenChange={open => {
          if (!open) setCustomDestinationTargets(null)
        }}
        onConfirm={(folderId, label) => {
          if (customDestinationTargets) {
            setItemsDestination(customDestinationTargets, folderId, label)
          }
          setCustomDestinationTargets(null)
        }}
      />

      <UploadHistoryBar onUploadAgain={handleUploadAgain} />

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-card">
        <div className="h-full overflow-auto">
          <div role="treegrid" aria-label="Transfers" aria-multiselectable>
            <div role="rowgroup">
              <div
                className={cn(
                  GRID_COLUMNS,
                  'sticky top-0 z-10 h-8 border-b bg-card/95 text-[11px] font-medium text-muted-foreground backdrop-blur'
                )}
                role="row"
              >
                {table.getHeaderGroups().map(headerGroup =>
                  headerGroup.headers.map(header => (
                    <div
                      key={header.id}
                      role="columnheader"
                      className="min-w-0 truncate"
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {rows.length > 0 ? (
              <div role="rowgroup">
                {table.getRowModel().rows.map(row => {
                  const item = row.original
                  const isExpanded = Boolean(expandedById[item.id])
                  const fileOrder = fileOrderById[item.id] ?? []
                  const fileProgress = fileProgressById[item.id] ?? {}
                  const fileMetrics = fileMetricsById[item.id] ?? {}
                  const isSelected = row.getIsSelected()

                  return (
                    <Fragment key={row.id}>
                      <div
                        ref={element => {
                          rowRefs.current[item.id] = element
                        }}
                        role="row"
                        aria-level={1}
                        aria-selected={isSelected}
                        aria-expanded={
                          item.kind === 'folder' ? isExpanded : undefined
                        }
                        tabIndex={row.index === focusedIndex ? 0 : -1}
                        onClick={e => handleRowClick(row.id, row.index, e)}
                        onKeyDown={e => handleRowKeyDown(row.id, row.index, e)}
                        className={cn(
                          GRID_COLUMNS,
                          'group h-11 border-b border-border/60 text-sm transition-colors',
                          'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                          isSelected
                            ? 'bg-status-info/10'
                            : 'hover:bg-accent/60'
                        )}
                      >
                        {row.getVisibleCells().map(cell => (
                          <div
                            key={cell.id}
                            role="gridcell"
                            className="min-w-0"
                          >
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext()
                            )}
                          </div>
                        ))}
                      </div>

                      {item.kind === 'folder' && isExpanded ? (
                        fileOrder.length > 0 ? (
                          fileOrder.map(filePath => (
                            <FileRow
                              key={`${item.id}:${filePath}`}
                              name={displayFilePath(item.path, filePath)}
                              parentState={item.progressState}
                              progress={fileProgress[filePath]}
                              metrics={fileMetrics[filePath]}
                              speedUnit={speedUnit}
                              onCopyLink={() =>
                                void copyFileLink(
                                  item,
                                  displayFilePath(item.path, filePath)
                                )
                              }
                            />
                          ))
                        ) : (
                          <div
                            role="row"
                            aria-level={2}
                            className={cn(
                              GRID_COLUMNS,
                              'h-9 border-b border-border/40 bg-muted/25 text-xs text-muted-foreground'
                            )}
                          >
                            <div role="gridcell" aria-hidden="true" />
                            <div role="gridcell" className="min-w-0">
                              <div className="flex items-center gap-1.5 pl-6">
                                <Loader2Icon className="size-3.5 animate-spin" />
                                Reading folder…
                              </div>
                            </div>
                            {/* Pad to the full column count so every row in the
                                grid exposes the same number of cells. */}
                            {Array.from({ length: 7 }, (_, index) => (
                              <div
                                key={index}
                                role="gridcell"
                                aria-hidden="true"
                              />
                            ))}
                          </div>
                        )
                      ) : null}
                    </Fragment>
                  )
                })}
              </div>
            ) : (
              <EmptyState onBrowse={onBrowse} />
            )}
          </div>
        </div>

        {isDropActive ? <DropOverlay /> : null}
      </div>
    </div>
  )
}

function FileRow({
  name,
  parentState,
  progress,
  metrics,
  speedUnit,
  onCopyLink,
}: {
  name: string
  parentState: TransferState
  progress?: { bytesSent: number; totalBytes: number }
  metrics?: { speedBytesPerSec: number; etaSeconds: number | null }
  speedUnit: SpeedUnit
  onCopyLink: () => void
}) {
  const total =
    typeof progress?.totalBytes === 'number' ? progress.totalBytes : 0
  const sent = typeof progress?.bytesSent === 'number' ? progress.bytesSent : 0
  const percent = total > 0 ? (Math.min(sent, total) / total) * 100 : 0
  const isCompleted = total > 0 && sent >= total

  const progressState: TransferState =
    parentState === 'failed'
      ? 'failed'
      : parentState === 'paused'
        ? 'paused'
        : isCompleted
          ? 'completed'
          : sent > 0 || parentState === 'uploading'
            ? 'uploading'
            : 'queued'

  const status = TRANSFER_STATUS[progressState]
  const isActive = progressState === 'uploading'

  return (
    <div
      role="row"
      aria-level={2}
      className={cn(
        GRID_COLUMNS,
        'h-9 border-b border-border/40 bg-muted/25 text-xs'
      )}
    >
      <div role="gridcell" aria-hidden="true" />
      <div role="gridcell" className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5 pl-6 text-muted-foreground">
          <FileIcon className="size-3.5 shrink-0" />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="truncate">{name}</div>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              <div className="max-w-[420px] break-all text-xs">{name}</div>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div role="gridcell" aria-hidden="true" />
      <div role="gridcell" className="min-w-0">
        <ProgressBar
          percent={percent}
          state={progressState}
          label={`${name} progress`}
        />
      </div>
      <div role="gridcell" className="min-w-0">
        <div className={cn('flex items-center gap-1 truncate', status.text)}>
          <status.Icon className="size-3 shrink-0" />
          <span className="truncate">{status.label}</span>
        </div>
      </div>
      <div
        role="gridcell"
        className="truncate tabular-nums text-muted-foreground"
      >
        {total > 0 ? formatBytes(total) : '—'}
      </div>
      <div
        role="gridcell"
        className="truncate tabular-nums text-muted-foreground"
      >
        {isActive
          ? formatSpeed(metrics?.speedBytesPerSec ?? 0, speedUnit)
          : '—'}
      </div>
      <div
        role="gridcell"
        className="truncate tabular-nums text-muted-foreground"
      >
        {isActive ? formatEta(metrics?.etaSeconds ?? null) : '—'}
      </div>
      <div role="gridcell">
        {/* A file inside a folder only has a Drive link once it has finished. */}
        {progressState === 'completed' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation()
                  onCopyLink()
                }}
                className={cn(
                  'flex size-5 items-center justify-center rounded text-muted-foreground transition-colors',
                  'hover:bg-accent hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
                )}
                aria-label={`Copy Drive link for ${name}`}
              >
                <LinkIcon className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Copy file link</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Per-row destination. A row with no override follows the sidebar, which keeps
 * the common case (everything to one folder) free of per-row fiddling while
 * still allowing five folders to target five different Drives.
 *
 * The trigger deliberately has no Tooltip wrapper. `TooltipTrigger asChild`
 * around `DropdownMenuTrigger asChild` makes the tooltip win the prop merge and
 * replace the dropdown's pointer handler, so the button kept its ARIA
 * attributes but the menu never opened.
 */
function DestinationCell({
  item,
  presets,
  onPick,
  onPickCustom,
}: {
  item: TransferRowData
  presets: { id: string; name: string; url: string }[]
  onPick: (folderId: string | null, label: string | null) => void
  onPickCustom: () => void
}) {
  const label =
    item.destinationLabel ?? (item.destinationFolderId ? 'Custom' : 'Default')
  const isPinned = item.destinationFolderId !== null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={event => event.stopPropagation()}
          title={
            isPinned
              ? `Uploads to ${label}`
              : 'Follows the destination in the sidebar'
          }
          className={cn(
            'flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs transition-colors',
            'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            isPinned ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          <FolderSymlinkIcon className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="ml-auto size-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onPick(null, null)}>
          Use sidebar destination
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {presets.map(preset => {
          const folderId = extractDriveFolderId(preset.url)
          if (!folderId) return null
          return (
            <DropdownMenuItem
              key={preset.id}
              onSelect={() => onPick(folderId, preset.name)}
            >
              {preset.name}
            </DropdownMenuItem>
          )
        })}
        {presets.length > 0 ? <DropdownMenuSeparator /> : null}
        {/* Saved presets alone are not enough: sending five folders to five
            different places only works if any folder can be chosen. */}
        <DropdownMenuItem onSelect={onPickCustom}>
          Choose another folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Prompts for an arbitrary Drive folder to pin onto the selected rows. */
function CustomDestinationDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (folderId: string, label: string) => void
}) {
  const [value, setValue] = useState('')
  // Only set when the folder came from the browser, which is the one case
  // where its real name is known - a pasted URL carries no name.
  const [pickedName, setPickedName] = useState<string | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const folderId = extractDriveFolderId(value)
  const isInvalid = value.trim().length > 0 && !folderId

  // Clearing on close happens in the event handler rather than an effect;
  // setState inside an effect body just triggers a cascading render.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setValue('')
      setPickedName(null)
    }
    onOpenChange(next)
  }

  const confirm = () => {
    if (!folderId) return
    onConfirm(folderId, pickedName ?? 'Custom')
    handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Destination for the selected items</DialogTitle>
          <DialogDescription>
            Browse your shared drives, or paste a Drive folder link or ID. It
            applies only to the rows you picked, so other rows keep their own
            destination.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={value}
            onChange={event => {
              setValue(event.target.value)
              setPickedName(null)
            }}
            placeholder="https://drive.google.com/drive/folders/…"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={isInvalid}
            aria-label="Destination folder link or ID"
            onKeyDown={event => {
              if (event.key === 'Enter') confirm()
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => setBrowserOpen(true)}
          >
            <FolderSearchIcon />
            Browse
          </Button>
        </div>
        {isInvalid ? (
          <p className="text-xs text-status-danger">Not a Drive folder link</p>
        ) : pickedName ? (
          <p className="text-xs text-muted-foreground">
            Uploads into {pickedName}
          </p>
        ) : null}
        <RemoteFolderBrowser
          open={browserOpen}
          onOpenChange={setBrowserOpen}
          onSelect={folder => {
            setValue(driveFolderUrl(folder.id))
            setPickedName(folder.name)
          }}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!folderId} onClick={confirm}>
            Use folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RemoveButton({
  item,
  onRemove,
}: {
  item: TransferRowData
  onRemove: (itemIds: string[]) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={event => {
            event.stopPropagation()
            onRemove([item.id])
          }}
          className={cn(
            'flex size-5 items-center justify-center rounded text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-foreground',
            'opacity-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            'group-hover:opacity-100 group-focus-within:opacity-100'
          )}
          aria-label={`Remove ${item.name} from the queue`}
        >
          <XIcon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">Remove from queue</TooltipContent>
    </Tooltip>
  )
}

function StatusCell({ item }: { item: TransferRowData }) {
  const status = TRANSFER_STATUS[item.progressState]
  // Status is conveyed by icon plus text, not colour alone, so it stays
  // readable for colour-blind users and in increased-contrast mode.
  const content = (
    <span className="inline-flex min-w-0 items-center gap-1">
      <status.Icon
        className={cn(
          'size-3.5 shrink-0',
          item.statusLabel === 'Preparing' && 'animate-pulse'
        )}
      />
      <span className="truncate">{item.statusLabel}</span>
    </span>
  )

  return (
    <div className={cn('flex items-center text-xs', status.text)}>
      {item.progressState === 'failed' && item.error ? (
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side="top" align="start">
            <div className="max-w-[420px] text-xs">{item.error}</div>
          </TooltipContent>
        </Tooltip>
      ) : (
        content
      )}
    </div>
  )
}

function EmptyState({
  onBrowse,
}: {
  onBrowse: (mode: 'files' | 'folder') => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-16 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <UploadCloudIcon className="size-6" />
      </div>
      <p className="text-sm font-medium">Drop files and folders here</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Anything you add is queued until you start the upload to your
        destination folder.
      </p>
      <div className="mt-4 flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onBrowse('files')}
        >
          <FilePlusIcon />
          Add Files…
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onBrowse('folder')}
        >
          <FolderPlusIcon />
          Add Folders…
        </Button>
      </div>
    </div>
  )
}

/**
 * Tauri's drag-and-drop events are window-wide, so the affordance is too - the
 * old version only tinted the table border, which was easy to miss.
 */
function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-background/80 backdrop-blur-[2px]">
      <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-status-info px-8 py-6 text-status-info">
        <UploadCloudIcon className="size-7" />
        <p className="text-sm font-medium">Drop to add to the queue</p>
      </div>
    </div>
  )
}
