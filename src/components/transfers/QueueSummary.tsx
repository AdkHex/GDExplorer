import { useMemo } from 'react'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useTransferUiStore } from '@/store/transfer-ui-store'
import { ProgressBar } from './ProgressBar'
import { TRANSFER_STATUS, type TransferState } from './status'
import { formatBytes, formatEta, formatSpeed } from './format'
import { cn } from '@/lib/utils'

const COUNT_ORDER: { state: TransferState; label: string }[] = [
  { state: 'uploading', label: 'uploading' },
  { state: 'queued', label: 'queued' },
  { state: 'paused', label: 'paused' },
  { state: 'completed', label: 'done' },
  { state: 'failed', label: 'failed' },
]

/**
 * Per-row progress answers "how is this file doing"; this answers "how is the
 * whole upload doing", which is what you actually want while a batch runs.
 */
export function QueueSummary() {
  const items = useLocalUploadQueue(s => s.items)
  const metrics = useTransferUiStore(s => s.metricsById)
  const pausedById = useTransferUiStore(s => s.pausedById)

  const summary = useMemo(() => {
    const counts: Record<TransferState, number> = {
      queued: 0,
      uploading: 0,
      paused: 0,
      completed: 0,
      failed: 0,
    }

    let totalBytes = 0
    let sentBytes = 0
    let speed = 0
    let isActive = false

    for (const item of items) {
      const status = item.status ?? 'queued'
      const total = typeof item.totalBytes === 'number' ? item.totalBytes : 0
      const sent = typeof item.bytesSent === 'number' ? item.bytesSent : 0

      const state: TransferState =
        status === 'done'
          ? 'completed'
          : status === 'failed'
            ? 'failed'
            : status === 'paused' || pausedById[item.id]
              ? 'paused'
              : status === 'uploading' || status === 'preparing'
                ? 'uploading'
                : 'queued'

      counts[state] += 1
      totalBytes += total
      // A finished item counts as fully sent even if the last progress event
      // undershot its total, so the bar reaches 100% when the batch is done.
      sentBytes += state === 'completed' ? total : Math.min(sent, total)

      if (state === 'uploading') {
        isActive = true
        speed += metrics[item.id]?.speedBytesPerSec ?? 0
      }
    }

    const percent = totalBytes > 0 ? (sentBytes / totalBytes) * 100 : 0
    const remaining = Math.max(0, totalBytes - sentBytes)
    const etaSeconds = isActive && speed > 0 ? remaining / speed : null

    const state: TransferState = counts.uploading
      ? 'uploading'
      : counts.paused
        ? 'paused'
        : counts.queued
          ? 'queued'
          : counts.failed
            ? 'failed'
            : 'completed'

    return { counts, totalBytes, sentBytes, percent, speed, etaSeconds, state }
  }, [items, metrics, pausedById])

  if (items.length === 0) return null

  const isActive = summary.counts.uploading > 0

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Queue</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
      </div>

      <ProgressBar
        percent={summary.percent}
        state={summary.state}
        label="Overall upload progress"
      />

      <p className="text-xs tabular-nums text-muted-foreground">
        {summary.totalBytes > 0
          ? `${formatBytes(summary.sentBytes)} of ${formatBytes(summary.totalBytes)}`
          : 'Size not known yet'}
        {isActive && summary.speed > 0
          ? ` · ${formatSpeed(summary.speed)}`
          : ''}
        {isActive && summary.etaSeconds !== null
          ? ` · ${formatEta(summary.etaSeconds)} left`
          : ''}
      </p>

      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {COUNT_ORDER.filter(entry => summary.counts[entry.state] > 0).map(
          entry => (
            <li
              key={entry.state}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  TRANSFER_STATUS[entry.state].fill
                )}
              />
              <span className="tabular-nums">
                {summary.counts[entry.state]} {entry.label}
              </span>
            </li>
          )
        )}
      </ul>
    </section>
  )
}
