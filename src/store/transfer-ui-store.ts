import { create } from 'zustand'

type UploadRuntimeStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'paused'
  | 'done'
  | 'failed'

/** Weight given to the newest speed sample when smoothing (0-1). */
const SPEED_SMOOTHING = 0.3

/**
 * rclone's reported speed is recorded for diagnostics but is deliberately NOT
 * displayed: `speedAvg` counts bytes as they enter the upload buffer, so with
 * large chunks it reports the disk read rate rather than what Drive has
 * actually accepted. Displayed rates are measured from byte progress instead.
 */

export interface TransferMetrics {
  speedBytesPerSec: number
  etaSeconds: number | null
}

export interface FileProgress {
  bytesSent: number
  totalBytes: number
}

export interface FileProgressByPath extends FileProgress {
  filePath: string
}

export interface FileMetrics {
  speedBytesPerSec: number
  etaSeconds: number | null
}

/** Drive IDs for an uploaded item, resolved on demand so links can be copied. */
export interface ItemDriveLinks {
  folderId: string | null
  /** Keyed by the file's path relative to the item. */
  files: Record<string, string>
}

interface TransferUiState {
  pausedById: Record<string, boolean>
  linksById: Record<string, ItemDriveLinks>
  metricsById: Record<string, TransferMetrics>
  fileProgressById: Record<string, Record<string, FileProgress>>
  fileOrderById: Record<string, string[]>
  fileMetricsById: Record<string, Record<string, FileMetrics>>
  _fileLastSampleById: Record<
    string,
    Record<string, { bytesSent: number; atMs: number }>
  >
  _lastSampleById: Record<string, { bytesSent: number; atMs: number }>
  _startedAtById: Record<string, number>
  /** Speeds rclone itself reported, per item. Diagnostics only - see above. */
  _reportedSpeedById: Record<string, { speed: number; atMs: number }>
  /** Latest settled-byte count per item, used to measure honest speed. */
  _settledBytesById: Record<string, number>

  isPaused: (id: string) => boolean
  setPaused: (id: string, paused: boolean) => void
  pauseAll: (ids: string[]) => void
  resumeAll: (ids: string[]) => void
  /** Records rclone's self-reported rate. Kept for diagnostics only. */
  recordItemSpeed: (itemId: string, speedBytesPerSec: number | null) => void
  recordFileProgress: (
    itemId: string,
    filePath: string,
    bytesSent: number,
    totalBytes: number,
    /** rclone's self-reported rate; recorded but not displayed. */
    reportedSpeedBytesPerSec?: number | null
  ) => void
  recordFileList: (itemId: string, files: FileProgressByPath[]) => void
  setItemLinks: (itemId: string, links: ItemDriveLinks) => void
  clearFileProgress: (itemIds: string[]) => void
  clearRemoved: (remainingIds: string[]) => void

  /** Records bytes rclone has fully settled (buffered data excluded). */
  recordSettledBytes: (itemId: string, settledBytes: number | null) => void
  tick: (
    items: {
      id: string
      status?: UploadRuntimeStatus | null
      bytesSent?: number | null
      totalBytes?: number | null
    }[]
  ) => void
}

