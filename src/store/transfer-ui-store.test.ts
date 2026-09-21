import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useTransferUiStore } from './transfer-ui-store'

const ITEM = 'item-1'

function seedList(paths: string[]) {
  useTransferUiStore.getState().recordFileList(
    ITEM,
    paths.map(filePath => ({ filePath, bytesSent: 0, totalBytes: 100 }))
  )
}

describe('transferUiStore file progress keying', () => {
  beforeEach(() => {
    useTransferUiStore.setState({
      pausedById: {},
      metricsById: {},
      fileProgressById: {},
      fileOrderById: {},
      fileMetricsById: {},
      _fileSamplesById: {},
      _samplesById: {},
      _reportedSpeedById: {},
      _activeSinceById: {},
    })
  })

  it('maps a relative progress path onto the matching absolute entry', () => {
    seedList(['/root/a/config.json', '/root/b/config.json'])

    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, 'a/config.json', 50, 100)

    const order = useTransferUiStore.getState().fileOrderById[ITEM]
    expect(order).toEqual(['/root/a/config.json', '/root/b/config.json'])

    const progress = useTransferUiStore.getState().fileProgressById[ITEM]
    expect(progress?.['/root/a/config.json']?.bytesSent).toBe(50)
    expect(progress?.['/root/b/config.json']?.bytesSent).toBe(0)
  })

  it('does not invent a row for duplicate basenames', () => {
    seedList(['/root/a/config.json', '/root/b/config.json'])

    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, 'b/config.json', 75, 100)

    expect(useTransferUiStore.getState().fileOrderById[ITEM]).toHaveLength(2)
    expect(
      useTransferUiStore.getState().fileProgressById[ITEM]?.[
        '/root/b/config.json'
      ]?.bytesSent
    ).toBe(75)
  })

  it('still matches on filename when the relative path is unavailable', () => {
    seedList(['/root/deep/nested/only.bin'])

    useTransferUiStore.getState().recordFileProgress(ITEM, 'only.bin', 10, 100)

    expect(useTransferUiStore.getState().fileOrderById[ITEM]).toEqual([
      '/root/deep/nested/only.bin',
    ])
    expect(
      useTransferUiStore.getState().fileProgressById[ITEM]?.[
        '/root/deep/nested/only.bin'
      ]?.bytesSent
    ).toBe(10)
  })

  it('handles windows-style separators in the file list', () => {
    seedList(['C:\\root\\a\\config.json', 'C:\\root\\b\\config.json'])

    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, 'a/config.json', 25, 100)

    expect(useTransferUiStore.getState().fileOrderById[ITEM]).toHaveLength(2)
    expect(
      useTransferUiStore.getState().fileProgressById[ITEM]?.[
        'C:\\root\\a\\config.json'
      ]?.bytesSent
    ).toBe(25)
  })

  it('tracks an unknown file as a new row', () => {
    seedList(['/root/a.txt'])

    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, 'brand-new.txt', 5, 9)

    expect(useTransferUiStore.getState().fileOrderById[ITEM]).toEqual([
      '/root/a.txt',
      'brand-new.txt',
    ])
  })
})

const MIB = 1024 * 1024

/**
 * Drives `tick` at the UI's real 500ms cadence over `durationMs`, asking
 * `bytesAt` what rclone's counter reads at each instant.
 *
 * Returns the speeds and ETAs observed after `settleMs`, so the first moments -
 * where there is legitimately not enough history to measure anything - do not
 * count against the assertions. An item gets no ETA in its first minute, so
 * tests that read ETAs settle for at least that long.
 */
function runTicks(
  bytesAt: (t: number) => number,
  { durationMs = 60_000, settleMs = 20_000, totalBytes = 100_000 * MIB } = {}
) {
  const speeds: number[] = []
  const etas: (number | null)[] = []
  for (let t = 0; t <= durationMs; t += 500) {
    vi.setSystemTime(t)
    useTransferUiStore.getState().tick([
      {
        id: ITEM,
        status: 'uploading',
        bytesSent: bytesAt(t),
        totalBytes,
      },
    ])
    if (t < settleMs) continue
    const m = useTransferUiStore.getState().metricsById[ITEM]
    speeds.push(m?.speedBytesPerSec ?? 0)
    etas.push(m?.etaSeconds ?? null)
  }
  return { speeds, etas }
}

