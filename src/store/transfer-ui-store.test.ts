import { describe, it, expect, beforeEach } from 'vitest'
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
      _fileLastSampleById: {},
      _lastSampleById: {},
      _startedAtById: {},
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

describe('transferUiStore speed is measured, not reported', () => {
  beforeEach(() => {
    useTransferUiStore.setState({
      pausedById: {},
      metricsById: {},
      fileProgressById: {},
      fileOrderById: {},
      fileMetricsById: {},
      _fileLastSampleById: {},
      _lastSampleById: {},
      _startedAtById: {},
      _reportedSpeedById: {},
    })
  })

  it('ignores rclone speedAvg for a file and measures byte progress', () => {
    // speedAvg counts buffered bytes, so a huge reported value must not be
    // displayed when almost nothing has actually moved.
    seedList(['/root/a.txt'])

    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, '/root/a.txt', 50, 100, 999_999_999)

    const speed =
      useTransferUiStore.getState().fileMetricsById[ITEM]?.['/root/a.txt']
        ?.speedBytesPerSec ?? 0
    expect(speed).not.toBe(999_999_999)
    // The seeded list gives a 0-byte baseline, so this is a real measurement:
    // 50 bytes over the minimum 250ms window = 200 B/s.
    expect(speed).toBe(200)
  })

  it('zeroes the file speed once the file is complete', () => {
    seedList(['/root/a.txt'])

    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, '/root/a.txt', 50, 100)
    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, '/root/a.txt', 100, 100)

    expect(
      useTransferUiStore.getState().fileMetricsById[ITEM]?.['/root/a.txt']
        ?.speedBytesPerSec
    ).toBe(0)
  })

  it('ignores a reported item speed in tick', () => {
    // The headline symptom: rclone claims a high rate while the transfer is
    // barely moving. The row must reflect the bytes, not the claim.
    useTransferUiStore.getState().recordItemSpeed(ITEM, 999_999_999)
    useTransferUiStore
      .getState()
      .tick([
        { id: ITEM, status: 'uploading', bytesSent: 10, totalBytes: 1000 },
      ])

    expect(
      useTransferUiStore.getState().metricsById[ITEM]?.speedBytesPerSec
    ).not.toBe(999_999_999)
  })

  it('measures the item rate from byte deltas', () => {
    // The first tick only anchors the window; a rate needs two observations.
    useTransferUiStore
      .getState()
      .tick([
        { id: ITEM, status: 'uploading', bytesSent: 10, totalBytes: 1000 },
      ])

    // Backdate the anchor by a second, then report 1010 more bytes.
    useTransferUiStore.setState({
      _lastSampleById: { [ITEM]: { bytesSent: 10, atMs: Date.now() - 1000 } },
    })
    useTransferUiStore
      .getState()
      .tick([
        { id: ITEM, status: 'uploading', bytesSent: 1020, totalBytes: 100_000 },
      ])

    // ~1010 bytes over ~1s. Allow slack for timer jitter.
    const speed =
      useTransferUiStore.getState().metricsById[ITEM]?.speedBytesPerSec ?? 0
    expect(speed).toBeGreaterThan(900)
    expect(speed).toBeLessThan(1200)
  })
})

describe('transferUiStore item speed reflects the current rate', () => {
  beforeEach(() => {
    useTransferUiStore.setState({
      pausedById: {},
      metricsById: {},
      _lastSampleById: {},
      _startedAtById: {},
      _reportedSpeedById: {},
    })
  })

  it('holds the last measured rate when no bytes moved', () => {
    // Two ticks with real movement establish a rate...
    useTransferUiStore.setState({
      _startedAtById: { [ITEM]: Date.now() - 1000 },
      _lastSampleById: { [ITEM]: { bytesSent: 0, atMs: Date.now() - 1000 } },
    })
    useTransferUiStore
      .getState()
      .tick([
        { id: ITEM, status: 'uploading', bytesSent: 1000, totalBytes: 100_000 },
      ])
    const first =
      useTransferUiStore.getState().metricsById[ITEM]?.speedBytesPerSec ?? 0
    expect(first).toBeGreaterThan(0)

    // ...and a tick with no new bytes must not invent a different number.
    useTransferUiStore
      .getState()
      .tick([
        { id: ITEM, status: 'uploading', bytesSent: 1000, totalBytes: 100_000 },
      ])
    expect(
      useTransferUiStore.getState().metricsById[ITEM]?.speedBytesPerSec
    ).toBe(first)
  })

  it('does not report the lifetime average as the current rate', () => {
    // The reported bug: a folder that moved 120 GiB quickly and is now down to
    // one slow file must not keep showing the fast historical average.
    const startedAt = Date.now() - 600_000 // ten minutes ago
    useTransferUiStore.setState({
      _startedAtById: { [ITEM]: startedAt },
      _lastSampleById: {
        [ITEM]: { bytesSent: 120_000_000_000, atMs: Date.now() - 2000 },
      },
      metricsById: {
        [ITEM]: { speedBytesPerSec: 6_000_000, etaSeconds: null },
      },
    })

    // No new bytes this tick.
    useTransferUiStore.getState().tick([
      {
        id: ITEM,
        status: 'uploading',
        bytesSent: 120_000_000_000,
        totalBytes: 134_000_000_000,
      },
    ])

    const speed =
      useTransferUiStore.getState().metricsById[ITEM]?.speedBytesPerSec ?? 0
    // 120 GB / 600s would be ~200 MB/s. It must hold 6 MB/s instead.
    expect(speed).toBe(6_000_000)
    expect(speed).toBeLessThan(50_000_000)
  })
})

