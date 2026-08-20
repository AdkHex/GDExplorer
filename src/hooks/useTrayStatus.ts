import { useEffect, useMemo, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { summarizeQueue } from '@/components/transfers/summary'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useTransferUiStore } from '@/store/transfer-ui-store'
import { logger } from '@/lib/logger'

const APP_NAME = 'GDrive-Upload'

interface TrayStatus {
  /** Short text beside the menu bar icon (macOS). Null clears it. */
  title: string | null
  tooltip: string
}

/**
 * Mirrors queue progress into the menu bar / tray icon.
 *
 * Deliberately coarse - whole percent and item counts, no live speed - so the
 * status only changes a handful of times per batch instead of on every progress
 * event. A tray update is an IPC round trip; a transfer produces one of those
 * per second per item already.
 */
export function useTrayStatus() {
  const items = useLocalUploadQueue(s => s.items)
  const metrics = useTransferUiStore(s => s.metricsById)
  const pausedById = useTransferUiStore(s => s.pausedById)
  const lastSentRef = useRef<string | null>(null)

  const status = useMemo((): TrayStatus => {
    if (items.length === 0) return { title: null, tooltip: APP_NAME }

    const summary = summarizeQueue(items, metrics, pausedById)
    const { counts } = summary
    const percent = Math.min(100, Math.max(0, Math.round(summary.percent)))

    if (counts.uploading > 0) {
      return {
        title: `${percent}%`,
        tooltip: `${APP_NAME} — ${percent}% · ${counts.uploading} uploading`,
      }
    }

    if (counts.paused > 0) {
      return {
        title: null,
        tooltip: `${APP_NAME} — paused at ${percent}%`,
      }
    }

    if (counts.queued > 0) {
      return {
        title: null,
        tooltip: `${APP_NAME} — ${counts.queued} queued`,
      }
    }

    const failedSuffix = counts.failed > 0 ? `, ${counts.failed} failed` : ''
    return {
      title: null,
      tooltip: `${APP_NAME} — ${counts.completed} done${failedSuffix}`,
    }
  }, [items, metrics, pausedById])

  useEffect(() => {
    const key = `${status.title ?? ''}|${status.tooltip}`
    if (lastSentRef.current === key) return
    lastSentRef.current = key

    invoke('update_tray_status', {
      args: { title: status.title, tooltip: status.tooltip },
    }).catch(error => {
      logger.debug('Tray status not available', { error: String(error) })
    })
  }, [status])
}
