import { create } from 'zustand'

type UploadRuntimeStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'paused'
  | 'done'
  | 'failed'

/**
 * How far back a rate is measured. Long enough to span several of rclone's
 * counter updates, so a genuine change in speed shows up within a few seconds
 * without every individual update swinging the number.
 */
const SPEED_WINDOW_MS = 15_000

/** Below this much observed history there is nothing honest to report. */
const MIN_SPEED_SPAN_MS = 1000

/**
 * One observation of a byte counter. Only recorded when the counter actually
 * moved, which is what makes the rate below exact - see `measureRate`.
 */
interface Sample {
  atMs: number
  bytes: number
}

/**
 * Records a counter reading, keeping only the last `SPEED_WINDOW_MS` of them.
 *
 * Readings where nothing moved are deliberately dropped rather than stored.
 * rclone advances its byte counters in bursts (one acknowledged chunk at a
 * time, and only when it emits a stats line), so the timestamps that matter
 * are the ones where bytes arrived. Keeping only those means the first and
 * last sample are both arrival instants, and the division in `measureRate`
 * covers a whole number of arrivals instead of a window that happens to cut
 * one in half.
 */
function pushSample(
  history: Sample[] | undefined,
  bytes: number,
  now: number
): Sample[] {
  const previous = history ?? []
  const last = previous[previous.length - 1]
  if (last) {
    // The counter went backwards, so rclone restarted for this item (a Windows
    // pause, or a retry) and now counts only the work that is left. Start over
    // rather than waiting for it to climb back past the old peak, which would
    // strand the row at "0 B/s" for the rest of the transfer.
    if (bytes < last.bytes) return [{ atMs: now, bytes }]
    if (bytes === last.bytes) return previous
  }

  const kept = previous.filter(sample => sample.atMs >= now - SPEED_WINDOW_MS)
  // Always keep one older reading when the window has emptied, so a link slow
  // enough that its updates are further apart than the window still has two
  // points to measure between.
  return [
    ...(kept.length > 0 ? kept : previous.slice(-1)),
    { atMs: now, bytes },
  ]
}

/**
 * Bytes per second over the recorded window, as measured rather than smoothed.
 *
 * The numerator spans arrival to arrival, so it is an exact average over a
 * whole number of counter updates. The denominator additionally charges any
 * idle time beyond one typical gap between updates, which is what makes a
 * transfer that has gone quiet decay instead of freezing at its last rate.
 *
 * Both halves of that are one-directional: this can read low while a chunk is
 * still in flight, and can never read higher than the bytes that arrived.
 */
function measureRate(samples: Sample[] | undefined, now: number): number {
  if (!samples || samples.length < 2) return 0

  // Age readings out against `now`, not only when a new one arrives: a stalled
  // transfer stops producing samples altogether.
  const recent = samples.filter(sample => sample.atMs >= now - SPEED_WINDOW_MS)
  const window = recent.length >= 2 ? recent : samples.slice(-2)

  const first = window[0]
  const last = window[window.length - 1]
  if (!first || !last) return 0

  const span = last.atMs - first.atMs
  const moved = last.bytes - first.bytes
  if (span <= 0 || moved <= 0) return 0

  const typicalGap = span / (window.length - 1)
  // Nothing has arrived for far longer than this transfer's own cadence, so
  // it is stalled rather than part-way through an update. The honest rate is 0.
  if (now - last.atMs >= Math.max(SPEED_WINDOW_MS, typicalGap * 4)) return 0

  const idle = Math.max(0, now - last.atMs - typicalGap)
  const elapsed = span + idle
  if (elapsed < MIN_SPEED_SPAN_MS) return 0

  return Math.max(0, Math.round((moved * 1000) / elapsed))
}