export const useTransferUiStore = create<TransferUiState>((set, get) => ({
  pausedById: {},
  linksById: {},
  metricsById: {},
  fileProgressById: {},
  fileOrderById: {},
  fileMetricsById: {},
  _fileLastSampleById: {},
  _lastSampleById: {},
  _startedAtById: {},
  _reportedSpeedById: {},
  _settledBytesById: {},

  isPaused: id => Boolean(get().pausedById[id]),

  recordSettledBytes: (itemId, settledBytes) =>
    set(state => {
      if (typeof settledBytes !== 'number' || !Number.isFinite(settledBytes)) {
        return state
      }
      if (state._settledBytesById[itemId] === settledBytes) return state
      return {
        _settledBytesById: {
          ...state._settledBytesById,
          [itemId]: Math.max(0, Math.round(settledBytes)),
        },
      }
    }),

  recordItemSpeed: (itemId, speedBytesPerSec) =>
    set(state => {
      if (
        typeof speedBytesPerSec !== 'number' ||
        !Number.isFinite(speedBytesPerSec)
      ) {
        return state
      }
      return {
        _reportedSpeedById: {
          ...state._reportedSpeedById,
          [itemId]: {
            speed: Math.max(0, Math.round(speedBytesPerSec)),
            atMs: Date.now(),
          },
        },
      }
    }),

  setPaused: (id, paused) =>
    set(state => ({
      pausedById: paused
        ? { ...state.pausedById, [id]: true }
        : omitKey(state.pausedById, id),
    })),

  pauseAll: ids =>
    set(state => {
      const next = { ...state.pausedById }
      for (const id of ids) next[id] = true
      return { pausedById: next }
    }),

  resumeAll: ids =>
    set(state => {
      if (ids.length === 0) return state
      const remove = new Set(ids)
      const next: Record<string, boolean> = {}
      for (const [id, v] of Object.entries(state.pausedById)) {
        if (!remove.has(id)) next[id] = v
      }
      return { pausedById: next }
    }),

  recordFileProgress: (itemId, filePath, bytesSent, totalBytes) =>
    set(state => {
      const trimmed = filePath.trim()
      if (!trimmed) return state

      const existingByItem = state.fileProgressById[itemId]
      const existingOrder = state.fileOrderById[itemId]
      const existingMetrics = state.fileMetricsById[itemId]
      const existingSamples = state._fileLastSampleById[itemId]
      const resolvedKey =
        existingOrder && existingByItem
          ? resolveFileKey(existingOrder, trimmed)
          : trimmed
      const isNewFile = !existingByItem || !(resolvedKey in existingByItem)

      const nextByItem = existingByItem
        ? { ...existingByItem }
        : ({} as Record<string, FileProgress>)
      nextByItem[resolvedKey] = {
        bytesSent,
        totalBytes,
      }

      const nextOrder = isNewFile
        ? [...(existingOrder ?? []), resolvedKey]
        : (existingOrder ?? [])

      const now = Date.now()
      const prevSample = existingSamples?.[resolvedKey]
      const atMs = prevSample?.atMs ?? now
      const dtMs = Math.max(250, now - atMs)
      const prevSent = prevSample?.bytesSent ?? bytesSent
      const delta = Math.max(0, bytesSent - prevSent)
      const prevSpeed = existingMetrics?.[resolvedKey]?.speedBytesPerSec ?? 0
      const complete = totalBytes > 0 && bytesSent >= totalBytes
      // Measured from byte progress rather than rclone's `speedAvg`, which
      // counts buffered-but-not-yet-uploaded bytes and so reads high. See the
      // longer note in `tick`.
      const speed = complete
        ? 0
        : delta > 0
          ? Math.max(0, Math.round((delta * 1000) / dtMs))
          : prevSpeed
      const remaining = Math.max(
        0,
        totalBytes - Math.min(bytesSent, totalBytes)
      )
      const etaSeconds = speed > 0 ? Math.round(remaining / speed) : null

      const nextSamples = {
        ...(existingSamples ?? {}),
        [resolvedKey]: { bytesSent, atMs: delta > 0 ? now : atMs },
      }

      const nextMetrics = {
        ...(existingMetrics ?? {}),
        [resolvedKey]: { speedBytesPerSec: speed, etaSeconds },
      }

      return {
        fileProgressById: {
          ...state.fileProgressById,
          [itemId]: nextByItem,
        },
        fileOrderById: {
          ...state.fileOrderById,
          [itemId]: nextOrder,
        },
        fileMetricsById: {
          ...state.fileMetricsById,
          [itemId]: nextMetrics,
        },
        _fileLastSampleById: {
          ...state._fileLastSampleById,
          [itemId]: nextSamples,
        },
      }
    }),

  setItemLinks: (itemId, links) =>
    set(state => ({ linksById: { ...state.linksById, [itemId]: links } })),

  recordFileList: (itemId, files) =>
    set(state => {
      if (!files.length) return state

      const existingOrder = state.fileOrderById[itemId] ?? []
      const existingByItem = state.fileProgressById[itemId] ?? {}
      const nextByItem: Record<string, FileProgress> = {
        ...existingByItem,
      }
      const nextOrder = [...existingOrder]
      for (const entry of files) {
        const trimmed = entry.filePath.trim()
        if (!trimmed) continue
        if (trimmed in nextByItem) {
          continue
        }
        const resolved = resolveFileKey(existingOrder, trimmed)
        if (resolved in nextByItem) {
          continue
        }
        nextByItem[trimmed] = {
          bytesSent: entry.bytesSent,
          totalBytes: entry.totalBytes,
        }
        nextOrder.push(trimmed)
      }

      if (nextOrder.length === 0) return state

      const nextMetrics: Record<string, FileMetrics> = {}
      const nextSamples: Record<string, { bytesSent: number; atMs: number }> =
        {}
      const now = Date.now()
      for (const filePath of nextOrder) {
        nextMetrics[filePath] = { speedBytesPerSec: 0, etaSeconds: null }
        nextSamples[filePath] = { bytesSent: 0, atMs: now }
      }

      return {
        fileProgressById: {
          ...state.fileProgressById,
          [itemId]: nextByItem,
        },
        fileOrderById: {
          ...state.fileOrderById,
          [itemId]: nextOrder,
        },
        fileMetricsById: {
          ...state.fileMetricsById,
          [itemId]: {
            ...(state.fileMetricsById[itemId] ?? {}),
            ...nextMetrics,
          },
        },
        _fileLastSampleById: {
          ...state._fileLastSampleById,
          [itemId]: {
            ...(state._fileLastSampleById[itemId] ?? {}),
            ...nextSamples,
          },
        },
      }
    }),

  clearFileProgress: itemIds =>
    set(state => {
      if (itemIds.length === 0) return state
      const ids = new Set(itemIds)
      const nextById: Record<string, Record<string, FileProgress>> = {}
      const nextOrderById: Record<string, string[]> = {}
      const nextMetricsById: Record<string, Record<string, FileMetrics>> = {}
      const nextSamplesById: Record<
        string,
        Record<string, { bytesSent: number; atMs: number }>
      > = {}

      for (const [id, value] of Object.entries(state.fileProgressById)) {
        if (!ids.has(id)) nextById[id] = value
      }
      for (const [id, value] of Object.entries(state.fileOrderById)) {
        if (!ids.has(id)) nextOrderById[id] = value
      }
      for (const [id, value] of Object.entries(state.fileMetricsById)) {
        if (!ids.has(id)) nextMetricsById[id] = value
      }
      for (const [id, value] of Object.entries(state._fileLastSampleById)) {
        if (!ids.has(id)) nextSamplesById[id] = value
      }

      return {
        fileProgressById: nextById,
        fileOrderById: nextOrderById,
        fileMetricsById: nextMetricsById,
        _fileLastSampleById: nextSamplesById,
      }
    }),

  clearRemoved: remainingIds =>
    set(state => {
      const remaining = new Set(remainingIds)
      const nextPaused: Record<string, boolean> = {}
      const nextLinks: Record<string, ItemDriveLinks> = {}
      const nextMetrics: Record<string, TransferMetrics> = {}
      const nextFileProgress: Record<string, Record<string, FileProgress>> = {}
      const nextFileOrder: Record<string, string[]> = {}
      const nextFileMetrics: Record<string, Record<string, FileMetrics>> = {}
      const nextFileSamples: Record<
        string,
        Record<string, { bytesSent: number; atMs: number }>
      > = {}
      const nextLast: Record<string, { bytesSent: number; atMs: number }> = {}
      const nextStarted: Record<string, number> = {}
      const nextReported: Record<string, { speed: number; atMs: number }> = {}
      const nextSettled: Record<string, number> = {}

      for (const [id, v] of Object.entries(state.pausedById)) {
        if (remaining.has(id)) nextPaused[id] = v
      }
      for (const [id, v] of Object.entries(state.linksById)) {
        if (remaining.has(id)) nextLinks[id] = v
      }
      for (const [id, v] of Object.entries(state.metricsById)) {
        if (remaining.has(id)) nextMetrics[id] = v
      }
      for (const [id, v] of Object.entries(state.fileProgressById)) {
        if (remaining.has(id)) nextFileProgress[id] = v
      }
      for (const [id, v] of Object.entries(state.fileOrderById)) {
        if (remaining.has(id)) nextFileOrder[id] = v
      }
      for (const [id, v] of Object.entries(state.fileMetricsById)) {
        if (remaining.has(id)) nextFileMetrics[id] = v
      }
      for (const [id, v] of Object.entries(state._fileLastSampleById)) {
        if (remaining.has(id)) nextFileSamples[id] = v
      }
      for (const [id, v] of Object.entries(state._lastSampleById)) {
        if (remaining.has(id)) nextLast[id] = v
      }
      for (const [id, v] of Object.entries(state._startedAtById)) {
        if (remaining.has(id)) nextStarted[id] = v
      }
      for (const [id, v] of Object.entries(state._reportedSpeedById)) {
        if (remaining.has(id)) nextReported[id] = v
      }
      for (const [id, v] of Object.entries(state._settledBytesById)) {
        if (remaining.has(id)) nextSettled[id] = v
      }

      return {
        pausedById: nextPaused,
        linksById: nextLinks,
        metricsById: nextMetrics,
        fileProgressById: nextFileProgress,
        fileOrderById: nextFileOrder,
        fileMetricsById: nextFileMetrics,
        _fileLastSampleById: nextFileSamples,
        _lastSampleById: nextLast,
        _startedAtById: nextStarted,
        _reportedSpeedById: nextReported,
        _settledBytesById: nextSettled,
      }
    }),

  tick: items =>
    set(state => {
      const now = Date.now()
      let metricsById = state.metricsById
      let lastSampleById = state._lastSampleById
      let startedAtById = state._startedAtById

      for (const item of items) {
        const id = item.id
        const paused = Boolean(state.pausedById[id])
        const status = item.status ?? 'queued'
        const total = typeof item.totalBytes === 'number' ? item.totalBytes : 0
        const sent = typeof item.bytesSent === 'number' ? item.bytesSent : 0

        const isActive =
          !paused &&
          (status === 'uploading' ||
            status === 'preparing' ||
            (sent > 0 &&
              status !== 'paused' &&
              status !== 'done' &&
              status !== 'failed'))

        // Establish a stable "started at" time so speed/ETA can be computed even if the first
        // progress event arrives with bytesSent > 0 (common with larger chunks / slower UIs).
        if (isActive && startedAtById[id] === undefined) {
          if (startedAtById === state._startedAtById) {
            startedAtById = { ...state._startedAtById }
          }
          startedAtById[id] = now
        } else if (!isActive && startedAtById[id] !== undefined) {
          // Reset once inactive to avoid stale baselines.
          if (startedAtById === state._startedAtById) {
            startedAtById = { ...state._startedAtById }
          }
          startedAtById = omitKey(startedAtById, id)
        }

        // Speed is measured from settled bytes (completed files) when rclone
        // reports them. `bytesSent` includes data buffered into the current
        // chunk, which with 128 MiB chunks across several parallel transfers
        // runs ahead of what Drive has accepted - so differentiating it still
        // overstates the rate even though the value itself is a byte count.
        const settled = state._settledBytesById[id]
        const measured = typeof settled === 'number' ? settled : sent

        const prev = lastSampleById[id]
        const atMs = prev?.atMs ?? now
        const dtMs = Math.max(250, now - atMs)
        const prevSent = prev?.bytesSent ?? measured
        const delta = Math.max(0, measured - prevSent)

        // Only update the sample when bytes have actually advanced; updating the timestamp
        // every tick would make speed/ETA incorrect for large chunks.
        if (isActive && delta > 0) {
          if (lastSampleById === state._lastSampleById) {
            lastSampleById = { ...state._lastSampleById }
          }
          lastSampleById[id] = { bytesSent: measured, atMs: now }
        }

        const baselineAtMs = startedAtById[id]
        const baselineDtMs =
          baselineAtMs !== undefined ? Math.max(250, now - baselineAtMs) : dtMs

        const previousSpeed = state.metricsById[id]?.speedBytesPerSec ?? 0

        // Instantaneous rate for this tick, or the average since the transfer
        // started when no bytes have moved yet.
        const sample =
          delta > 0
            ? (delta * 1000) / dtMs
            : measured > 0 && baselineAtMs !== undefined
              ? (measured * 1000) / baselineDtMs
              : null

        // Measured from actual byte progress, NOT rclone's `speedAvg`.
        //
        // `speedAvg` counts bytes as they enter the upload buffer, so with
        // large chunks it reports the disk read rate while the chunk is still
        // being sent to Drive. That reads high and steady while the transfer
        // is really slower - the same reason rclone can sit at "100%, ETA 0s"
        // for minutes. Byte deltas over a rolling window cannot outrun what
        // has genuinely been transferred.
        //
        // rclone reports in ~1s bursts, so raw samples swing wildly. Smooth
        // them exponentially; the displayed rate settles instead of flickering.
        const speed = !isActive
          ? 0
          : sample === null
            ? previousSpeed
            : Math.max(
                0,
                Math.round(
                  previousSpeed > 0
                    ? previousSpeed + SPEED_SMOOTHING * (sample - previousSpeed)
                    : sample
                )
              )

        const etaSeconds =
          isActive && total > 0 && speed > 0
            ? Math.max(0, Math.round((total - Math.min(sent, total)) / speed))
            : status === 'done'
              ? 0
              : paused
                ? null
                : null

        const prevMetrics = state.metricsById[id]
        const nextMetrics: TransferMetrics = {
          speedBytesPerSec: speed,
          etaSeconds,
        }
        if (
          !prevMetrics ||
          prevMetrics.speedBytesPerSec !== nextMetrics.speedBytesPerSec ||
          prevMetrics.etaSeconds !== nextMetrics.etaSeconds
        ) {
          if (metricsById === state.metricsById)
            metricsById = { ...state.metricsById }
          metricsById[id] = nextMetrics
        }
      }

      return {
        metricsById,
        _lastSampleById: lastSampleById,
        _startedAtById: startedAtById,
      }
    }),
}))

