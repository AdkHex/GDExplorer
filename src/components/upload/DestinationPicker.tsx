import { useEffect, useMemo, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FolderIcon,
  FolderSearchIcon,
  XIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useUploadDestinationStore } from '@/store/upload-destination-store'
import { usePreferences } from '@/services/preferences'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { driveFolderUrl } from '@/lib/drive-links'
import { RemoteFolderBrowser } from './RemoteFolderBrowser'

const CUSTOM_VALUE = 'custom'

export function DestinationPicker() {
  const {
    destinationUrl,
    destinationError,
    destinationFolderId,
    setDestinationUrl,
    applyDefaultDestination,
    clearDestination,
  } = useUploadDestinationStore()
  const { data: preferences } = usePreferences()
  const [browserOpen, setBrowserOpen] = useState(false)

  const destinationPresets = useMemo(
    () => preferences?.destinationPresets ?? [],
    [preferences?.destinationPresets]
  )

  const selectedPresetId = useMemo(() => {
    const url = destinationUrl.trim()
    if (!url) return CUSTOM_VALUE
    const match = destinationPresets.find(p => p.url.trim() === url)
    return match ? match.id : CUSTOM_VALUE
  }, [destinationPresets, destinationUrl])

  useEffect(() => {
    const firstPreset = destinationPresets[0]
    if (!firstPreset) return
    applyDefaultDestination(firstPreset.url)
  }, [destinationPresets, applyDefaultDestination])

  const hasValue = destinationUrl.trim().length > 0

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <FolderIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Destination</h2>
      </div>

      {/* The field labels were removed as visible text - the section heading
          already says what this is. They stay as aria-labels so the controls
          are still announced properly. */}
      {destinationPresets.length > 0 ? (
        <Select
          value={selectedPresetId}
          onValueChange={value => {
            if (value === CUSTOM_VALUE) {
              clearDestination()
              return
            }
            const preset = destinationPresets.find(p => p.id === value)
            if (preset) setDestinationUrl(preset.url)
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full"
            aria-label="Saved destination"
          >
            <SelectValue placeholder="Custom" />
          </SelectTrigger>
          <SelectContent>
            {destinationPresets.map(p => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={CUSTOM_VALUE}>Custom…</SelectItem>
          </SelectContent>
        </Select>
      ) : null}

      <div className="relative">
        <Input
          id="destination-url"
          aria-label="Destination folder URL"
          value={destinationUrl}
          onChange={e => setDestinationUrl(e.target.value)}
          placeholder="Paste a Drive folder link or ID"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          aria-invalid={destinationError}
          aria-describedby="destination-status"
          className={cn(
            hasValue && 'pr-8',
            destinationFolderId &&
              'border-status-success focus-visible:border-status-success focus-visible:ring-status-success/25'
          )}
        />
        {hasValue ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={clearDestination}
                className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label="Clear destination"
              >
                <XIcon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Clear</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {/* Pasting a folder URL assumes you have one to hand. Browsing asks
          rclone what the service accounts can actually see. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => setBrowserOpen(true)}
      >
        <FolderSearchIcon />
        Browse Drive…
      </Button>

      <RemoteFolderBrowser
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        onSelect={folder => setDestinationUrl(driveFolderUrl(folder.id))}
      />

      {/* Was three stacked lines - "Ready to upload", the folder ID, and an
          "Open in Drive" link. Collapsed to one. */}
      <div id="destination-status" aria-live="polite">
        {destinationError ? (
          <p className="flex items-start gap-1.5 text-xs text-status-danger">
            <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
            <span>Not a Drive folder link</span>
          </p>
        ) : destinationFolderId ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2Icon className="size-3.5 shrink-0 text-status-success" />
            <span className="truncate font-mono text-[11px]">
              {destinationFolderId}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    openUrl(
                      `https://drive.google.com/drive/folders/${destinationFolderId}`
                    ).catch(error => {
                      logger.warn('Failed to open destination folder', {
                        error: String(error),
                      })
                    })
                  }}
                  className="shrink-0 rounded p-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  aria-label="Open destination in Google Drive"
                >
                  <ExternalLinkIcon className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Open in Drive</TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </section>
  )
}