/** Seconds left at the current rate, or null when there is no rate to go on. */
function etaFrom(
  bytesSent: number,
  totalBytes: number,
  speedBytesPerSec: number
): number | null {
  if (speedBytesPerSec <= 0 || totalBytes <= 0) return null
  const remaining = totalBytes - Math.min(bytesSent, totalBytes)
  if (remaining <= 0) return 0
  return Math.round(remaining / speedBytesPerSec)
}

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
  _fileSamplesById: Record<string, Record<string, Sample[]>>
  _samplesById: Record<string, Sample[]>

  isPaused: (id: string) => boolean
  setPaused: (id: string, paused: boolean) => void
  pauseAll: (ids: string[]) => void
  resumeAll: (ids: string[]) => void
  recordFileProgress: (
    itemId: string,
    filePath: string,
    bytesSent: number,
    totalBytes: number
  ) => void
  recordFileList: (itemId: string, files: FileProgressByPath[]) => void
  setItemLinks: (itemId: string, links: ItemDriveLinks) => void
  clearFileProgress: (itemIds: string[]) => void
  clearRemoved: (remainingIds: string[]) => void

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
  _fileSamplesById: {},
  _samplesById: {},

  isPaused: id => Boolean(get().pausedById[id]),

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
      const existingSamples = state._fileSamplesById[itemId]
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
      // Measured from the file's own byte progress, never from rclone's
      // `speedAvg`: that counts bytes as they enter the upload buffer, so with
      // large chunks it reports the disk read rate rather than what Drive has
      // accepted. See `measureRate` for how the rate is derived.
      const samples = pushSample(existingSamples?.[resolvedKey], bytesSent, now)
      const complete = totalBytes > 0 && bytesSent >= totalBytes
      const speed = complete ? 0 : measureRate(samples, now)
      const etaSeconds = complete ? 0 : etaFrom(bytesSent, totalBytes, speed)

      const nextSamples = {
        ...(existingSamples ?? {}),
        [resolvedKey]: samples,
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
        _fileSamplesById: {
          ...state._fileSamplesById,
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

      // Metrics start empty and stay that way until the file actually moves.
      // Samples are deliberately NOT pre-seeded here: a zero recorded when the
      // listing arrived would put the window's left edge minutes before the
      // file's first byte, and the rate would read near zero for its whole
      // transfer.
      const nextMetrics: Record<string, FileMetrics> = {}
      for (const filePath of nextOrder) {
        nextMetrics[filePath] = { speedBytesPerSec: 0, etaSeconds: null }
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
      }
    }),

  clearFileProgress: itemIds =>
    set(state => {
      if (itemIds.length === 0) return state
      const ids = new Set(itemIds)
      const nextById: Record<string, Record<string, FileProgress>> = {}
      const nextOrderById: Record<string, string[]> = {}
      const nextMetricsById: Record<string, Record<string, FileMetrics>> = {}
      const nextSamplesById: Record<string, Record<string, Sample[]>> = {}

      for (const [id, value] of Object.entries(state.fileProgressById)) {
        if (!ids.has(id)) nextById[id] = value
      }
      for (const [id, value] of Object.entries(state.fileOrderById)) {
        if (!ids.has(id)) nextOrderById[id] = value
      }
      for (const [id, value] of Object.entries(state.fileMetricsById)) {
        if (!ids.has(id)) nextMetricsById[id] = value
      }
      for (const [id, value] of Object.entries(state._fileSamplesById)) {
        if (!ids.has(id)) nextSamplesById[id] = value
      }

      return {
        fileProgressById: nextById,
        fileOrderById: nextOrderById,
        fileMetricsById: nextMetricsById,
        _fileSamplesById: nextSamplesById,
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
      const nextFileSamples: Record<string, Record<string, Sample[]>> = {}
      const nextSamples: Record<string, Sample[]> = {}

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
      for (const [id, v] of Object.entries(state._fileSamplesById)) {
        if (remaining.has(id)) nextFileSamples[id] = v
      }
      for (const [id, v] of Object.entries(state._samplesById)) {
        if (remaining.has(id)) nextSamples[id] = v
      }

      return {
        pausedById: nextPaused,
        linksById: nextLinks,
        metricsById: nextMetrics,
        fileProgressById: nextFileProgress,
        fileOrderById: nextFileOrder,
        fileMetricsById: nextFileMetrics,
        _fileSamplesById: nextFileSamples,
        _samplesById: nextSamples,
      }
    }),

  tick: items =>
    set(state => {
      const now = Date.now()
      let metricsById = state.metricsById
      let samplesById = state._samplesById

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

        // The rate is measured, not smoothed: `pushSample` keeps the instants
        // the byte counter actually moved and `measureRate` divides across a
        // whole number of them. Deriving it from rclone's own `speedAvg` is
        // wrong for a different reason - that counts bytes as they enter the
        // upload buffer, so with large chunks it reports the disk read rate
        // rather than what Drive has accepted.
        let speed = 0
        if (isActive) {
          const previous = samplesById[id]
          const samples = pushSample(previous, sent, now)
          if (samples !== previous) {
            if (samplesById === state._samplesById) {
              samplesById = { ...state._samplesById }
            }
            samplesById[id] = samples
          }
          speed = measureRate(samples, now)
        } else {
          // Drop the history when an item stops, so a resumed transfer
          // measures its own rate instead of averaging across the pause.
          samplesById = omitKey(samplesById, id)
        }

        const etaSeconds =
          status === 'done' ? 0 : isActive ? etaFrom(sent, total, speed) : null

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

      return { metricsById, _samplesById: samplesById }
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