function omitKey<T extends Record<string, unknown>>(obj: T, key: string): T {
  if (!(key in obj)) return obj
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { [key]: _removed, ...rest } = obj as any
  return rest as T
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * rclone reports paths relative to the source root ("sub/dir/file.txt") while
 * the pre-built file list holds absolute paths. Match on the relative path as a
 * suffix first - matching on the bare filename alone produced duplicate ghost
 * rows whenever two files in different subfolders shared a name.
 */
function resolveFileKey(existingOrder: string[], candidate: string): string {
  if (existingOrder.includes(candidate)) return candidate

  const normalized = normalizeSeparators(candidate)
  const suffixMatches = existingOrder.filter(entry => {
    const entryPath = normalizeSeparators(entry)
    return entryPath === normalized || entryPath.endsWith(`/${normalized}`)
  })
  if (suffixMatches.length === 1) return suffixMatches[0] ?? candidate
  if (suffixMatches.length > 1) return candidate

  // Nothing matched on the full relative path; fall back to a filename match,
  // but only when it is unambiguous.
  const base = getPathName(candidate)
  const baseMatches = existingOrder.filter(entry => getPathName(entry) === base)
  return baseMatches.length === 1 ? (baseMatches[0] ?? candidate) : candidate
}

function getPathName(path: string): string {
  const normalized = path.replace(/[/\\]+$/g, '')
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || normalized
}
