// Full-window lock screen for the remote switch and the access password
// (docs/REMOTE-STATUS.md). It cannot be dismissed, and while it shows the rest
// of the window is inert. The Rust side refuses all work on its own; this is
// only what the user sees.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MacOSWindowControls } from '@/components/titlebar/MacOSWindowControls'
import { WindowsWindowControls } from '@/components/titlebar/WindowsWindowControls'
import { detectPlatform } from '@/lib/platform'
import { logger } from '@/lib/logger'
import { checkForUpdates, installUpdate } from '@/lib/updater'
import {
  checkServiceStatus,
  inTauri,
  unlockAccess,
  useServiceLockStore,
  type ServiceLock,
} from '@/lib/service-lock'
import { useUIStore } from '@/store/ui-store'

const OVERLAY_ID = 'service-lock-overlay'

/**
 * Makes everything but the overlay inert - including dialogs that open later,
 * which Radix portals straight into <body> - and keeps app shortcuts from
 * reaching the window underneath.
 */
function useInertPage(active: boolean) {
  useEffect(() => {
    if (!active) return
    const touched = new Set<HTMLElement>()
    const makeInert = (node: Node) => {
      if (
        node instanceof HTMLElement &&
        node.id !== OVERLAY_ID &&
        !node.inert
      ) {
        node.inert = true
        touched.add(node)
      }
    }
    Array.from(document.body.children).forEach(makeInert)
    const observer = new MutationObserver(records =>
      records.forEach(record => record.addedNodes.forEach(makeInert))
    )
    observer.observe(document.body, { childList: true })
    // Take focus away from the page underneath, but not from the password
    // field: it focuses itself first, because child effects run before this.
    const focused = document.activeElement as HTMLElement | null
    if (!focused?.closest?.(`#${OVERLAY_ID}`)) focused?.blur?.()

    const swallow = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest?.(`#${OVERLAY_ID}`)) event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', swallow, true)

    // A dialog left open would sit on top of the app after the unlock.
    const { setPreferencesOpen, setPreflightOpen } = useUIStore.getState()
    setPreferencesOpen(false)
    setPreflightOpen(false)

    return () => {
      observer.disconnect()
      window.removeEventListener('keydown', swallow, true)
      touched.forEach(node => (node.inert = false))
    }
  }, [active])
}

function clock(ms: number | null): string {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** The window stays movable, and closable / minimizable, under the overlay. */
function LockTitleBar() {
  const platform = detectPlatform()
  return (
    <div
      data-tauri-drag-region
      className="flex h-9 w-full shrink-0 items-center justify-between"
    >
      {platform === 'macos' ? <MacOSWindowControls /> : <span />}
      {platform === 'windows' ? <WindowsWindowControls /> : null}
    </div>
  )
}

function CheckAgainButton({
  label = 'Check again',
  primary = false,
}: {
  label?: string
  primary?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const checkAgain = async () => {
    setBusy(true)
    const started = Date.now()
    try {
      useServiceLockStore.getState().setLock(await checkServiceStatus())
    } catch (error) {
      logger.warn('Status check failed', { error: String(error) })
    }
    // Long enough to see that something happened.
    setTimeout(() => setBusy(false), Math.max(0, 600 - (Date.now() - started)))
  }
  return (
    <Button
      type="button"
      variant={primary ? 'default' : 'secondary'}
      className="w-full"
      onClick={() => void checkAgain()}
      disabled={busy}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <RefreshCw className="size-4" />
      )}
      {busy ? 'Checking…' : label}
    </Button>
  )
}

function PasswordForm({ lock }: { lock: ServiceLock }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wait, setWait] = useState(lock.retryAfterSecs ?? 0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setWait(lock.retryAfterSecs ?? 0)
  }, [lock.retryAfterSecs])

  useEffect(() => {
    if (wait <= 0) return
    const timer = setTimeout(() => setWait(left => left - 1), 1000)
    return () => clearTimeout(timer)
  }, [wait])

  useEffect(() => {
    input.current?.focus()
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!password || busy || wait > 0) return
    setBusy(true)
    setError(null)
    try {
      useServiceLockStore.getState().setLock(await unlockAccess(password))
      setPassword('')
    } catch (failure) {
      setError(String(failure))
      setPassword('')
      // focus is lost while the field is disabled
      setTimeout(() => input.current?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="mt-5 space-y-3 text-left" onSubmit={e => void submit(e)}>
      <Input
        ref={input}
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Access password"
        aria-label="Access password"
        aria-invalid={error ? true : undefined}
        value={password}
        onChange={e => setPassword(e.target.value)}
        disabled={busy}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        className="w-full"
        disabled={!password || busy || wait > 0}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {busy ? 'Checking…' : wait > 0 ? `Try again in ${wait} s` : 'Unlock'}
      </Button>
    </form>
  )
}

function UpdateButtons({ lock }: { lock: ServiceLock }) {
  const { updateDownloading, updateProgress, updateReady } = useUIStore()
  const [failed, setFailed] = useState(false)

  const install = async () => {
    setFailed(false)
    const result = await checkForUpdates()
    if (result === 'ready') await installUpdate()
    else if (result !== 'downloading') setFailed(true)
  }

  const download = () => {
    if (!lock.updateUrl) return
    void openUrl(lock.updateUrl).catch(error =>
      logger.warn('Could not open the update link', { error: String(error) })
    )
  }

  return (
    <>
      <Button
        type="button"
        className="w-full"
        onClick={() => void install()}
        disabled={updateDownloading}
      >
        {updateDownloading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Download className="size-4" />
        )}
        {updateDownloading
          ? updateProgress !== null
            ? `Downloading update (${updateProgress}%)`
            : 'Downloading update…'
          : updateReady
            ? 'Restart to update'
            : 'Install the update'}
      </Button>
      {lock.updateUrl ? (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={download}
        >
          Download the new version
        </Button>
      ) : null}
      {failed ? (
        <p className="text-xs text-muted-foreground">
          No update could be installed from here. Download the new version
          instead.
        </p>
      ) : null}
    </>
  )
}

