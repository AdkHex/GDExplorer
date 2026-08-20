import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CopyIcon, PauseIcon, PlayIcon, Trash2Icon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  useLogStream,
  type LogEntry,
  type LogLevel,
} from '@/hooks/useLogStream'
import { copyText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

/** Severity order, most severe first, matching how the filter reads. */
const LEVEL_SEVERITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
}

const LEVEL_FILTERS = [
  { value: 'all', label: 'All levels', maxSeverity: 4 },
  { value: 'info', label: 'Info and above', maxSeverity: 2 },
  { value: 'warn', label: 'Warnings and errors', maxSeverity: 1 },
  { value: 'error', label: 'Errors only', maxSeverity: 0 },
] as const

type LevelFilterValue = (typeof LEVEL_FILTERS)[number]['value']

const SOURCE_FILTERS = [
  { value: 'all', label: 'All sources' },
  { value: 'rclone', label: 'rclone' },
  { value: 'app', label: 'App' },
] as const

type SourceFilterValue = (typeof SOURCE_FILTERS)[number]['value']

/**
 * The buffer holds thousands of lines; painting them all is what would make the
 * panel stutter during a transfer. Only the newest slice is rendered - copy
 * still takes everything that matches the filter.
 */
const MAX_RENDERED = 500

const LEVEL_TEXT: Record<LogLevel, string> = {
  trace: 'text-muted-foreground',
  debug: 'text-muted-foreground',
  info: 'text-foreground/80',
  warn: 'text-status-warning',
  error: 'text-status-danger',
}

function formatTime(timestampMs: number): string {
  const date = new Date(timestampMs)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatEntry(entry: LogEntry): string {
  return `${formatTime(entry.timestampMs)} [${entry.level}] [${entry.target}] ${entry.message}`
}

/**
 * Tail of the app's own log, rclone's raw output included.
 *
 * rclone reports what actually went wrong far more precisely than a failed row
 * can - this is where that detail was going before, straight to a log file
 * nobody opens.
 */
export function LogPanel({ onClose }: { onClose: () => void }) {
  const { entries, isPaused, setIsPaused, clear } = useLogStream(true)
  const [levelFilter, setLevelFilter] = useState<LevelFilterValue>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilterValue>('all')
  const [query, setQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Standard log-tail behaviour: follow the newest line until the user scrolls
  // up to read something, then leave the view where they put it.
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true)

  const filtered = useMemo(() => {
    const maxSeverity =
      LEVEL_FILTERS.find(f => f.value === levelFilter)?.maxSeverity ?? 4
    const needle = query.trim().toLowerCase()

    return entries.filter(entry => {
      if (LEVEL_SEVERITY[entry.level] > maxSeverity) return false
      if (sourceFilter === 'rclone' && entry.target !== 'rclone') return false
      if (sourceFilter === 'app' && entry.target === 'rclone') return false
      if (needle && !entry.message.toLowerCase().includes(needle)) return false
      return true
    })
  }, [entries, levelFilter, query, sourceFilter])

  const visible = useMemo(
    () =>
      filtered.length > MAX_RENDERED
        ? filtered.slice(filtered.length - MAX_RENDERED)
        : filtered,
    [filtered]
  )

  useEffect(() => {
    if (!isPinnedToBottom) return
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [visible, isPinnedToBottom])

  const handleScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight
    setIsPinnedToBottom(distanceFromBottom < 24)
  }, [])

  const handleCopy = useCallback(async () => {
    if (filtered.length === 0) {
      toast.message('Nothing to copy', {
        description: 'No log lines match the current filter.',
      })
      return
    }
    try {
      await copyText(filtered.map(formatEntry).join('\n'))
      toast.success(
        `Copied ${filtered.length} log line${filtered.length === 1 ? '' : 's'}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('Failed to copy log lines', { error: message })
      toast.error('Could not copy the log', { description: message })
    }
  }, [filtered])

  return (
    <section
      className="flex h-64 shrink-0 flex-col border-t bg-card"
      aria-label="Log"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="text-xs font-semibold">Log</h2>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {filtered.length === entries.length
            ? `${entries.length} lines`
            : `${filtered.length} of ${entries.length}`}
        </span>

        <Input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Filter…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Filter log lines"
          className="ml-2 h-8 w-40 text-xs"
        />

        <Select
          value={levelFilter}
          onValueChange={value => setLevelFilter(value as LevelFilterValue)}
        >
          <SelectTrigger
            size="sm"
            className="w-40 text-xs"
            aria-label="Log level"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVEL_FILTERS.map(filter => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={sourceFilter}
          onValueChange={value => setSourceFilter(value as SourceFilterValue)}
        >
          <SelectTrigger
            size="sm"
            className="w-32 text-xs"
            aria-label="Log source"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_FILTERS.map(filter => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setIsPaused(!isPaused)}
                aria-label={isPaused ? 'Resume the log' : 'Pause the log'}
              >
                {isPaused ? <PlayIcon /> : <PauseIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isPaused ? 'Resume' : 'Pause'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void handleCopy()}
                aria-label="Copy the visible log lines"
              >
                <CopyIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Copy filtered lines</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void clear()}
                aria-label="Clear the log"
              >
                <Trash2Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Clear</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label="Hide the log"
              >
                <XIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Hide log
              <span className="ml-2 opacity-60">⌘2</span>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-auto px-3 py-1.5"
        role="log"
        aria-live="off"
      >
        {visible.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {entries.length === 0
              ? 'Nothing logged yet. rclone output appears here while a transfer runs.'
              : 'No lines match the current filter.'}
          </p>
        ) : (
          <div className="font-mono text-[11px] leading-[1.45]">
            {filtered.length > visible.length ? (
              <p className="pb-1 text-muted-foreground">
                Showing the last {MAX_RENDERED} of {filtered.length} lines. Copy
                takes all of them.
              </p>
            ) : null}
            {visible.map(entry => (
              <div key={entry.seq} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-muted-foreground/70">
                  {formatTime(entry.timestampMs)}
                </span>
                <span
                  className={cn('shrink-0 uppercase', LEVEL_TEXT[entry.level])}
                >
                  {entry.level}
                </span>
                <span className="shrink-0 text-muted-foreground/70">
                  {entry.target}
                </span>
                <span className="whitespace-pre-wrap break-all">
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

export default LogPanel
