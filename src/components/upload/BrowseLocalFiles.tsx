import { useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useUploadDestinationStore } from '@/store/upload-destination-store'
import { useTransferUiStore } from '@/store/transfer-ui-store'
import { useUploadHistory } from '@/store/upload-history-store'
import { useUIStore } from '@/store/ui-store'
import { TransferTable } from '@/components/transfers/TransferTable'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { notifyIfUnfocused, playCompletionSound } from '@/lib/notifications'
import { getPathName } from '@/lib/utils'
import { usePreferences } from '@/services/preferences'

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
    recordUploadDestination,
    remove: removeItem,
  } = useLocalUploadQueue()
  const recordFileProgress = useTransferUiStore(s => s.recordFileProgress)
  const recordItemSpeed = useTransferUiStore(s => s.recordItemSpeed)
  const recordSettledBytes = useTransferUiStore(s => s.recordSettledBytes)
  const recordFileList = useTransferUiStore(s => s.recordFileList)
  const clearFileProgress = useTransferUiStore(s => s.clearFileProgress)
  const { destinationError, destinationFolderId } = useUploadDestinationStore()
  const { data: preferences } = usePreferences()
  // Read through a ref inside the event listener: putting `preferences` in the
  // effect deps would tear down and re-register every upload listener whenever
  // a setting changes.
  const notifyOnCompletionRef = useRef(true)
  const notificationSoundRef = useRef(true)
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
    notifyOnCompletionRef.current = preferences?.notifyOnCompletion ?? true
    notificationSoundRef.current = preferences?.notificationSound ?? true
  }, [preferences])

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
        // Read the row before the status write so a finished item still has its
        // pre-completion fields (destination, size) to copy into history.
        const finished = useLocalUploadQueue
          .getState()
          .items.find(item => item.id === itemId)
        setItemStatus(itemId, status, message ?? null, saEmail ?? null)

        if (status === 'done' && finished) {
          useUploadHistory.getState().record({
            name: getPathName(finished.path),
            path: finished.path,
            kind: finished.kind,
            totalBytes: finished.totalBytes ?? null,
            // Where it actually went; the sidebar may point elsewhere later.
            destinationFolderId:
              finished.uploadedToFolderId ??
              finished.destinationFolderId ??
              useUploadDestinationStore.getState().destinationFolderId ??
              null,
            destinationLabel: finished.destinationLabel ?? null,
          })
        }
      })

      unlistenProgress = await listen<{
        itemId: string
        path: string
        bytesSent: number
        totalBytes: number
        speedBytesPerSec?: number | null
        settledBytes?: number | null
      }>('upload:progress', event => {
        const {
          itemId,
          bytesSent,
          totalBytes,
          speedBytesPerSec,
          settledBytes,
        } = event.payload
        setItemProgress(itemId, bytesSent, totalBytes)
        recordItemSpeed(itemId, speedBytesPerSec ?? null)
        recordSettledBytes(itemId, settledBytes ?? null)
      })

      unlistenFileProgress = await listen<{
        itemId: string
        filePath: string
        bytesSent: number
        totalBytes: number
        speedBytesPerSec?: number | null
      }>('upload:file_progress', event => {
        const { itemId, filePath, bytesSent, totalBytes, speedBytesPerSec } =
          event.payload
        recordFileProgress(
          itemId,
          filePath,
          bytesSent,
          totalBytes,
          speedBytesPerSec ?? null
        )
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

        const title =
          failed > 0
            ? 'Upload Finished With Errors'
            : canceled > 0
              ? 'Upload Canceled'
              : 'Upload Complete'

        if (failed > 0) {
          toast.error('Upload finished with errors', { description })
        } else if (canceled > 0) {
          toast.message('Upload canceled', { description })
        } else {
          toast.success('Upload completed', { description })
        }

        // A batch can run for hours, so the result is worth a system
        // notification when the user has moved on to something else.
        const withSound = notificationSoundRef.current
        if (notifyOnCompletionRef.current) {
          void notifyIfUnfocused(title, description, { sound: withSound })
        }

        // The notification above is suppressed while the window is focused, so
        // play the sound here to cover that case. `notifyIfUnfocused` resolves
        // without notifying then, hence the explicit focus check.
        if (withSound) {
          void (async () => {
            try {
              if (await getCurrentWindow().isFocused()) {
                await playCompletionSound()
              }
            } catch {
              // No Tauri window (tests, plain browser): nothing to play.
            }
          })()
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
    recordItemSpeed,
    recordSettledBytes,
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
    if (selectedIds.length === 0) return

    const selected = items.filter(i => selectedIds.includes(i.id))
    const toResume = selected.filter(i => i.status === 'paused')
    // 'failed' is startable so Start doubles as retry for a failed item.
    const startable = selected.filter(
      i => i.status === 'queued' || i.status === 'failed' || !i.status
    )

    // Resuming is a different mechanism from queueing, so handle it first and
    // let a mixed selection do both.
    if (toResume.length > 0) {
      try {
        await invoke('pause_items', {
          itemIds: toResume.map(i => i.id),
          paused: false,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('pause_items resume failed', { error: message })
        toast.error('Could not resume', { description: message })
        return
      }
    }

    if (startable.length === 0) {
      if (toResume.length === 0) {
        toast.message('Nothing to start', {
          description: 'Select queued, paused or failed items.',
        })
      }
      return
    }

    // Each row uses its own destination when one is pinned, otherwise the
    // sidebar's. Resolving here means a single run can target several folders.
    const globalDestination = destinationError ? null : destinationFolderId
    const resolved = startable.map(item => ({
      item,
      destination: item.destinationFolderId ?? globalDestination,
    }))

    const missing = resolved.filter(entry => !entry.destination)
    if (missing.length > 0) {
      toast.error(
        destinationError
          ? 'That destination is not a Drive folder'
          : 'Choose a destination folder first',
        {
          description:
            missing.length === startable.length
              ? 'Paste a Drive folder link or ID in the sidebar.'
              : `${missing.length} item(s) have no destination of their own and the sidebar is empty.`,
          action: { label: 'Fix it', onClick: () => focusDestinationInput() },
        }
      )
      focusDestinationInput()
      return
    }

    setIsUploading(true)

    // Check every distinct destination before touching any row state, so a bad
    // folder ID or a service account without access fails in seconds instead of
    // part-way through a large transfer.
    const distinctDestinations = [
      ...new Set(resolved.map(entry => entry.destination as string)),
    ]
    for (const destination of distinctDestinations) {
      try {
        await invoke('verify_destination', {
          args: { destinationFolderId: destination },
        })
      } catch (error) {
        setIsUploading(false)
        const message = error instanceof Error ? error.message : String(error)
        toast.error('Cannot reach the destination folder', {
          description:
            distinctDestinations.length > 1
              ? `${destination}: ${message}`
              : message,
        })
        return
      }
    }

    clearFileProgress(startable.map(i => i.id))
    resetItemsUploadState(startable.map(i => i.id))
    for (const { item, destination } of resolved) {
      setItemStatus(item.id, 'preparing', null, null)
      // Remember where this run is sending the item, so its Drive links can
      // still be found after the sidebar destination changes.
      recordUploadDestination(item.id, destination as string)
    }

    try {
      // The backend appends these to a running job rather than replacing it,
      // so adding more work mid-upload no longer cancels what is in flight.
      await invoke('start_upload', {
        args: {
          queueItems: resolved.map(({ item, destination }) => ({
            id: item.id,
            path: item.path,
            kind: item.kind,
            destinationFolderId: destination,
          })),
          destinationFolderId: globalDestination ?? '',
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

    // Wait for the backend to accept the request, and do NOT mark the rows
    // paused here. rclone stops asynchronously and the backend emits the
    // authoritative `paused` status once the process is actually down.
    // Painting rows yellow optimistically is what made a pause that never
    // happened look like one that did.
    try {
      await invoke('pause_items', { itemIds: toPause, paused: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('pause_items failed', { error: message })
      toast.error('Could not pause', { description: message })
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
