import { create } from 'zustand'
import { createJSONStorage, devtools, persist } from 'zustand/middleware'

export type LocalUploadItemKind = 'file' | 'folder'

export interface LocalUploadItem {
  id: string
  path: string
  kind: LocalUploadItemKind
  addedAt: number
  status?: 'queued' | 'preparing' | 'uploading' | 'paused' | 'done' | 'failed'
  message?: string | null
  bytesSent?: number
  totalBytes?: number
  saEmail?: string | null
  /**
   * Per-item Drive destination. Null means "use whatever the sidebar is set
   * to", so existing rows keep working and only overridden ones pin a folder.
   */
  destinationFolderId?: string | null
  destinationLabel?: string | null
  /**
   * The folder this item was actually uploaded into, recorded when the upload
   * starts. The sidebar destination can change afterwards, and looking a
   * finished item's Drive links up against the new one finds nothing.
   */
  uploadedToFolderId?: string | null
}

interface LocalUploadQueueState {
  items: LocalUploadItem[]

  addItems: (items: Pick<LocalUploadItem, 'path' | 'kind'>[]) => void
  addFiles: (paths: string[]) => void
  addFolders: (paths: string[]) => void
  setItemStatus: (
    itemId: string,
    status: LocalUploadItem['status'],
    message?: string | null,
    saEmail?: string | null
  ) => void
  setItemProgress: (
    itemId: string,
    bytesSent: number,
    totalBytes: number
  ) => void
  setItemsDestination: (
    itemIds: string[],
    destinationFolderId: string | null,
    destinationLabel: string | null
  ) => void
  recordUploadDestination: (itemId: string, folderId: string) => void
  resetUploadState: () => void
  resetItemsUploadState: (itemIds: string[]) => void
  resetStaleUploadState: () => void
  remove: (path: string) => void
  clear: () => void
}

function addUniqueItems(
  existing: LocalUploadItem[],
  incoming: Pick<LocalUploadItem, 'path' | 'kind'>[]
): LocalUploadItem[] {
  if (incoming.length === 0) return existing

  const existingPaths = new Set(existing.map(item => item.path))
  const newItems: LocalUploadItem[] = []

  for (const { path, kind } of incoming) {
    if (existingPaths.has(path)) continue
    existingPaths.add(path)
    newItems.push({
      id: path,
      path,
      kind,
      addedAt: Date.now(),
      status: 'queued',
    })
  }

  return existing.concat(newItems)
}

export const useLocalUploadQueue = create<LocalUploadQueueState>()(
  devtools(
    persist(
      set => ({
        items: [],

        addItems: incoming =>
          set(
            state => ({
              items: addUniqueItems(state.items, incoming),
            }),
            undefined,
            'addItems'
          ),

        addFiles: paths =>
          set(
            state => ({
              items: addUniqueItems(
                state.items,
                paths.map(path => ({ path, kind: 'file' as const }))
              ),
            }),
            undefined,
            'addFiles'
          ),

        addFolders: paths =>
          set(
            state => ({
              items: addUniqueItems(
                state.items,
                paths.map(path => ({ path, kind: 'folder' as const }))
              ),
            }),
            undefined,
            'addFolders'
          ),

        // Not every status event carries the service account (pause/resume events
        // omit it), so keep the last known value instead of blanking it out.
        setItemStatus: (itemId, status, message = null, saEmail = null) =>
          set(
            state => ({
              items: state.items.map(item =>
                item.id === itemId
                  ? {
                      ...item,
                      status,
                      message,
                      saEmail: saEmail ?? item.saEmail ?? null,
                    }
                  : item
              ),
            }),
            undefined,
            'setItemStatus'
          ),

        setItemProgress: (itemId, bytesSent, totalBytes) =>
          set(
            state => ({
              items: state.items.map(item =>
                item.id === itemId ? { ...item, bytesSent, totalBytes } : item
              ),
            }),
            undefined,
            'setItemProgress'
          ),

        setItemsDestination: (itemIds, destinationFolderId, destinationLabel) =>
          set(
            state => {
              if (itemIds.length === 0) return state
              const ids = new Set(itemIds)
              return {
                items: state.items.map(item =>
                  ids.has(item.id)
                    ? { ...item, destinationFolderId, destinationLabel }
                    : item
                ),
              }
            },
            undefined,
            'setItemsDestination'
          ),

        recordUploadDestination: (itemId, folderId) =>
          set(
            state => ({
              items: state.items.map(item =>
                item.id === itemId
                  ? { ...item, uploadedToFolderId: folderId }
                  : item
              ),
            }),
            undefined,
            'recordUploadDestination'
          ),

        resetUploadState: () =>
          set(
            state => ({
              items: state.items.map(item => ({
                ...item,
                status: 'queued',
                message: null,
                bytesSent: undefined,
                totalBytes: undefined,
                saEmail: null,
              })),
            }),
            undefined,
            'resetUploadState'
          ),

        resetItemsUploadState: itemIds =>
          set(
            state => {
              if (itemIds.length === 0) return state
              const ids = new Set(itemIds)
              return {
                items: state.items.map(item =>
                  ids.has(item.id)
                    ? {
                        ...item,
                        status: 'queued',
                        message: null,
                        bytesSent: undefined,
                        totalBytes: undefined,
                        saEmail: null,
                      }
                    : item
                ),
              }
            },
            undefined,
            'resetItemsUploadState'
          ),

        // When a job ends, anything still shown as in-flight never got a terminal
        // status from the backend (typically it was never dequeued before a
        // cancel). Put those rows back to "queued" instead of leaving them stuck
        // on "Preparing" forever.
        resetStaleUploadState: () =>
          set(
            state => {
              const inFlight = new Set(['preparing', 'uploading', 'paused'])
              if (!state.items.some(item => inFlight.has(item.status ?? ''))) {
                return state
              }
              return {
                items: state.items.map(item =>
                  inFlight.has(item.status ?? '')
                    ? {
                        ...item,
                        status: 'queued' as const,
                        message: null,
                        bytesSent: undefined,
                        totalBytes: undefined,
                      }
                    : item
                ),
              }
            },
            undefined,
            'resetStaleUploadState'
          ),

        remove: path =>
          set(
            state => ({
              items: state.items.filter(item => item.path !== path),
            }),
            undefined,
            'remove'
          ),

        clear: () => set({ items: [] }, undefined, 'clear'),
      }),
      {
        name: 'gdexplorer-upload-queue',
        storage: createJSONStorage(() => localStorage),
        // Only the durable identity of a queued item survives a restart.
        // Progress, status and the service account used are all specific to a
        // run, so rehydrated rows come back as plain queued entries.
        partialize: state => ({
          items: state.items.map(({ id, path, kind, addedAt }) => ({
            id,
            path,
            kind,
            addedAt,
          })),
        }),
      }
    ),
    { name: 'local-upload-queue' }
  )
)
