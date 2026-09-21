import { describe, it, expect } from 'vitest'
import { summarizeQueue } from './summary'
import type { LocalUploadItem } from '@/store/local-upload-queue-store'

const MIB = 1024 * 1024

function uploading(
  id: string,
  bytesSent: number,
  totalBytes: number
): LocalUploadItem {
  return {
    id,
    path: `/${id}`,
    kind: 'folder',
    addedAt: 0,
    status: 'uploading',
    bytesSent,
    totalBytes,
  }
}

describe('summarizeQueue', () => {
  it('rolls the queue ETA up from the item rates', () => {
    const items = [uploading('a', 100 * MIB, 1000 * MIB)]
    const summary = summarizeQueue(
      items,
      { a: { speedBytesPerSec: 10 * MIB, etaSeconds: 90 } },
      {}
    )
    expect(summary.speedBytesPerSec).toBe(10 * MIB)
    expect(summary.etaSeconds).toBe(90)
  })

  it('shows the speed but no ETA while an item is still in its opening minute', () => {
    // The item has a rate but the store has held its ETA back, because that
    // rate is the burst of every connection filling at once. The roll-up must
    // not extrapolate it either.
    const items = [uploading('a', 929 * MIB, 52 * 1024 * MIB)]
    const summary = summarizeQueue(
      items,
      { a: { speedBytesPerSec: 88_500_000, etaSeconds: null } },
      {}
    )
    expect(summary.speedBytesPerSec).toBe(88_500_000)
    expect(summary.etaSeconds).toBeNull()
  })

  it('waits for every moving item, not just the first', () => {
    const items = [
      uploading('settled', 500 * MIB, 1000 * MIB),
      uploading('fresh', 50 * MIB, 1000 * MIB),
    ]
    const summary = summarizeQueue(
      items,
      {
        settled: { speedBytesPerSec: 10 * MIB, etaSeconds: 50 },
        fresh: { speedBytesPerSec: 40 * MIB, etaSeconds: null },
      },
      {}
    )
    expect(summary.speedBytesPerSec).toBe(50 * MIB)
    expect(summary.etaSeconds).toBeNull()
  })
})
