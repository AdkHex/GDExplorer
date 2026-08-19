import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useUploadDestinationStore } from '@/store/upload-destination-store'
import { useTransferUiStore } from '@/store/transfer-ui-store'
import { useUIStore } from '@/store/ui-store'
import { TransferTable } from '@/components/transfers/TransferTable'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'

function normalizeSelection(
  selection: string | string[] | null
): string[] | null {
  if (selection === null) return null
  return Array.isArray(selection) ? selection : [selection]
}

/**
 * The destination field lives in the left sidebar, which the user may have
 * collapsed - reveal it first, then focus, or the "fix it" hint goes nowhere.
 */
function focusDestinationInput() {
  useUIStore.getState().setLeftSidebarVisible(true)
  requestAnimationFrame(() => {
    const element = document.getElementById('destination-url')
    if (element instanceof HTMLInputElement) {
      element.focus()
      element.select()
    }
  })
}

export function BrowseLocalFiles() {
  const {
    items,
    addFiles,
    addFolders,
    setItemProgress,
    setItemStatus,
    resetItemsUploadState,
    resetStaleUploadState,
    remove: removeItem,
  } = useLocalUploadQueue()
  const recordFileProgress = useTransferUiStore(s => s.recordFileProgress)
  const recordFileList = useTransferUiStore(s => s.recordFileList)
  const clearFileProgress = useTransferUiStore(s => s.clearFileProgress)
  const { destinationError, destinationFolderId } = useUploadDestinationStore()
  const [isBrowsing, setIsBrowsing] = useState(false)
  const [isDropActive, setIsDropActive] = useState(false)
  const [isUploading, setIsUploading] = useState(false)

  // Files and folders are picked separately. Previously one "Browse" click
  // opened a file dialog and then unconditionally a folder dialog, so choosing
  // files always left you staring at a second picker.
  const handleBrowse = async (mode: 'files' | 'folder') => {
    if (isBrowsing) return
    setIsBrowsing(true)
    try {
      const selection = await open({
        multiple: true,
        directory: mode === 'folder',
        title: mode === 'folder' ? 'Select folders' : 'Select files',
      })
      const paths = normalizeSelection(selection) ?? []
      if (paths.length === 0) return
      if (mode === 'folder') addFolders(paths)
      else addFiles(paths)
    } finally {
      setIsBrowsing(false)
    }
  }

  useEffect(() => {
    let unlistenStatus: (() => void) | null = null
    let unlistenProgress: (() => void) | null = null
    let unlistenFileProgress: (() => void) | null = null
    let unlistenFileList: (() => void) | null = null
    let unlistenCompleted: (() => void) | null = null

    const setup = async () => {
      unlistenStatus = await listen<{
        itemId: string
        path: string
        kind: string
        status: 'queued' | 'preparing' | 'uploading' | 'done' | 'failed'
        message?: string | null
        saEmail?: string | null
      }>('upload:item_status', event => {
        const { itemId, status, message, saEmail } = event.payload
        setItemStatus(itemId, status, message ?? null, saEmail ?? null)
      })

      unlistenProgress = await listen<{
        itemId: string
        path: string
        bytesSent: number
        totalBytes: number
      }>('upload:progress', event => {
        const { itemId, bytesSent, totalBytes } = event.payload
        setItemProgress(itemId, bytesSent, totalBytes)
      })

      unlistenFileProgress = await listen<{
        itemId: string
        filePath: string
        bytesSent: number
        totalBytes: number
      }>('upload:file_progress', event => {
        const { itemId, filePath, bytesSent, totalBytes } = event.payload
        recordFileProgress(itemId, filePath, bytesSent, totalBytes)
      })

      unlistenFileList = await listen<{
        itemId: string
        files: { filePath: string; totalBytes: number }[]
      }>('upload:file_list', event => {
        const { itemId, files } = event.payload
        recordFileList(
          itemId,
          files.map(file => ({
            filePath: file.filePath,
            bytesSent: 0,
            totalBytes: file.totalBytes,
          }))
        )
      })

      unlistenCompleted = await listen<{
        summary: {
          total: number
          succeeded: number
          failed: number
          canceled: number
        }
      }>('upload:completed', event => {
        setIsUploading(false)
        resetStaleUploadState()

        const { total, succeeded, failed, canceled } = event.payload.summary
        const parts = [`${succeeded}/${total} succeeded`]
        if (failed > 0) parts.push(`${failed} failed`)
        if (canceled > 0) parts.push(`${canceled} canceled`)
        const description = parts.join(', ')

        if (failed > 0) {
          toast.error('Upload finished with errors', { description })
        } else if (canceled > 0) {
          toast.message('Upload canceled', { description })
        } else {
          toast.success('Upload completed', { description })
        }
      })
    }

    setup().catch(error => {
      logger.debug('Upload event listeners not available', {
        error: String(error),
      })
    })

    return () => {
      if (unlistenStatus) unlistenStatus()
      if (unlistenProgress) unlistenProgress()
      if (unlistenFileProgress) unlistenFileProgress()
      if (unlistenFileList) unlistenFileList()
      if (unlistenCompleted) unlistenCompleted()
    }
  }, [
    recordFileList,
    recordFileProgress,
    resetStaleUploadState,
    setItemProgress,
    setItemStatus,
  ])

  useEffect(() => {
    let unlisten: (() => void) | null = null

    const setup = async () => {
      try {
        const win = getCurrentWindow()
        unlisten = await win.onDragDropEvent(async ({ payload }) => {
          switch (payload.type) {
            case 'enter':
            case 'over':
              setIsDropActive(true)
              break
            case 'leave':
              setIsDropActive(false)
              break
            case 'drop': {
              setIsDropActive(false)
              const paths = payload.paths ?? []
              if (paths.length === 0) return

              const existing = new Set(
                useLocalUploadQueue.getState().items.map(i => i.path)
              )

              interface ClassifiedPath {
                path: string
                kind: 'file' | 'folder'
              }

              try {
                const classified = await invoke<ClassifiedPath[]>(
                  'classify_paths',
                  { paths }
                )

                const toAdd = classified.map(item => ({
                  path: item.path,
                  kind: item.kind,
                }))
                useLocalUploadQueue.getState().addItems(toAdd)

                const addedCount = classified.filter(
                  p => !existing.has(p.path)
                ).length
                if (addedCount > 0) {
                  toast.success(`Added ${addedCount} items to queue`)
                }
              } catch (error) {
                logger.warn(
                  'Failed to classify dropped paths, defaulting to file',
                  {
                    error: String(error),
                  }
                )
                const toAdd = paths.map(path => ({
                  path,
                  kind: 'file' as const,
                }))
                useLocalUploadQueue.getState().addItems(toAdd)

                const addedCount = paths.filter(p => !existing.has(p)).length
                if (addedCount > 0) {
                  toast.success(`Added ${addedCount} items to queue`)
                }
              }
              break
            }
          }
        })
      } catch (error) {
        logger.debug('Tauri drag-and-drop events not available', {
          error: String(error),
        })
      }
    }

    setup()
    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  const handleStartSelected = async (selectedIds: string[]) => {
    // Pressing Start with no destination used to do nothing at all, with no
    // hint as to why. Say what is wrong and put the caret where the fix goes.
    if (!destinationFolderId || destinationError) {
      toast.error(
        destinationError
          ? 'That destination is not a Drive folder'
          : 'Choose a destination folder first',
        {
          description: 'Paste a Drive folder link or ID in the sidebar.',
          action: {
            label: 'Fix it',
            onClick: () => focusDestinationInput(),
          },
        }
      )
      focusDestinationInput()
      return
    }
    if (selectedIds.length === 0) return

    const selected = items.filter(i => selectedIds.includes(i.id))
    // 'failed' is startable so Start doubles as retry for a failed item.
    const startable = selected.filter(
      i =>
        i.status === 'queued' ||
        i.status === 'paused' ||
        i.status === 'failed' ||
        !i.status
    )

    if (isUploading) {
      const toResume = startable
        .filter(i => i.status === 'paused')
        .map(i => i.id)
      if (toResume.length === 0) {
        toast.message('Nothing to start', {
          description: 'Select queued or paused items.',
        })
        return
      }
      invoke('pause_items', { itemIds: toResume, paused: false }).catch(err => {
        logger.debug('pause_items resume failed', { error: String(err) })
      })
      for (const id of toResume) {
        setItemStatus(id, 'uploading', null, null)
      }
      return
    }

    if (startable.length === 0) {
      toast.message('Nothing to start', {
        description: 'Select queued, paused or failed items.',
      })
      return
    }

    setIsUploading(true)

    // Check the destination before touching any row state, so a bad folder ID
    // or a service account without access fails in seconds instead of part-way
    // through a large transfer.
    try {
      await invoke('verify_destination', { args: { destinationFolderId } })
    } catch (error) {
      setIsUploading(false)
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Cannot reach the destination folder', {
        description: message,
      })
      return
    }

    clearFileProgress(startable.map(i => i.id))
    resetItemsUploadState(startable.map(i => i.id))
    for (const it of startable) {
      setItemStatus(it.id, 'preparing', null, null)
    }

    try {
      await invoke('start_upload', {
        args: {
          queueItems: startable.map(item => ({
            id: item.id,
            path: item.path,
            kind: item.kind,
          })),
          destinationFolderId,
        },
      })
    } catch (error) {
      setIsUploading(false)
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to start upload', { description: message })
    }
  }

  const handleRemoveSelected = (selectedIds: string[]) => {
    if (selectedIds.length === 0) return

    const selected = items.filter(i => selectedIds.includes(i.id))
    const active = selected.filter(
      i => i.status === 'uploading' || i.status === 'preparing'
    )
    if (active.length > 0) {
      toast.message('Some items are still uploading', {
        description: 'Pause them first, or use Clear all to stop everything.',
      })
      return
    }

    clearFileProgress(selected.map(i => i.id))
    for (const item of selected) {
      removeItem(item.path)
    }
  }

  const handlePauseSelected = async (selectedIds: string[]) => {
    if (selectedIds.length === 0) return
    if (!isUploading) return

    const selected = items.filter(i => selectedIds.includes(i.id))
    const toPause = selected
      .filter(i => i.status === 'uploading' || i.status === 'preparing')
      .map(i => i.id)

    if (toPause.length === 0) return

    invoke('pause_items', { itemIds: toPause, paused: true }).catch(err => {
      logger.debug('pause_items pause failed', { error: String(err) })
    })
    for (const id of toPause) {
      setItemStatus(id, 'paused', null, null)
    }
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <TransferTable
          isDropActive={isDropActive}
          onBrowse={handleBrowse}
          onStartSelected={handleStartSelected}
          onPauseSelected={handlePauseSelected}
          onRemoveSelected={handleRemoveSelected}
          isUploading={isUploading}
        />
      </div>
    </div>
  )
}