describe('transferUiStore establishes a rate from a cold start', () => {
  beforeEach(() => {
    useTransferUiStore.setState({
      pausedById: {},
      metricsById: {},
      fileProgressById: {},
      fileOrderById: {},
      fileMetricsById: {},
      _fileLastSampleById: {},
      _lastSampleById: {},
      _startedAtById: {},
      _reportedSpeedById: {},
    })
  })

  it('anchors an item that is already mid-transfer', () => {
    // The reported bug: an upload already at 2.4% with no stored sample read
    // "0 bps" forever, because the baseline defaulted to the current byte
    // count and the delta could never become positive.
    useTransferUiStore.getState().tick([
      {
        id: ITEM,
        status: 'uploading',
        bytesSent: 7_000_000_000,
        totalBytes: 297_000_000_000,
      },
    ])

    const anchor = useTransferUiStore.getState()._lastSampleById[ITEM]
    expect(anchor).toBeDefined()
    expect(anchor?.bytesSent).toBe(7_000_000_000)

    // Once bytes advance past the window, a real rate appears.
    useTransferUiStore.setState({
      _lastSampleById: {
        [ITEM]: { bytesSent: 7_000_000_000, atMs: Date.now() - 4000 },
      },
    })
    useTransferUiStore.getState().tick([
      {
        id: ITEM,
        status: 'uploading',
        bytesSent: 7_400_000_000,
        totalBytes: 297_000_000_000,
      },
    ])

    expect(
      useTransferUiStore.getState().metricsById[ITEM]?.speedBytesPerSec ?? 0
    ).toBeGreaterThan(0)
  })

  it('anchors a file row that is already mid-transfer', () => {
    seedList(['/root/big.mkv'])
    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, '/root/big.mkv', 500_000_000, 14_000_000_000)

    // Backdate past the window, then report more bytes.
    const samples = useTransferUiStore.getState()._fileLastSampleById[ITEM]
    useTransferUiStore.setState({
      _fileLastSampleById: {
        [ITEM]: {
          ...samples,
          '/root/big.mkv': { bytesSent: 500_000_000, atMs: Date.now() - 4000 },
        },
      },
    })
    useTransferUiStore
      .getState()
      .recordFileProgress(ITEM, '/root/big.mkv', 600_000_000, 14_000_000_000)

    expect(
      useTransferUiStore.getState().fileMetricsById[ITEM]?.['/root/big.mkv']
        ?.speedBytesPerSec ?? 0
    ).toBeGreaterThan(0)
  })

  it('reports zero once a stalled window elapses', () => {
    useTransferUiStore.setState({
      _lastSampleById: { [ITEM]: { bytesSent: 1000, atMs: Date.now() - 5000 } },
      metricsById: { [ITEM]: { speedBytesPerSec: 500_000, etaSeconds: 10 } },
    })
    useTransferUiStore
      .getState()
      .tick([
        { id: ITEM, status: 'uploading', bytesSent: 1000, totalBytes: 100_000 },
      ])

    // Nothing moved for 5s: the honest rate is 0, not the stale 500 kB/s.
    expect(
      useTransferUiStore.getState().metricsById[ITEM]?.speedBytesPerSec
    ).toBeLessThan(500_000)
  })
})
