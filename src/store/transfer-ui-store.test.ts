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
