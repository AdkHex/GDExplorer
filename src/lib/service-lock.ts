import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'

/**
 * True inside the Tauri webview. The same check as `isTauri()` from
 * @tauri-apps/api/core, which the tests mock away.
 */
export function inTauri(): boolean {
  return Boolean((globalThis as { isTauri?: unknown }).isTauri)
}

/**
 * The remote switch ("Work is in progress") and the access password. The Rust
 * side decides and enforces; this only mirrors its state for the lock screen.
 * See docs/REMOTE-STATUS.md.
 */
export type LockReason = 'maintenance' | 'update' | 'access' | 'connect'

/** Mirrors `remote_status::ServiceLock`. */
export interface ServiceLock {
  locked: boolean
  reason: LockReason | null
  title: string | null
  message: string | null
  updateUrl: string | null
  minVersion: string | null
  appVersion: string
  enabled: boolean
  checkedAt: number | null
  lastError: string | null
  checking: boolean
  retryAfterSecs: number | null
}

export const SERVICE_LOCK_EVENT = 'service-lock-changed'

const UNLOCKED: ServiceLock = {
  locked: false,
  reason: null,
  title: null,
  message: null,
  updateUrl: null,
  minVersion: null,
  appVersion: '',
  enabled: false,
  checkedAt: null,
  lastError: null,
  checking: false,
  retryAfterSecs: null,
}

interface ServiceLockState {
  /** Null until the backend has answered once. */
  lock: ServiceLock | null
  setLock: (lock: ServiceLock) => void
}

export const useServiceLockStore = create<ServiceLockState>()(set => ({
  lock: null,
  setLock: lock => set({ lock }),
}))

export function isServiceLocked(): boolean {
  return useServiceLockStore.getState().lock?.locked ?? false
}

export const checkServiceStatus = () =>
  invoke<ServiceLock>('check_service_status')

export const unlockAccess = (password: string) =>
  invoke<ServiceLock>('unlock_access', { password })

/**
 * Reads the state once and then follows `service-lock-changed`. Mounted once,
 * in App. Outside Tauri (tests, a plain browser) there is no lock.
 */
export async function startServiceLockSync(): Promise<() => void> {
  const { setLock } = useServiceLockStore.getState()
  if (!inTauri()) {
    setLock(UNLOCKED)
    return () => undefined
  }

  let alive = true
  let heardEvent = false
  const unlisten = await listen<ServiceLock>(SERVICE_LOCK_EVENT, event => {
    heardEvent = true
    setLock(event.payload)
  })

  // The first read can race the backend's setup; try for a few seconds. Even
  // if it never answers, the Rust side still refuses all work while locked.
  for (let attempt = 0; alive && attempt < 20; attempt++) {
    try {
      const lock = await invoke<ServiceLock>('service_lock')
      if (alive && !heardEvent) setLock(lock)
      break
    } catch {
      if (attempt === 19 && alive && !heardEvent) setLock(UNLOCKED)
      else await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  return () => {
    alive = false
    unlisten()
  }
}
