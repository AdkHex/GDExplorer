import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

export type UploadHistoryKind = 'file' | 'folder'

export interface UploadHistoryEntry {
  /** Stable key for the entry itself; a path can be uploaded many times. */
  id: string
  /** Display name (the file/folder's basename). */
  name: string
  /** Absolute local path it was uploaded from. */
  path: string
  kind: UploadHistoryKind
  /** Epoch ms the upload finished. */
  completedAt: number
  totalBytes: number | null
  /**
   * The Drive folder the item was uploaded into. Links are resolved lazily
   * against this, so it must be the folder actually used at upload time rather
   * than whatever the sidebar points at now.
   */
  destinationFolderId: string | null
  destinationLabel: string | null
}

/**
 * Entries kept before the oldest are dropped. History is a convenience, not an
 * archive, and an unbounded list would grow localStorage without limit.
 */
export const MAX_HISTORY_ENTRIES = 200

/**
 * Disambiguates entries recorded in the same millisecond. Two items in a batch
 * can finish together, and a shared id would collide as a React key and make
 * "remove" delete both rows.
 */
let entrySequence = 0

interface UploadHistoryState {
  entries: UploadHistoryEntry[]

  /** Records a finished upload. Newest first. */
  record: (entry: Omit<UploadHistoryEntry, 'id' | 'completedAt'>) => void
  removeEntry: (id: string) => void
  clearHistory: () => void
}

export const useUploadHistory = create<UploadHistoryState>()(
  devtools(
    persist(
      set => ({
        entries: [],

        record: entry =>
          set(
            state => {
              const completedAt = Date.now()
              const next: UploadHistoryEntry = {
                ...entry,
                // The path alone is not unique - the same folder can be
                // uploaded repeatedly - so the timestamp and a sequence
                // number disambiguate.
                id: `${entry.path}::${completedAt}::${entrySequence++}`,
                completedAt,
              }
              return {
                entries: [next, ...state.entries].slice(0, MAX_HISTORY_ENTRIES),
              }
            },
            undefined,
            'record'
          ),

        removeEntry: id =>
          set(
            state => ({
              entries: state.entries.filter(entry => entry.id !== id),
            }),
            undefined,
            'removeEntry'
          ),

        clearHistory: () => set({ entries: [] }, undefined, 'clearHistory'),
      }),
      {
        name: 'gdexplorer-upload-history',
        // Unlike the queue, history is safe to rehydrate: every entry is a
        // finished upload, so nothing comes back looking like pending work.
        partialize: state => ({ entries: state.entries }),
        // The sequence restarts at 0 on launch, so move it past every stored
        // id or a new entry could reuse one.
        onRehydrateStorage: () => state => {
          if (!state) return
          for (const entry of state.entries) {
            const stored = Number(entry.id.split('::')[2])
            if (Number.isFinite(stored)) {
              entrySequence = Math.max(entrySequence, stored + 1)
            }
          }
        },
      }
    ),
    { name: 'upload-history' }
  )
)