describe('transferUiStore measures the real rate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    useTransferUiStore.setState({
      pausedById: {},
      metricsById: {},
      fileProgressById: {},
      fileOrderById: {},
      fileMetricsById: {},
      _fileSamplesById: {},
      _samplesById: {},
      _reportedSpeedById: {},
      _activeSinceById: {},
    })
  })
  afterEach(() => vi.useRealTimers())

  it('reads a chunk-quantised counter at its true rate', () => {
    // rclone advances its counter one acknowledged 128 MiB chunk at a time.
    // One chunk every 3.5s is a true 36.6 MiB/s. Dividing a whole chunk by the
    // fraction of a window left after it landed is what used to display this
    // as 116 MiB/s on one stream, and ~1 GB/s across four.
    const chunk = 128 * MIB
    const { speeds } = runTicks(t => Math.floor(t / 3500) * chunk)
    const truth = chunk / 3.5

    expect(Math.max(...speeds)).toBeLessThanOrEqual(truth * 1.05)
    expect(Math.min(...speeds)).toBeGreaterThan(truth * 0.75)
  })

  it('reads a smoothly advancing counter at its true rate', () => {
    // 40 MB/s reported once a second, which is what a healthy Drive upload
    // looks like when the chunks are small relative to the stats interval.
    const perSecond = 40_000_000
    const { speeds } = runTicks(t => Math.floor(t / 1000) * perSecond)

    for (const speed of speeds) {
      expect(speed).toBeGreaterThan(perSecond * 0.9)
      expect(speed).toBeLessThanOrEqual(perSecond * 1.05)
    }
  })

  it('gives an ETA that matches the bytes actually left', () => {
    const chunk = 64 * MIB
    const totalBytes = 200 * chunk
    const bytesAt = (t: number) => Math.floor(t / 2000) * chunk
    const { etas } = runTicks(bytesAt, {
      totalBytes,
      durationMs: 120_000,
      settleMs: 60_000,
    })

    const truth = (t: number) => (totalBytes - bytesAt(t)) / (chunk / 2)
    etas.forEach((eta, i) => {
      const t = 60_000 + i * 500
      expect(eta).not.toBeNull()
      expect(eta ?? 0).toBeGreaterThan(truth(t) * 0.85)
      expect(eta ?? 0).toBeLessThan(truth(t) * 1.2)
    })
  })

  it('holds the ETA back for the first minute instead of extrapolating the opening burst', () => {
    // What a folder fan-out looks like from the counter: every connection
    // fills at once, so the first eleven seconds move 929 MiB (708 Mbps),
    // then the accounts sustain 25 MB/s. Read over a short window and
    // extrapolated over 52 GiB, that burst was "10 min left" for a job that
    // needed 35.
    const totalBytes = 52 * 1024 * MIB
    const burst = 929 * MIB
    const burstMs = 11_000
    const sustained = 25_000_000
    const bytesAt = (t: number) =>
      t < burstMs
        ? Math.floor((t / burstMs) * burst)
        : burst + Math.floor((t - burstMs) / 1000) * sustained
    const { speeds, etas } = runTicks(bytesAt, {
      totalBytes,
      durationMs: 150_000,
      settleMs: 0,
    })
    const at = (t: number) => t / 500

    // No ETA at all while the burst is the whole history.
    for (let t = 0; t < 60_000; t += 500) expect(etas[at(t)]).toBeNull()
    expect(etas[at(60_000)]).not.toBeNull()

    // Once the burst has aged out of the window, rate and ETA are the
    // sustained truth, not the opening seconds.
    const truthEta = (t: number) => (totalBytes - bytesAt(t)) / sustained
    for (let t = 75_000; t <= 150_000; t += 500) {
      expect(speeds[at(t)]).toBeGreaterThan(sustained * 0.9)
      expect(speeds[at(t)]).toBeLessThanOrEqual(sustained * 1.05)
      expect(etas[at(t)] ?? 0).toBeGreaterThan(truthEta(t) * 0.95)
      expect(etas[at(t)] ?? 0).toBeLessThan(truthEta(t) * 1.1)
    }
  })

  it('decays to zero and drops the ETA when the transfer stalls', () => {
    // Moves for 20s, then nothing. The rate charges the idle time as it
    // grows and reads 0 once nothing has moved for a whole window.
    const { speeds, etas } = runTicks(t => Math.min(t, 20_000) * 40_000, {
      durationMs: 90_000,
      settleMs: 0,
    })

    const at = (t: number) => t / 500
    expect(speeds[at(20_000)]).toBeGreaterThan(0)
    expect(speeds[at(50_000)]).toBeLessThan(speeds[at(20_000)] ?? 0)
    expect(speeds[speeds.length - 1]).toBe(0)
    expect(etas[etas.length - 1]).toBeNull()
  })

  it('recovers when rclone restarts and its counter goes backwards', () => {
    // A Windows pause kills rclone; on resume its counter describes only the
    // remaining work, so it reads far lower than before. The row must measure
    // the new run rather than wait for the counter to pass its old peak.
    const bytesAt = (t: number) =>
      t < 30_000 ? t * 40_000 : (t - 30_000) * 40_000

    const { speeds } = runTicks(bytesAt, { settleMs: 45_000 })

    for (const speed of speeds) {
      expect(speed).toBeGreaterThan(40_000_000 * 0.9)
      expect(speed).toBeLessThanOrEqual(40_000_000 * 1.05)
    }
  })

  it('reports no rate for an item that is not running', () => {
    runTicks(t => t * 40_000, { durationMs: 20_000, settleMs: 20_000 })
    expect(
      useTransferUiStore.getState().metricsById[ITEM]?.speedBytesPerSec
    ).toBeGreaterThan(0)

    vi.setSystemTime(21_000)
    useTransferUiStore
      .getState()
      .tick([{ id: ITEM, status: 'paused', bytesSent: 1e9, totalBytes: 1e10 }])

    const m = useTransferUiStore.getState().metricsById[ITEM]
    expect(m?.speedBytesPerSec).toBe(0)
    expect(m?.etaSeconds).toBeNull()
    // The history is dropped, so a resume measures its own rate.
    expect(useTransferUiStore.getState()._samplesById[ITEM]).toBeUndefined()
  })

  it('shows rclone reported speed until bytes have settled', () => {
    // Before the first chunk lands there is only one reading, so there is no
    // measured rate yet. The row shows rclone's own current speed instead of
    // 0 - but no ETA, which waits for a minute of history like any other.
    useTransferUiStore.getState().recordItemSpeed(ITEM, 3_000_000)

    vi.setSystemTime(0)
    useTransferUiStore
      .getState()
      .tick([
        { id: ITEM, status: 'uploading', bytesSent: 0, totalBytes: 100 * MIB },
      ])

    const m = useTransferUiStore.getState().metricsById[ITEM]
    expect(m?.speedBytesPerSec).toBe(3_000_000)
    expect(m?.etaSeconds).toBeNull()
  })
})

