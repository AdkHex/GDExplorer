import { useMemo } from 'react'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useTransferUiStore } from '@/store/transfer-ui-store'
import { ProgressBar } from './ProgressBar'
import { summarizeQueue } from './summary'
import { formatBytes, formatEta, formatSpeed } from './format'

/**
 * Per-row progress answers "how is this file doing"; this answers "how is the
 * whole upload doing", which is what you actually want while a batch runs.
 */
export function QueueSummary() {
  const items = useLocalUploadQueue(s => s.items)
  const metrics = useTransferUiStore(s => s.metricsById)
  const pausedById = useTransferUiStore(s => s.pausedById)

  const summary = useMemo(
    () => summarizeQueue(items, metrics, pausedById),
    [items, metrics, pausedById]
  )

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
        {isActive && summary.speedBytesPerSec > 0
          ? ` · ${formatSpeed(summary.speedBytesPerSec)}`
          : ''}
        {isActive && summary.etaSeconds !== null
          ? ` · ${formatEta(summary.etaSeconds)} left`
          : ''}
      </p>
    </section>
  )
}
