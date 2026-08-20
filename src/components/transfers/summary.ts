import type { LocalUploadItem } from '@/store/local-upload-queue-store'
import type { TransferMetrics } from '@/store/transfer-ui-store'
import type { TransferState } from './status'

export interface QueueSummaryData {
  counts: Record<TransferState, number>
  totalBytes: number
  sentBytes: number
  percent: number
  speedBytesPerSec: number
  etaSeconds: number | null
  state: TransferState
}

/**
 * Rolls the queue up into one figure per column.
 *
 * Shared so the sidebar and the tray icon can never disagree about how far
 * along a batch is.
 */
export function summarizeQueue(
  items: LocalUploadItem[],
  metrics: Record<string, TransferMetrics>,
  pausedById: Record<string, boolean>
): QueueSummaryData {
  const counts: Record<TransferState, number> = {
    queued: 0,
    uploading: 0,
    paused: 0,
    completed: 0,
    failed: 0,
  }

  let totalBytes = 0
  let sentBytes = 0
  let speedBytesPerSec = 0
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
      speedBytesPerSec += metrics[item.id]?.speedBytesPerSec ?? 0
    }
  }

  const percent = totalBytes > 0 ? (sentBytes / totalBytes) * 100 : 0
  const remaining = Math.max(0, totalBytes - sentBytes)
  const etaSeconds =
    isActive && speedBytesPerSec > 0 ? remaining / speedBytesPerSec : null

  const state: TransferState = counts.uploading
    ? 'uploading'
    : counts.paused
      ? 'paused'
      : counts.queued
        ? 'queued'
        : counts.failed
          ? 'failed'
          : 'completed'

  return {
    counts,
    totalBytes,
    sentBytes,
    percent,
    speedBytesPerSec,
    etaSeconds,
    state,
  }
}