function LockCard({ lock }: { lock: ServiceLock }) {
  const reason = lock.reason
  // A fresh install has not failed to connect yet - it is still trying.
  const firstContact = reason === 'connect' && !lock.lastError

  let title: string
  let message: string | null = null
  let note: string | null = null
  if (reason === 'access') {
    title = 'This app is strictly prohibited to be used by others'
    message = 'If you are the trusted one, enter the password.'
  } else if (reason === 'connect') {
    title = firstContact
      ? 'Checking access…'
      : 'Connect to the internet once to verify access'
    message = firstContact
      ? null
      : 'GDrive-Upload has to reach its server once before it opens. After that it also works offline.'
  } else if (reason === 'update') {
    title = 'Update required'
    message =
      lock.message ??
      'This version of GDrive-Upload is no longer supported. Please install the new version.'
    note =
      'Your uploads are paused and will continue when GDrive-Upload is back.'
  } else {
    title = lock.title ?? 'Work is in progress'
    message = lock.message
    note =
      'Your uploads are paused and will continue when GDrive-Upload is back.'
  }

  return (
    <div className="w-[360px] rounded-2xl border border-border bg-card px-7 py-8 text-center shadow-xl">
      <img
        src="/icon.png"
        alt=""
        draggable={false}
        className="mx-auto size-14 rounded-[14px]"
      />
      <h1
        id="service-lock-title"
        className="mt-4 text-base font-semibold text-foreground"
      >
        {title}
      </h1>
      <div id="service-lock-body">
        {message ? (
          <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground select-text">
            {message}
          </p>
        ) : null}
        {note ? (
          <p className="mt-3 text-xs text-muted-foreground">{note}</p>
        ) : null}
      </div>

      {reason === 'access' ? <PasswordForm lock={lock} /> : null}

      {firstContact ? (
        <Loader2 className="mx-auto mt-5 size-5 animate-spin text-muted-foreground" />
      ) : null}

      {reason === 'connect' && !firstContact ? (
        <div className="mt-5">
          <CheckAgainButton label="Try again" primary />
          {lock.lastError ? (
            <p className="mt-3 text-[11px] break-words text-muted-foreground/80 select-text">
              {lock.lastError}
            </p>
          ) : null}
        </div>
      ) : null}

      {reason === 'maintenance' || reason === 'update' ? (
        <div className="mt-5 space-y-2">
          {reason === 'update' ? <UpdateButtons lock={lock} /> : null}
          <CheckAgainButton />
        </div>
      ) : null}

      {(reason === 'maintenance' || reason === 'update') &&
      lock.checkedAt !== null ? (
        <p className="mt-4 text-[11px] text-muted-foreground/80">
          {reason === 'update' && lock.minVersion
            ? `Version ${lock.appVersion} · required ${lock.minVersion}`
            : `Last checked at ${clock(lock.checkedAt)}`}
        </p>
      ) : null}
    </div>
  )
}

export function ServiceLockOverlay() {
  const lock = useServiceLockStore(state => state.lock)
  // Until the backend has answered, cover the window rather than flash the
  // app at someone who may not be allowed to use it.
  const pending = lock === null && inTauri()
  const locked = lock?.locked ?? false
  useInertPage(locked || pending)

  if (!pending && !locked) return null

  return createPortal(
    <div
      id={OVERLAY_ID}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={pending ? undefined : 'service-lock-title'}
      aria-describedby={pending ? undefined : 'service-lock-body'}
      className="fixed inset-0 z-[100] flex flex-col overflow-hidden rounded-xl bg-background"
    >
      <LockTitleBar />
      {lock?.locked ? (
        <div
          data-tauri-drag-region
          className="flex flex-1 items-center justify-center p-6 pb-16"
        >
          <LockCard lock={lock} />
        </div>
      ) : null}
    </div>,
    document.body
  )
}
