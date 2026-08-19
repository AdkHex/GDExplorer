import {
  AlertTriangleIcon,
  CheckIcon,
  ClockIcon,
  PauseIcon,
  UploadIcon,
  type LucideIcon,
} from 'lucide-react'

export type TransferState =
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'completed'
  | 'failed'

interface TransferStatusStyle {
  /** Default label. Callers may override it (e.g. "Preparing" while uploading). */
  label: string
  Icon: LucideIcon
  /** Foreground colour for the status label and icon. */
  text: string
  /** Filled portion of the progress bar. */
  fill: string
  /** Unfilled portion of the progress bar. */
  track: string
}

/**
 * Single source of truth for how each transfer state looks. The colours resolve
 * to the `--status-*` custom properties, which have distinct light and dark
 * values so status text keeps its contrast in both appearances.
 */
export const TRANSFER_STATUS: Record<TransferState, TransferStatusStyle> = {
  queued: {
    label: 'Queued',
    Icon: ClockIcon,
    text: 'text-muted-foreground',
    fill: 'bg-muted-foreground/30',
    track: 'bg-muted-foreground/10',
  },
  uploading: {
    label: 'Uploading',
    Icon: UploadIcon,
    text: 'text-status-info',
    fill: 'bg-status-info',
    track: 'bg-status-info/15',
  },
  paused: {
    label: 'Paused',
    Icon: PauseIcon,
    text: 'text-status-warning',
    fill: 'bg-status-warning',
    track: 'bg-status-warning/15',
  },
  completed: {
    label: 'Completed',
    Icon: CheckIcon,
    text: 'text-status-success',
    fill: 'bg-status-success',
    track: 'bg-status-success/15',
  },
  failed: {
    label: 'Failed',
    Icon: AlertTriangleIcon,
    text: 'text-status-danger',
    fill: 'bg-status-danger',
    track: 'bg-status-danger/15',
  },
}
