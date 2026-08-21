import { useCallback, useState } from 'react'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  HistoryIcon,
  LinkIcon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react'
import {
  useUploadHistory,
  type UploadHistoryEntry,
} from '@/store/upload-history-store'
import {
  copyText,
  driveFileUrl,
  driveFolderUrl,
  resolveItemLinks,
} from '@/lib/drive-links'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { formatBytes } from './format'

/** Rows shown when the bar is expanded before it starts scrolling. */
const VISIBLE_ROWS = 6

function formatCompletedAt(epochMs: number): string {
  const date = new Date(epochMs)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  if (sameDay) return time
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
  return `${day}, ${time}`
}

/**
 * Resolves an entry's Drive URL on demand. rclone never reports the IDs it
 * creates, so the link is looked up from Drive the first time it is needed -
 * the same approach the transfer rows use.
 */
async function resolveEntryUrl(entry: UploadHistoryEntry): Promise<string> {
  if (!entry.destinationFolderId) {
    throw new Error('This upload has no recorded destination folder.')
  }
  const links = await resolveItemLinks(
    entry.path,
    entry.kind,
    entry.destinationFolderId
  )
  if (entry.kind === 'folder') {
    if (!links.folderId) {
      throw new Error('The folder could not be found in Drive.')
    }
    return driveFolderUrl(links.folderId)
  }
  const fileId = links.files[0]?.fileId
  if (!fileId) {
    throw new Error('The file could not be found in Drive.')
  }
  return driveFileUrl(fileId)
}

interface UploadHistoryBarProps {
  /** Re-queues a past upload against its original destination. */
  onUploadAgain: (entry: UploadHistoryEntry) => void
  className?: string
}

export function UploadHistoryBar({
  onUploadAgain,
  className,
}: UploadHistoryBarProps) {
  const entries = useUploadHistory(s => s.entries)
  const removeEntry = useUploadHistory(s => s.removeEntry)
  const clearHistory = useUploadHistory(s => s.clearHistory)
  const [expanded, setExpanded] = useState(false)
  // Entry ids with a Drive lookup in flight, so the row can disable its buttons.
  const [pendingIds, setPendingIds] = useState<string[]>([])

  const withPending = useCallback(
    async (entry: UploadHistoryEntry, action: () => Promise<void>) => {
      setPendingIds(ids => [...ids, entry.id])
      try {
        await action()
      } finally {
        setPendingIds(ids => ids.filter(id => id !== entry.id))
      }
    },
    []
  )

  const copyLink = useCallback(
    (entry: UploadHistoryEntry) =>
      withPending(entry, async () => {
        try {
          await copyText(await resolveEntryUrl(entry))
          toast.success('Link copied', { description: entry.name })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn('history: copy link failed', { error: message })
          toast.error('Could not copy the link', { description: message })
        }
      }),
    [withPending]
  )

  const openInDrive = useCallback(
    (entry: UploadHistoryEntry) =>
      withPending(entry, async () => {
        try {
          await openUrl(await resolveEntryUrl(entry))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn('history: open in Drive failed', { error: message })
          toast.error('Could not open in Drive', { description: message })
        }
      }),
    [withPending]
  )

  const revealLocally = useCallback(async (entry: UploadHistoryEntry) => {
    try {
      await revealItemInDir(entry.path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('history: reveal failed', { error: message })
      // The usual cause is that the local file has since been moved or deleted.
      toast.error('Could not show the item', {
        description: 'It may have been moved or deleted.',
      })
    }
  }, [])

  if (entries.length === 0) return null

  return (
    <div className={cn('rounded-md border bg-card/50', className)}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-1.5 text-xs font-medium"
          onClick={() => setExpanded(open => !open)}
          aria-expanded={expanded}
          aria-controls="upload-history-list"
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
          <HistoryIcon className="size-3.5" />
          History
          <span className="ml-0.5 tabular-nums text-muted-foreground">
            {entries.length}
          </span>
        </Button>

        {/* Collapsed, the bar still says what the most recent upload was. */}
        {!expanded ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            Last: {entries[0]?.name}
            {entries[0]
              ? ` · ${formatCompletedAt(entries[0].completedAt)}`
              : ''}
          </span>
        ) : (
          <span className="flex-1" />
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => clearHistory()}
              aria-label="Clear history"
            >
              <XIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Clear history</TooltipContent>
        </Tooltip>
      </div>

      {expanded ? (
        <ul
          id="upload-history-list"
          className="max-h-[calc(var(--history-row-height)*var(--history-rows))] overflow-y-auto border-t"
          style={
            {
              '--history-row-height': '2.25rem',
              '--history-rows': VISIBLE_ROWS,
            } as React.CSSProperties
          }
        >
          {entries.map(entry => {
            const isPending = pendingIds.includes(entry.id)
            return (
              <li
                key={entry.id}
                className="flex h-9 items-center gap-2 px-2 text-xs hover:bg-accent/40"
              >
                {entry.kind === 'folder' ? (
                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}

                <span className="min-w-0 flex-1 truncate" title={entry.path}>
                  {entry.name}
                </span>

                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                  {entry.totalBytes ? formatBytes(entry.totalBytes) : '—'}
                </span>

                <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
                  {formatCompletedAt(entry.completedAt)}
                </span>

                <div className="flex shrink-0 items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={isPending}
                        onClick={() => void copyLink(entry)}
                        aria-label={`Copy link for ${entry.name}`}
                      >
                        <LinkIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy Drive link</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={isPending}
                        onClick={() => void openInDrive(entry)}
                        aria-label={`Open ${entry.name} in Drive`}
                      >
                        <ExternalLinkIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Open in Drive</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onUploadAgain(entry)}
                        aria-label={`Upload ${entry.name} again`}
                      >
                        <RotateCcwIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Upload again</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void revealLocally(entry)}
                        aria-label={`Show ${entry.name} in file explorer`}
                      >
                        <FolderOpenIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Show in file explorer</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeEntry(entry.id)}
                        aria-label={`Remove ${entry.name} from history`}
                      >
                        <XIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove from history</TooltipContent>
                  </Tooltip>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

export default UploadHistoryBar
