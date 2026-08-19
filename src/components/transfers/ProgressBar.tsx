import { cn } from '@/lib/utils'
import { TRANSFER_STATUS, type TransferState } from './status'

export type { TransferState }

/**
 * Determinate progress bar, styled after the macOS bar indicator: a slim track
 * with a rounded fill. The percentage is rendered beside the bar rather than on
 * top of the fill so it never loses contrast as the fill sweeps underneath it.
 */
export function ProgressBar({
  percent,
  state,
  label,
}: {
  percent: number
  state: TransferState
  /** Accessible name, e.g. the file this bar belongs to. */
  label?: string
}) {
  const pct = clamp(percent, 0, 100)
  const { fill, track } = TRANSFER_STATUS[state]

  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn(
          'relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full',
          track
        )}
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out',
            fill
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {formatPercent(pct)}
      </span>
    </div>
  )
}

function formatPercent(pct: number): string {
  // Avoid showing a misleading "100%" while the last bytes are still in flight.
  if (pct >= 100) return '100%'
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}
