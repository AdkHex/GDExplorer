import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  MinusCircleIcon,
  RefreshCwIcon,
  XCircleIcon,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useUIStore } from '@/store/ui-store'
import { useUploadDestinationStore } from '@/store/upload-destination-store'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped'

interface PreflightCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

const STATUS_STYLE: Record<
  CheckStatus,
  { Icon: LucideIcon; text: string; label: string }
> = {
  ok: { Icon: CheckCircle2Icon, text: 'text-status-success', label: 'Passed' },
  warn: {
    Icon: AlertTriangleIcon,
    text: 'text-status-warning',
    label: 'Warning',
  },
  fail: { Icon: XCircleIcon, text: 'text-status-danger', label: 'Failed' },
  skipped: {
    Icon: MinusCircleIcon,
    text: 'text-muted-foreground',
    label: 'Skipped',
  },
}

/**
 * Runs the setup checks and shows what each one found.
 *
 * Deliberately manual rather than automatic on launch: the checks talk to
 * Drive, and doing that unasked on every start would be both slow and rude.
 */
export function PreflightDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted only while open, so each visit runs a fresh pass. */}
        {open ? <PreflightBody onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function PreflightBody({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void
}) {
  const destinationFolderId = useUploadDestinationStore(
    s => s.destinationFolderId
  )
  const openPreferencesAt = useUIStore(s => s.openPreferencesAt)
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null)
  const [isRunning, setIsRunning] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const applyResult = useCallback((next: PreflightCheck[]) => {
    setChecks(next)
    setError(null)
    setIsRunning(false)
  }, [])

  const applyError = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    logger.warn('Preflight failed to run', { error: message })
    setError(message)
    setIsRunning(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    runChecks(destinationFolderId)
      .then(next => {
        if (!cancelled) applyResult(next)
      })
      .catch(cause => {
        if (!cancelled) applyError(cause)
      })
    return () => {
      cancelled = true
    }
  }, [destinationFolderId, applyResult, applyError])

  const rerun = useCallback(() => {
    setIsRunning(true)
    runChecks(destinationFolderId).then(applyResult).catch(applyError)
  }, [destinationFolderId, applyResult, applyError])

  const failures = checks?.filter(check => check.status === 'fail') ?? []
  const warnings = checks?.filter(check => check.status === 'warn') ?? []

  return (
    <>
      <DialogHeader>
        <DialogTitle>Setup check</DialogTitle>
        <DialogDescription>
          {destinationFolderId
            ? 'Checks rclone, the remote, your service accounts and the destination folder.'
            : 'Checks rclone, the remote and your service accounts. Set a destination to also test the folder.'}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        {error ? (
          <p className="flex items-start gap-2 text-sm text-status-danger">
            <XCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        {checks === null ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Running checks…
          </p>
        ) : (
          checks.map(check => {
            const style = STATUS_STYLE[check.status]
            return (
              <div key={check.id} className="flex items-start gap-2">
                <style.Icon
                  className={cn('mt-0.5 size-4 shrink-0', style.text)}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {check.label}
                    <span className="sr-only"> — {style.label}</span>
                  </p>
                  <p className="text-xs break-words text-muted-foreground">
                    {check.detail}
                  </p>
                </div>
              </div>
            )
          })
        )}

        {checks !== null && !isRunning ? (
          <p className="pt-1 text-xs text-muted-foreground">
            {failures.length > 0
              ? `${failures.length} problem${failures.length === 1 ? '' : 's'} to fix before uploading.`
              : warnings.length > 0
                ? 'Ready to upload, with warnings.'
                : 'Everything checks out.'}
          </p>
        ) : null}
      </div>

      <DialogFooter className="sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            openPreferencesAt('general')
            onOpenChange(false)
          }}
        >
          Open Preferences
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={rerun}
            disabled={isRunning}
          >
            {isRunning ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <RefreshCwIcon />
            )}
            {isRunning ? 'Checking…' : 'Run again'}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

function runChecks(
  destinationFolderId: string | null
): Promise<PreflightCheck[]> {
  return invoke<PreflightCheck[]>('run_preflight', {
    args: { destinationFolderId },
  })
}

export default PreflightDialog
