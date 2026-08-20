import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@/lib/logger'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  seq: number
  timestampMs: number
  level: LogLevel
  target: string
  message: string
}

interface LogSnapshot {
  entries: LogEntry[]
  oldestSeq: number
  latestSeq: number
}

/** Matches the backend ring buffer, so the panel never holds more than it. */
const MAX_ENTRIES = 5_000

const POLL_INTERVAL_MS = 700

/**
 * Tails the backend log buffer.
 *
 * Polling rather than an event per record: rclone emits a stats line every
 * second for every running transfer, and pushing each one through the IPC
 * bridge would cost far more than one batched fetch. The cursor means a poll
 * only ever transfers lines the panel has not seen.
 *
 * Only runs while the caller is mounted, so a closed panel costs nothing.
 */
export function useLogStream(enabled: boolean) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [isPaused, setIsPaused] = useState(false)
  const cursorRef = useRef(0)
  // Read through a ref so toggling pause does not tear down the interval.
  const isPausedRef = useRef(isPaused)

  useEffect(() => {
    isPausedRef.current = isPaused
  }, [isPaused])

  const clear = useCallback(async () => {
    try {
      await invoke('clear_log_entries')
    } catch (error) {
      logger.warn('Failed to clear the log buffer', { error: String(error) })
    }
    setEntries([])
  }, [])

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let inFlight = false

    const poll = async () => {
      // A slow fetch must not stack up behind the interval.
      if (inFlight || isPausedRef.current) return
      inFlight = true
      try {
        const snapshot = await invoke<LogSnapshot>('get_log_entries', {
          afterSeq: cursorRef.current,
          limit: 1_000,
        })
        if (cancelled) return

        // The buffer dropped lines we never fetched (a long batch outran the
        // panel). Restart from what is still there instead of leaving a
        // silent hole in the middle of the list.
        const missedEntries =
          cursorRef.current > 0 && snapshot.oldestSeq > cursorRef.current + 1

        if (snapshot.entries.length === 0 && !missedEntries) return

        cursorRef.current = snapshot.latestSeq
        setEntries(current => {
          const next = missedEntries
            ? snapshot.entries
            : current.concat(snapshot.entries)
          return next.length > MAX_ENTRIES
            ? next.slice(next.length - MAX_ENTRIES)
            : next
        })
      } catch (error) {
        logger.debug('Log buffer not available', { error: String(error) })
      } finally {
        inFlight = false
      }
    }

    void poll()
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [enabled])

  return { entries, isPaused, setIsPaused, clear }
}
