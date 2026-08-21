import { describe, it, expect, beforeEach } from 'vitest'
import { useUploadHistory, MAX_HISTORY_ENTRIES } from './upload-history-store'

const BASE = {
  name: 'Movie',
  path: '/movies/Movie',
  kind: 'folder' as const,
  totalBytes: 1024,
  destinationFolderId: 'folder-1',
  destinationLabel: 'Shared Drive',
}

describe('uploadHistoryStore', () => {
  beforeEach(() => {
    useUploadHistory.setState({ entries: [] })
  })

  it('records the newest upload first', () => {
    useUploadHistory.getState().record({ ...BASE, name: 'First' })
    useUploadHistory.getState().record({ ...BASE, name: 'Second' })

    const names = useUploadHistory.getState().entries.map(e => e.name)
    expect(names).toEqual(['Second', 'First'])
  })

  it('keeps the destination so links resolve later', () => {
    useUploadHistory.getState().record(BASE)

    const entry = useUploadHistory.getState().entries[0]
    expect(entry?.destinationFolderId).toBe('folder-1')
    expect(entry?.destinationLabel).toBe('Shared Drive')
    expect(entry?.completedAt).toBeGreaterThan(0)
  })

  it('gives repeat uploads of the same path distinct ids', () => {
    // The path alone is not unique, so re-uploading must not collide and drop
    // a React list key.
    useUploadHistory.getState().record(BASE)
    useUploadHistory.getState().record(BASE)

    const [first, second] = useUploadHistory.getState().entries
    expect(first?.id).not.toBe(second?.id)
  })

  it('caps the list at the maximum', () => {
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 10; i++) {
      useUploadHistory.getState().record({ ...BASE, name: `Item ${i}` })
    }

    const entries = useUploadHistory.getState().entries
    expect(entries).toHaveLength(MAX_HISTORY_ENTRIES)
    // The oldest are the ones dropped.
    expect(entries[0]?.name).toBe(`Item ${MAX_HISTORY_ENTRIES + 9}`)
  })

  it('removes a single entry and clears the rest', () => {
    useUploadHistory.getState().record({ ...BASE, name: 'Keep' })
    useUploadHistory.getState().record({ ...BASE, name: 'Drop' })

    const dropId = useUploadHistory
      .getState()
      .entries.find(e => e.name === 'Drop')?.id
    useUploadHistory.getState().removeEntry(dropId as string)

    expect(useUploadHistory.getState().entries.map(e => e.name)).toEqual([
      'Keep',
    ])

    useUploadHistory.getState().clearHistory()
    expect(useUploadHistory.getState().entries).toEqual([])
  })
})