describe('transferUiStore measures per-file rates the same way', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    useTransferUiStore.setState({
      pausedById: {},
      metricsById: {},
      fileProgressById: {},
      fileOrderById: {},
      fileMetricsById: {},
      _fileSamplesById: {},
      _samplesById: {},
      _reportedSpeedById: {},
      _activeSinceById: {},
    })
  })
  afterEach(() => vi.useRealTimers())

  it('reads a chunked file at its true rate, not rclone speedAvg', () => {
    seedList(['/root/big.mkv'])
    const chunk = 128 * MIB
    const total = 400 * chunk

    let last = 0
    for (let t = 0; t <= 60_000; t += 1000) {
      vi.setSystemTime(t)
      useTransferUiStore
        .getState()
        .recordFileProgress(
          ITEM,
          '/root/big.mkv',
          Math.floor(t / 3500) * chunk,
          total
        )
      if (t >= 20_000) {
        last =
          useTransferUiStore.getState().fileMetricsById[ITEM]?.['/root/big.mkv']
            ?.speedBytesPerSec ?? 0
        expect(last).toBeLessThanOrEqual((chunk / 3.5) * 1.05)
      }
    }
    expect(last).toBeGreaterThan((chunk / 3.5) * 0.75)
  })

  it('does not let the pre-built file list backdate a file that starts late', () => {
    // The listing arrives at t=0; this file only starts moving ten minutes in.
    // A zero recorded at t=0 would put the window's left edge before its first
    // byte and hold the row near 0 B/s for its whole transfer.
    seedList(['/root/late.mkv'])

    vi.setSystemTime(600_000)
    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, '/root/late.mkv', 0, 100 * MIB)
    vi.setSystemTime(602_000)
    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, '/root/late.mkv', 40 * MIB, 100 * MIB)

    const speed =
      useTransferUiStore.getState().fileMetricsById[ITEM]?.['/root/late.mkv']
        ?.speedBytesPerSec ?? 0
    expect(speed).toBeGreaterThan(20 * MIB * 0.9)
    expect(speed).toBeLessThanOrEqual(20 * MIB * 1.05)
  })

  it('zeroes the file rate once the file is complete', () => {
    seedList(['/root/a.txt'])
    vi.setSystemTime(1000)
    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, '/root/a.txt', 50, 100)
    vi.setSystemTime(2000)
    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, '/root/a.txt', 100, 100)

    const m =
      useTransferUiStore.getState().fileMetricsById[ITEM]?.['/root/a.txt']
    expect(m?.speedBytesPerSec).toBe(0)
    expect(m?.etaSeconds).toBe(0)
  })

  it('falls back to rclone reported speed before the first chunk', () => {
    vi.setSystemTime(0)
    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, '/root/big.mkv', 0, 100 * MIB, 2_500_000)

    const m =
      useTransferUiStore.getState().fileMetricsById[ITEM]?.['/root/big.mkv']
    expect(m?.speedBytesPerSec).toBe(2_500_000)
    expect(m?.etaSeconds).toBeGreaterThan(0)
  })
})
