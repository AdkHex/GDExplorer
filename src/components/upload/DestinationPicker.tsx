import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  FolderIcon,
  HardDriveIcon,
  LinkIcon,
  PinIcon,
  PinOffIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useUploadDestinationStore } from '@/store/upload-destination-store'
import { usePreferences, useSavePreferences } from '@/services/preferences'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { extractDriveFolderId } from '@/lib/drive-url'
import { driveFolderUrl } from '@/lib/drive-links'
import type { DestinationPreset } from '@/types/preferences'
import { RemoteFolderBrowser } from './RemoteFolderBrowser'

export function DestinationPicker() {
  const {
    destinationUrl,
    destinationError,
    destinationFolderId,
    destinationName,
    destinationPath,
    setDestinationUrl,
    setDestinationFolder,
    setDestinationName,
    applyDefaultDestination,
    clearDestination,
  } = useUploadDestinationStore()
  const { data: preferences } = usePreferences()
  const [browserOpen, setBrowserOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)

  const savePreferences = useSavePreferences()

  const destinationPresets = useMemo(
    () => preferences?.destinationPresets ?? [],
    [preferences?.destinationPresets]
  )

  // Pinned destinations earn a permanent row in the sidebar; the rest stay one
  // click away in the dropdown.
  const pinnedPresets = useMemo(
    () => destinationPresets.filter(preset => preset.pinned),
    [destinationPresets]
  )
  const unpinnedPresets = useMemo(
    () => destinationPresets.filter(preset => !preset.pinned),
    [destinationPresets]
  )

  const setPinned = (presetId: string, pinned: boolean) => {
    const next = destinationPresets.map(preset =>
      preset.id === presetId ? { ...preset, pinned } : preset
    )
    savePreferences.mutateAsync({ destinationPresets: next }).catch(error => {
      logger.warn('Could not change the pinned destinations', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** Save the current destination as a pinned preset. */
  const pinCurrent = () => {
    if (!destinationFolderId) return
    const name = destinationName ?? destinationFolderId
    const existing = destinationPresets.find(
      preset => extractDriveFolderId(preset.url) === destinationFolderId
    )
    if (existing) {
      setPinned(existing.id, true)
      return
    }
    const preset: DestinationPreset = {
      id: `pin-${destinationFolderId}`,
      name,
      url: driveFolderUrl(destinationFolderId),
      pinned: true,
    }
    savePreferences
      .mutateAsync({ destinationPresets: [preset, ...destinationPresets] })
      .catch(error => {
        logger.warn('Could not pin the destination', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const currentPreset = destinationPresets.find(
    preset => extractDriveFolderId(preset.url) === destinationFolderId
  )
  const isCurrentPinned = Boolean(currentPreset?.pinned)

  useEffect(() => {
    const firstPreset = destinationPresets[0]
    if (!firstPreset) return
    applyDefaultDestination(firstPreset.url, firstPreset.name)
  }, [destinationPresets, applyDefaultDestination])

  // A pasted link carries only an ID, so ask rclone what the folder is called.
  // Browsing already supplies the name, hence the `destinationName` guard.
  useEffect(() => {
    if (!destinationFolderId || destinationName) return
    let cancelled = false
    invoke<string | null>('resolve_folder_name', {
      args: { folderId: destinationFolderId },
    })
      .then(name => {
        if (cancelled || !name) return
        setDestinationName(destinationFolderId, name)
      })
      .catch(error => {
        logger.debug('Could not resolve the destination folder name', {
          error: String(error),
        })
      })
    return () => {
      cancelled = true
    }
  }, [destinationFolderId, destinationName, setDestinationName])

  // Everything above the chosen folder, shown as the picker's breadcrumb.
  const parentSegments = destinationPath.slice(0, -1)

  return (
    <section className="space-y-2">
      <div className="text-[11px] font-medium text-muted-foreground">
        Destination
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-lg border bg-white/[0.04] px-2.5 py-1.5 text-left transition-colors',
              'hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              destinationError
                ? 'border-status-danger'
                : destinationFolderId
                  ? 'border-input'
                  : 'border-dashed border-input'
            )}
            aria-label="Destination folder"
          >
            <div className="min-w-0 flex-1">
              {destinationError ? (
                <div className="truncate text-[11px] text-status-danger">
                  Not a Drive folder
                </div>
              ) : parentSegments.length > 0 ? (
                <div className="truncate text-[11px] text-muted-foreground">
                  {parentSegments.join(' › ')}
                </div>
              ) : destinationFolderId && !destinationName ? (
                <div className="truncate text-[11px] text-muted-foreground">
                  Pasted link
                </div>
              ) : null}

              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <FolderIcon
                  className={cn(
                    'size-3.5 shrink-0',
                    destinationFolderId && !destinationError
                      ? 'text-status-success'
                      : 'text-muted-foreground'
                  )}
                />
                {destinationError ? (
                  <span className="truncate text-muted-foreground">
                    Pick or paste again
                  </span>
                ) : destinationFolderId ? (
                  <span
                    className={cn(
                      'truncate',
                      !destinationName && 'font-mono text-[11px]'
                    )}
                  >
                    {destinationName ?? destinationFolderId}
                  </span>
                ) : (
                  <span className="truncate text-muted-foreground">
                    Choose a folder
                  </span>
                )}
              </div>
            </div>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-[220px]">
          {unpinnedPresets.map(preset => {
            const presetId = extractDriveFolderId(preset.url)
            const isActive =
              presetId !== null && presetId === destinationFolderId
            return (
              <DropdownMenuItem
                key={preset.id}
                onSelect={() =>
                  setDestinationFolder(preset.url, preset.name, [preset.name])
                }
              >
                <FolderIcon />
                <span className="flex-1 truncate">{preset.name}</span>
                {isActive ? (
                  <span className="text-status-info" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </DropdownMenuItem>
            )
          })}
          {unpinnedPresets.length > 0 ? <DropdownMenuSeparator /> : null}

          <DropdownMenuItem onSelect={() => setBrowserOpen(true)}>
            <HardDriveIcon />
            Browse Drive…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPasteOpen(true)}>
            <LinkIcon />
            Paste link…
          </DropdownMenuItem>

          {destinationFolderId ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  openUrl(driveFolderUrl(destinationFolderId)).catch(error => {
                    logger.warn('Failed to open destination folder', {
                      error: String(error),
                    })
                  })
                }}
              >
                <ExternalLinkIcon />
                Open in Drive
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  isCurrentPinned && currentPreset
                    ? setPinned(currentPreset.id, false)
                    : pinCurrent()
                }
              >
                {isCurrentPinned ? <PinOffIcon /> : <PinIcon />}
                {isCurrentPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={clearDestination}
              >
                Clear destination
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {pinnedPresets.length > 0 ? (
        <ul className="space-y-0.5">
          {pinnedPresets.map(preset => {
            const presetId = extractDriveFolderId(preset.url)
            const isActive =
              presetId !== null && presetId === destinationFolderId
            return (
              <li key={preset.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    setDestinationFolder(preset.url, preset.name, [preset.name])
                  }
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors',
                    'hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    isActive
                      ? 'bg-status-info/15 text-foreground'
                      : 'text-muted-foreground'
                  )}
                >
                  <FolderIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{preset.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPinned(preset.id, false)}
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors',
                    'hover:bg-accent hover:text-foreground',
                    'opacity-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    'group-hover:opacity-100'
                  )}
                  aria-label={`Unpin ${preset.name}`}
                >
                  <PinOffIcon className="size-3" />
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}

      <RemoteFolderBrowser
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        onSelect={folder =>
          setDestinationFolder(
            driveFolderUrl(folder.id),
            folder.name,
            folder.path
          )
        }
      />

      <PasteLinkDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        initialValue={destinationUrl}
        onConfirm={setDestinationUrl}
      />
    </section>
  )
}

/** Kept as a dialog so the sidebar does not carry a text field it rarely needs. */
function PasteLinkDialog({
  open,
  onOpenChange,
  initialValue,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialValue: string
  onConfirm: (url: string) => void
}) {
  const [value, setValue] = useState(initialValue)
  const folderId = extractDriveFolderId(value)
  const isInvalid = value.trim().length > 0 && !folderId

  const handleOpenChange = (next: boolean) => {
    if (next) setValue(initialValue)
    onOpenChange(next)
  }

  const confirm = () => {
    if (!folderId) return
    onConfirm(value)
    handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Paste a destination link</DialogTitle>
          <DialogDescription>
            A Drive folder link or the folder ID on its own.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder="https://drive.google.com/drive/folders/…"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={isInvalid}
          aria-label="Destination folder URL"
          onKeyDown={event => {
            if (event.key === 'Enter') confirm()
          }}
        />
        {isInvalid ? (
          <p className="text-xs text-status-danger">Not a Drive folder link</p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!folderId} onClick={confirm}>
            Use folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
