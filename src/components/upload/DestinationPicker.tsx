import { useEffect, useMemo } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FolderIcon,
  XIcon,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <FolderIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Destination</h2>
      </div>

      {destinationPresets.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="destination-preset" className="text-xs font-normal">
            Saved destination
          </Label>
          <Select
            value={selectedPresetId}
            onValueChange={value => {
              // "Custom" used to be an inert menu entry. It now clears the
              // field so the next thing you type is your own URL.
              if (value === CUSTOM_VALUE) {
                clearDestination()
                return
              }
              const preset = destinationPresets.find(p => p.id === value)
              if (preset) setDestinationUrl(preset.url)
            }}
          >
            <SelectTrigger id="destination-preset" size="sm" className="w-full">
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
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="destination-url" className="text-xs font-normal">
          Destination folder URL
        </Label>
        <div className="relative">
          <Input
            id="destination-url"
            value={destinationUrl}
            onChange={e => setDestinationUrl(e.target.value)}
            placeholder="Paste a Drive folder link or ID"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            aria-invalid={destinationError}
            aria-describedby="destination-status"
            // The error treatment comes from the shared `aria-invalid` styling;
            // only the success state needs a colour of its own.
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
      </div>

      {/* Status is a live region so screen readers hear the URL turn valid
          without having to re-read the field. Icon plus text, never colour
          on its own. */}
      <div id="destination-status" aria-live="polite" className="min-h-8">
        {destinationError ? (
          <p className="flex items-start gap-1.5 text-xs text-status-danger">
            <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
            <span>
              That is not a Drive <em>folder</em>. Paste a link like
              drive.google.com/drive/folders/… or the folder ID on its own.
            </span>
          </p>
        ) : destinationFolderId ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs text-status-success">
              <CheckCircle2Icon className="size-3.5 shrink-0" />
              <span>Ready to upload</span>
            </p>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {destinationFolderId}
              </span>
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
                className="inline-flex shrink-0 items-center gap-1 rounded text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                Open in Drive
                <ExternalLinkIcon className="size-3" />
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Uploads go to this folder. Sharing must allow your service accounts.
          </p>
        )}
      </div>
    </section>
  )
}
