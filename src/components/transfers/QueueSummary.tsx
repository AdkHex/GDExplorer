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
        <div className="text-[11px] font-medium text-muted-foreground">
          Queue
        </div>
        <div className="text-xs tabular-nums text-muted-foreground">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </div>
      </div>

      <ProgressBar
        percent={summary.percent}
        state={summary.state}
        label="Overall upload progress"
      />

      {/* Two short lines rather than one long one: at 240px the single line
          wrapped and left "left" stranded on a row of its own. */}
      <div className="text-xs tabular-nums">
        {summary.totalBytes > 0
          ? `${formatBytes(summary.sentBytes)} / ${formatBytes(summary.totalBytes)}`
          : 'Size not known yet'}
      </div>
      {isActive ? (
        <div className="text-xs tabular-nums text-muted-foreground">
          {[
            summary.speedBytesPerSec > 0
              ? formatSpeed(summary.speedBytesPerSec)
              : null,
            summary.etaSeconds !== null
              ? `${formatEta(summary.etaSeconds)} left`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      ) : null}
    </section>
  )
}
