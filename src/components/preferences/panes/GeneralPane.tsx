import React, { useCallback, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { usePreferences, useSavePreferences } from '@/services/preferences'
import type { DestinationPreset } from '@/types/preferences'
import { extractDriveFolderId } from '@/lib/drive-url'

interface DetectedRclone {
  path: string
  version: string
}

const SettingsField: React.FC<{
  label: string
  children: React.ReactNode
  description?: string
}> = ({ label, children, description }) => (
  <div className="space-y-2">
    <Label className="text-sm font-medium text-foreground">{label}</Label>
    {children}
    {description && (
      <p className="text-sm text-muted-foreground">{description}</p>
    )}
  </div>
)

const SettingsSection: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <Separator className="mt-2" />
    </div>
    <div className="space-y-4">{children}</div>
  </div>
)

/**
 * Collapsed by default so the everyday settings are not buried under rclone
 * tuning knobs most people never touch.
 */
const AdvancedSection: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [open, setOpen] = useState(false)

  return (
    <div className="space-y-4">
      <div>
        <button
          type="button"
          onClick={() => setOpen(current => !current)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left text-lg font-medium text-foreground"
        >
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
          Advanced (rclone tuning)
        </button>
        <Separator className="mt-2" />
      </div>
      {open ? <div className="space-y-4">{children}</div> : null}
    </div>
  )
}

export const GeneralPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const savePreferences = useSavePreferences()

  const prefsKey = useMemo(() => {
    if (!preferences) return 'loading'
    return JSON.stringify({
      serviceAccountFolderPath: preferences.serviceAccountFolderPath ?? '',
      maxConcurrentUploads: preferences.maxConcurrentUploads ?? 3,
      uploadChunkSizeMib: preferences.uploadChunkSizeMib ?? 128,
      rclonePath: preferences.rclonePath ?? 'rclone',
      rcloneRemoteName: preferences.rcloneRemoteName ?? 'gdrive',
      rcloneTransfers: preferences.rcloneTransfers ?? 4,
      rcloneCheckers: preferences.rcloneCheckers ?? 8,
      rcloneRetries: preferences.rcloneRetries ?? 3,
      rcloneBandwidthLimit: preferences.rcloneBandwidthLimit ?? '',
      rcloneExcludePatterns: preferences.rcloneExcludePatterns ?? [],
      destinationPresets: preferences.destinationPresets ?? [],
      notifyOnCompletion: preferences.notifyOnCompletion ?? true,
      notificationSound: preferences.notificationSound ?? true,
      speedUnit: preferences.speedUnit ?? 'bytes',
      showTrayIcon: preferences.showTrayIcon ?? true,
      closeToTray: preferences.closeToTray ?? false,
    })
  }, [preferences])

  if (!preferences) {
    return <div className="text-sm text-muted-foreground">Loading…</div>
  }

  return (
    <GeneralPaneForm
      key={prefsKey}
      preferences={preferences}
      savePreferences={savePreferences}
    />
  )
}

const GeneralPaneForm: React.FC<{
  preferences: NonNullable<ReturnType<typeof usePreferences>['data']>
  savePreferences: ReturnType<typeof useSavePreferences>
}> = ({ preferences, savePreferences }) => {
  const [serviceAccountFolder, setServiceAccountFolder] = useState<string>(
    () => preferences.serviceAccountFolderPath ?? ''
  )
  const [lastSavedServiceAccountFolder, setLastSavedServiceAccountFolder] =
    useState<string>(() => preferences.serviceAccountFolderPath ?? '')
  const [maxConcurrentInput, setMaxConcurrentInput] = useState<string>(() =>
    String(preferences.maxConcurrentUploads ?? 3)
  )
  const [lastSavedMaxConcurrent, setLastSavedMaxConcurrent] = useState(
    () => preferences.maxConcurrentUploads ?? 3
  )
  const [chunkSizeInput, setChunkSizeInput] = useState<string>(() =>
    String(preferences.uploadChunkSizeMib ?? 128)
  )
  const [lastSavedChunkSize, setLastSavedChunkSize] = useState(
    () => preferences.uploadChunkSizeMib ?? 128
  )
  const [rclonePathInput, setRclonePathInput] = useState<string>(
    () => preferences.rclonePath ?? 'rclone'
  )
  const [lastSavedRclonePath, setLastSavedRclonePath] = useState(
    () => preferences.rclonePath ?? 'rclone'
  )
  const [rcloneRemoteInput, setRcloneRemoteInput] = useState<string>(
    () => preferences.rcloneRemoteName ?? 'gdrive'
  )
  const [lastSavedRcloneRemote, setLastSavedRcloneRemote] = useState(
    () => preferences.rcloneRemoteName ?? 'gdrive'
  )
  const [rcloneTransfersInput, setRcloneTransfersInput] = useState<string>(() =>
    String(preferences.rcloneTransfers ?? 4)
  )
  const [lastSavedRcloneTransfers, setLastSavedRcloneTransfers] = useState(
    () => preferences.rcloneTransfers ?? 4
  )
  const [rcloneCheckersInput, setRcloneCheckersInput] = useState<string>(() =>
    String(preferences.rcloneCheckers ?? 8)
  )
  const [lastSavedRcloneCheckers, setLastSavedRcloneCheckers] = useState(
    () => preferences.rcloneCheckers ?? 8
  )
  const [rcloneRetriesInput, setRcloneRetriesInput] = useState<string>(() =>
    String(preferences.rcloneRetries ?? 3)
  )
  const [lastSavedRcloneRetries, setLastSavedRcloneRetries] = useState(
    () => preferences.rcloneRetries ?? 3
  )
  const [bandwidthLimitInput, setBandwidthLimitInput] = useState<string>(
    () => preferences.rcloneBandwidthLimit ?? ''
  )
  const [lastSavedBandwidthLimit, setLastSavedBandwidthLimit] = useState(
    () => preferences.rcloneBandwidthLimit ?? ''
  )
  const [excludePatternsInput, setExcludePatternsInput] = useState<string>(() =>
    (preferences.rcloneExcludePatterns ?? []).join('\n')
  )
  const [lastSavedExcludePatterns, setLastSavedExcludePatterns] = useState(() =>
    (preferences.rcloneExcludePatterns ?? []).join('\n')
  )
  const [isInstallingRclone, setIsInstallingRclone] = useState(false)
  const [isDetectingRclone, setIsDetectingRclone] = useState(false)
  const [isConfiguringRclone, setIsConfiguringRclone] = useState(false)
  const [notifyOnCompletion, setNotifyOnCompletion] = useState(
    () => preferences.notifyOnCompletion ?? true
  )
  const [notificationSound, setNotificationSound] = useState(
    () => preferences.notificationSound ?? true
  )
  const [showTrayIcon, setShowTrayIcon] = useState(
    () => preferences.showTrayIcon ?? true
  )
  const [closeToTray, setCloseToTray] = useState(
    () => preferences.closeToTray ?? false
  )

  const [destinationPresetsDraft, setDestinationPresetsDraft] = useState<
    DestinationPreset[]
  >(() => preferences.destinationPresets ?? [])
  const [newPresetName, setNewPresetName] = useState('')
  const [newPresetUrl, setNewPresetUrl] = useState('')

  const maxConcurrentError = useMemo(() => {
    const trimmed = maxConcurrentInput.trim()
    if (!trimmed) return 'Please enter a number between 1 and 10.'
    if (!/^\d+$/.test(trimmed)) return 'Must be an integer between 1 and 10.'
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
      return 'Must be an integer between 1 and 10.'
    }
    return null
  }, [maxConcurrentInput])

  const handleBrowseServiceAccountsFolder = async () => {
    const selection = await open({
      directory: true,
      multiple: false,
      title: 'Select service account credentials folder',
    })
    if (!selection) return

    const folderPath = Array.isArray(selection) ? selection[0] : selection
    if (!folderPath) return

    try {
      await savePreferences.mutateAsync({
        serviceAccountFolderPath: folderPath,
      })
      setServiceAccountFolder(folderPath)
      setLastSavedServiceAccountFolder(folderPath)
    } catch {
      setServiceAccountFolder(lastSavedServiceAccountFolder)
    }
  }

  const handleSaveMaxConcurrent = () => {
    if (maxConcurrentError) return
    const value = Number.parseInt(maxConcurrentInput.trim(), 10)
    savePreferences
      .mutateAsync({ maxConcurrentUploads: value })
      .then(() => {
        setLastSavedMaxConcurrent(value)
      })
      .catch(() => {
        setMaxConcurrentInput(String(lastSavedMaxConcurrent))
      })
  }

  const chunkSizeError = useMemo(() => {
    const trimmed = chunkSizeInput.trim()
    if (!trimmed) return 'Please enter a number between 1 and 1024.'
    if (!/^\d+$/.test(trimmed)) return 'Must be an integer between 1 and 1024.'
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1024) {
      return 'Must be an integer between 1 and 1024.'
    }
    return null
  }, [chunkSizeInput])

  const handleSaveChunkSize = () => {
    if (chunkSizeError) return
    const value = Number.parseInt(chunkSizeInput.trim(), 10)
    savePreferences
      .mutateAsync({ uploadChunkSizeMib: value })
      .then(() => {
        setLastSavedChunkSize(value)
      })
      .catch(() => {
        setChunkSizeInput(String(lastSavedChunkSize))
      })
  }

  const rclonePathError = useMemo(() => {
    const trimmed = rclonePathInput.trim()
    if (!trimmed) return 'Please enter a path (or rclone).'
    if (trimmed.length > 512) return 'Path is too long (max 512 characters).'
    return null
  }, [rclonePathInput])

  const handleSaveRclonePath = () => {
    if (rclonePathError) return
    const value = rclonePathInput.trim()
    savePreferences
      .mutateAsync({ rclonePath: value })
      .then(() => {
        setLastSavedRclonePath(value)
      })
      .catch(() => {
        setRclonePathInput(lastSavedRclonePath)
      })
  }

  const rcloneRemoteError = useMemo(() => {
    const trimmed = rcloneRemoteInput.trim()
    if (!trimmed) return 'Please enter a remote name.'
    if (trimmed.length > 64)
      return 'Remote name is too long (max 64 characters).'
    return null
  }, [rcloneRemoteInput])

  const handleSaveRcloneRemote = () => {
    if (rcloneRemoteError) return
    const value = rcloneRemoteInput.trim()
    savePreferences
      .mutateAsync({ rcloneRemoteName: value })
      .then(() => {
        setLastSavedRcloneRemote(value)
      })
      .catch(() => {
        setRcloneRemoteInput(lastSavedRcloneRemote)
      })
  }

  const rcloneTransfersError = useMemo(() => {
    const trimmed = rcloneTransfersInput.trim()
    if (!trimmed) return 'Please enter a number between 1 and 64.'
    if (!/^\d+$/.test(trimmed)) return 'Must be an integer between 1 and 64.'
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 64) {
      return 'Must be an integer between 1 and 64.'
    }
    return null
  }, [rcloneTransfersInput])

  const handleSaveRcloneTransfers = () => {
    if (rcloneTransfersError) return
    const value = Number.parseInt(rcloneTransfersInput.trim(), 10)
    savePreferences
      .mutateAsync({ rcloneTransfers: value })
      .then(() => {
        setLastSavedRcloneTransfers(value)
      })
      .catch(() => {
        setRcloneTransfersInput(String(lastSavedRcloneTransfers))
      })
  }

  const rcloneCheckersError = useMemo(() => {
    const trimmed = rcloneCheckersInput.trim()
    if (!trimmed) return 'Please enter a number between 1 and 64.'
    if (!/^\d+$/.test(trimmed)) return 'Must be an integer between 1 and 64.'
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 64) {
      return 'Must be an integer between 1 and 64.'
    }
    return null
  }, [rcloneCheckersInput])

  const handleSaveRcloneCheckers = () => {
    if (rcloneCheckersError) return
    const value = Number.parseInt(rcloneCheckersInput.trim(), 10)
    savePreferences
      .mutateAsync({ rcloneCheckers: value })
      .then(() => {
        setLastSavedRcloneCheckers(value)
      })
      .catch(() => {
        setRcloneCheckersInput(String(lastSavedRcloneCheckers))
      })
  }

  const rcloneRetriesError = useMemo(() => {
    const trimmed = rcloneRetriesInput.trim()
    if (!trimmed) return 'Please enter a number between 0 and 20.'
    if (!/^\d+$/.test(trimmed)) return 'Must be an integer between 0 and 20.'
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed) || parsed > 20) {
      return 'Must be an integer between 0 and 20.'
    }
    return null
  }, [rcloneRetriesInput])

  const handleSaveRcloneRetries = () => {
    if (rcloneRetriesError) return
    const value = Number.parseInt(rcloneRetriesInput.trim(), 10)
    savePreferences
      .mutateAsync({ rcloneRetries: value })
      .then(() => setLastSavedRcloneRetries(value))
      .catch(() => setRcloneRetriesInput(String(lastSavedRcloneRetries)))
  }

  const bandwidthLimitError = useMemo(() => {
    const trimmed = bandwidthLimitInput.trim()
    if (!trimmed) return null
    if (!/^\d+(\.\d+)?[bkmgtBKMGT]?$/.test(trimmed)) {
      return 'Use a number with an optional B/K/M/G/T suffix, e.g. 10M.'
    }
    return null
  }, [bandwidthLimitInput])

  const handleSaveBandwidthLimit = () => {
    if (bandwidthLimitError) return
    const value = bandwidthLimitInput.trim()
    savePreferences
      .mutateAsync({ rcloneBandwidthLimit: value })
      .then(() => setLastSavedBandwidthLimit(value))
      .catch(() => setBandwidthLimitInput(lastSavedBandwidthLimit))
  }

  const parsedExcludePatterns = useMemo(
    () =>
      excludePatternsInput
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean),
    [excludePatternsInput]
  )

  const excludePatternsError = useMemo(() => {
    if (parsedExcludePatterns.length > 50) return 'At most 50 patterns.'
    if (parsedExcludePatterns.some(p => p.length > 256)) {
      return 'Each pattern must be 256 characters or fewer.'
    }
    return null
  }, [parsedExcludePatterns])

  const handleSaveExcludePatterns = () => {
    if (excludePatternsError) return
    const next = excludePatternsInput
    savePreferences
      .mutateAsync({ rcloneExcludePatterns: parsedExcludePatterns })
      .then(() => setLastSavedExcludePatterns(next))
      .catch(() => setExcludePatternsInput(lastSavedExcludePatterns))
  }

  const applyRclonePath = async (path: string) => {
    await savePreferences.mutateAsync({ rclonePath: path })
    setRclonePathInput(path)
    setLastSavedRclonePath(path)
  }

  const handleInstallRclone = async () => {
    setIsInstallingRclone(true)
    try {
      const path = await invoke<string>('install_rclone')
      await applyRclonePath(path)
      toast.success('rclone installed', { description: path })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to install rclone', { description: message })
    } finally {
      setIsInstallingRclone(false)
    }
  }

  // A GUI app inherits a minimal PATH on macOS, so an rclone installed with
  // Homebrew is not found by name - detection looks where it actually lives.
  const handleDetectRclone = async () => {
    setIsDetectingRclone(true)
    try {
      const found = await invoke<DetectedRclone | null>('detect_rclone')
      if (!found) {
        toast.message('No rclone found', {
          description:
            'Install it below, or type the full path to an existing binary.',
        })
        return
      }
      await applyRclonePath(found.path)
      toast.success(`Found ${found.version}`, { description: found.path })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Could not look for rclone', { description: message })
    } finally {
      setIsDetectingRclone(false)
    }
  }

  const handleConfigureRclone = async () => {
    setIsConfiguringRclone(true)
    try {
      await invoke('configure_rclone_remote', {
        rclonePath: rclonePathInput.trim(),
        remoteName: rcloneRemoteInput.trim(),
        serviceAccountFolder: serviceAccountFolder,
      })
      toast.success('Rclone remote configured')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to configure rclone', { description: message })
    } finally {
      setIsConfiguringRclone(false)
    }
  }

  const getPresetErrors = useCallback((presets: DestinationPreset[]) => {
    const byId: Record<string, string | null> = {}
    for (const preset of presets) {
      if (!preset.name.trim()) {
        byId[preset.id] = 'Name is required.'
        continue
      }
      const folderId = extractDriveFolderId(preset.url)
      if (!folderId) {
        byId[preset.id] = 'Please enter a Google Drive folder URL.'
        continue
      }
      byId[preset.id] = null
    }
    return byId
  }, [])

  const presetErrors = useMemo(
    () => getPresetErrors(destinationPresetsDraft),
    [destinationPresetsDraft, getPresetErrors]
  )

  const newPresetError = useMemo(() => {
    if (!newPresetName.trim() && !newPresetUrl.trim()) return null
    if (!newPresetName.trim()) return 'Name is required.'
    if (!extractDriveFolderId(newPresetUrl)) {
      return 'Please enter a Google Drive folder URL.'
    }
    return null
  }, [newPresetName, newPresetUrl])

  const persistDestinationPresets = async (nextDraft: DestinationPreset[]) => {
    setDestinationPresetsDraft(nextDraft)
    const nextErrors = getPresetErrors(nextDraft)
    const hasErrors = nextDraft.some(p => nextErrors[p.id] !== null)
    if (hasErrors) return

    const uniqueByUrl = new Set<string>()
    const deduped: DestinationPreset[] = []
    for (const p of nextDraft) {
      const url = p.url.trim()
      if (uniqueByUrl.has(url)) continue
      uniqueByUrl.add(url)
      deduped.push({ ...p, name: p.name.trim(), url })
    }

    try {
      await savePreferences.mutateAsync({ destinationPresets: deduped })
      setDestinationPresetsDraft(deduped)
    } catch {
      // Reset to last saved value (from query cache)
      setDestinationPresetsDraft(preferences?.destinationPresets ?? [])
    }
  }

  const addPreset = async () => {
    if (!newPresetName.trim() && !newPresetUrl.trim()) return
    if (newPresetError) return
    const url = newPresetUrl.trim()
    const name = newPresetName.trim()
    const preset: DestinationPreset = {
      id: generateId(),
      name,
      url,
    }
    setNewPresetName('')
    setNewPresetUrl('')
    await persistDestinationPresets([preset, ...destinationPresetsDraft])
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="Uploads">
        <SettingsField
          label="Service Account credentials folder (.json)"
          description="Select a folder containing one or more service account JSON files."
        >
          <div className="flex items-center gap-2">
            <Input
              value={serviceAccountFolder}
              placeholder="No folder selected"
              readOnly
            />
            <Button
              type="button"
              onClick={handleBrowseServiceAccountsFolder}
              disabled={savePreferences.isPending}
            >
              Browse…
            </Button>
          </div>
        </SettingsField>

        <SettingsField
          label="Maximum concurrent uploads"
          description="Controls how many uploads can run at the same time."
        >
          <div className="space-y-2">
            <Input
              inputMode="numeric"
              type="number"
              value={maxConcurrentInput}
              onChange={e => setMaxConcurrentInput(e.target.value)}
              onBlur={handleSaveMaxConcurrent}
              aria-invalid={Boolean(maxConcurrentError)}
            />
            {maxConcurrentError ? (
              <p className="text-sm text-destructive">{maxConcurrentError}</p>
            ) : null}
          </div>
        </SettingsField>

        <SettingsField
          label="Notify when a batch finishes"
          description="Posts a system notification with the result. Only when the window is in the background - a window you are looking at gets the in-app message instead."
        >
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {notifyOnCompletion ? 'Notifications on' : 'Notifications off'}
            </p>
            <Switch
              checked={notifyOnCompletion}
              disabled={savePreferences.isPending}
              aria-label="Notify when a batch finishes"
              onCheckedChange={checked => {
                setNotifyOnCompletion(checked)
                savePreferences
                  .mutateAsync({ notifyOnCompletion: checked })
                  .catch(() => {
                    setNotifyOnCompletion(
                      preferences.notifyOnCompletion ?? true
                    )
                  })
              }}
            />
          </div>
        </SettingsField>

        <SettingsField
          label="Play a sound when a batch finishes"
          description="Plays the system alert sound with the completion notification, whether or not the window is in front."
        >
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {notificationSound ? 'Sound on' : 'Sound off'}
            </p>
            <Switch
              checked={notificationSound}
              disabled={savePreferences.isPending}
              aria-label="Play a sound when a batch finishes"
              onCheckedChange={checked => {
                setNotificationSound(checked)
                savePreferences
                  .mutateAsync({ notificationSound: checked })
                  .catch(() => {
                    setNotificationSound(preferences.notificationSound ?? true)
                  })
              }}
            />
          </div>
        </SettingsField>

        <SettingsField
          label="Bandwidth limit"
          description="Caps upload speed (rclone --bwlimit). For example 10M for 10 MiB/s. Leave empty for unlimited."
        >
          <div className="space-y-2">
            <Input
              value={bandwidthLimitInput}
              onChange={e => setBandwidthLimitInput(e.target.value)}
              onBlur={handleSaveBandwidthLimit}
              placeholder="Unlimited"
              aria-invalid={Boolean(bandwidthLimitError)}
            />
            {bandwidthLimitError ? (
              <p className="text-sm text-destructive">{bandwidthLimitError}</p>
            ) : null}
          </div>
        </SettingsField>

        <SettingsField
          label="Exclude patterns"
          description="One glob per line, skipped during upload (rclone --exclude). For example .DS_Store or **/node_modules/**"
        >
          <div className="space-y-2">
            <textarea
              value={excludePatternsInput}
              onChange={e => setExcludePatternsInput(e.target.value)}
              onBlur={handleSaveExcludePatterns}
              rows={4}
              spellCheck={false}
              placeholder={'.DS_Store\n**/node_modules/**'}
              aria-invalid={Boolean(excludePatternsError)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
            />
            {excludePatternsError ? (
              <p className="text-sm text-destructive">{excludePatternsError}</p>
            ) : null}
          </div>
        </SettingsField>

        <SettingsField
          label="Rclone path"
          description="Binary name or full path used to execute rclone."
        >
          <div className="space-y-2">
            <Input
              value={rclonePathInput}
              onChange={e => setRclonePathInput(e.target.value)}
              onBlur={handleSaveRclonePath}
              aria-invalid={Boolean(rclonePathError)}
            />
            {rclonePathError ? (
              <p className="text-sm text-destructive">{rclonePathError}</p>
            ) : null}
          </div>
        </SettingsField>

        <SettingsField
          label="Rclone remote name"
          description="Remote configured in rclone (e.g. gdrive)."
        >
          <div className="space-y-2">
            <Input
              value={rcloneRemoteInput}
              onChange={e => setRcloneRemoteInput(e.target.value)}
              onBlur={handleSaveRcloneRemote}
              aria-invalid={Boolean(rcloneRemoteError)}
            />
            {rcloneRemoteError ? (
              <p className="text-sm text-destructive">{rcloneRemoteError}</p>
            ) : null}
          </div>
        </SettingsField>

        <SettingsField
          label="Rclone setup"
          description="Find an rclone you already have, download one into the app, and point the remote at your service accounts. Works on macOS, Windows and Linux."
        >
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={handleDetectRclone}
              disabled={isDetectingRclone}
            >
              {isDetectingRclone ? 'Looking…' : 'Detect rclone'}
            </Button>
            <Button
              type="button"
              onClick={handleInstallRclone}
              disabled={isInstallingRclone}
            >
              {isInstallingRclone ? 'Installing…' : 'Install rclone'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={handleConfigureRclone}
              disabled={
                isConfiguringRclone || !serviceAccountFolder.trim().length
              }
            >
              {isConfiguringRclone ? 'Configuring…' : 'Configure remote'}
            </Button>
          </div>
        </SettingsField>

        <SettingsField
          label="Destination presets"
          description="Save commonly used Google Drive folder URLs to quickly select them later."
        >
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-[160px_1fr_auto]">
              <Input
                value={newPresetName}
                onChange={e => setNewPresetName(e.target.value)}
                placeholder="Name (e.g. Shared Drive)"
              />
              <Input
                value={newPresetUrl}
                onChange={e => setNewPresetUrl(e.target.value)}
                placeholder="https://drive.google.com/drive/folders/<FOLDER_ID>"
                aria-invalid={Boolean(newPresetError)}
              />
              <Button type="button" onClick={addPreset}>
                Add
              </Button>
            </div>
            {newPresetError ? (
              <p className="text-sm text-destructive">{newPresetError}</p>
            ) : null}

            <div className="space-y-2">
              {destinationPresetsDraft.length === 0 ? (
                <p className="text-sm text-muted-foreground">No presets yet.</p>
              ) : (
                destinationPresetsDraft.map(preset => (
                  <div
                    key={preset.id}
                    className="grid gap-2 sm:grid-cols-[160px_1fr_auto]"
                  >
                    <Input
                      value={preset.name}
                      onChange={e =>
                        setDestinationPresetsDraft(curr =>
                          curr.map(p =>
                            p.id === preset.id
                              ? { ...p, name: e.target.value }
                              : p
                          )
                        )
                      }
                      onBlur={() =>
                        persistDestinationPresets(destinationPresetsDraft)
                      }
                    />
                    <Input
                      value={preset.url}
                      onChange={e =>
                        setDestinationPresetsDraft(curr =>
                          curr.map(p =>
                            p.id === preset.id
                              ? { ...p, url: e.target.value }
                              : p
                          )
                        )
                      }
                      aria-invalid={Boolean(presetErrors[preset.id])}
                      onBlur={() =>
                        persistDestinationPresets(destinationPresetsDraft)
                      }
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        persistDestinationPresets(
                          destinationPresetsDraft.filter(
                            p => p.id !== preset.id
                          )
                        )
                      }
                    >
                      Remove
                    </Button>
                    {presetErrors[preset.id] ? (
                      <p className="text-sm text-destructive sm:col-span-3">
                        {presetErrors[preset.id]}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Menu bar">
        <SettingsField
          label="Show the menu bar icon"
          description="Adds an icon showing upload progress, with shortcuts to the window and Preferences."
        >
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {showTrayIcon ? 'Icon shown' : 'Icon hidden'}
            </p>
            <Switch
              checked={showTrayIcon}
              disabled={savePreferences.isPending}
              aria-label="Show the menu bar icon"
              onCheckedChange={checked => {
                setShowTrayIcon(checked)
                savePreferences
                  .mutateAsync({ showTrayIcon: checked })
                  // Applied immediately rather than on next launch: a toggle
                  // that does nothing until a restart reads as broken.
                  .then(() => invoke('set_tray_visible', { visible: checked }))
                  .catch(() => {
                    setShowTrayIcon(preferences.showTrayIcon ?? true)
                  })
              }}
            />
          </div>
        </SettingsField>

        <SettingsField
          label="Keep running when the window is closed"
          description="Closing the window hides it instead of quitting, so an upload carries on. Reopen it from the menu bar icon. Needs the icon above."
        >
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {closeToTray && showTrayIcon
                ? 'Closing hides the window'
                : 'Closing quits the app'}
            </p>
            <Switch
              checked={closeToTray}
              disabled={savePreferences.isPending || !showTrayIcon}
              aria-label="Keep running when the window is closed"
              onCheckedChange={checked => {
                setCloseToTray(checked)
                savePreferences
                  .mutateAsync({ closeToTray: checked })
                  .catch(() => {
                    setCloseToTray(preferences.closeToTray ?? false)
                  })
              }}
            />
          </div>
        </SettingsField>
      </SettingsSection>

      <AdvancedSection>
        <SettingsField
          label="Upload chunk size (MiB)"
          description="Size of each chunk sent during resumable uploads. Larger values can improve throughput on fast networks but increase memory usage."
        >
          <div className="space-y-2">
            <Input
              inputMode="numeric"
              type="number"
              value={chunkSizeInput}
              onChange={e => setChunkSizeInput(e.target.value)}
              onBlur={handleSaveChunkSize}
              aria-invalid={Boolean(chunkSizeError)}
            />
            {chunkSizeError ? (
              <p className="text-sm text-destructive">{chunkSizeError}</p>
            ) : null}
          </div>
        </SettingsField>

        <SettingsField
          label="Rclone transfers"
          description="Controls --transfers (parallel file uploads within rclone)."
        >
          <div className="space-y-2">
            <Input
              inputMode="numeric"
              type="number"
              value={rcloneTransfersInput}
              onChange={e => setRcloneTransfersInput(e.target.value)}
              onBlur={handleSaveRcloneTransfers}
              aria-invalid={Boolean(rcloneTransfersError)}
            />
            {rcloneTransfersError ? (
              <p className="text-sm text-destructive">{rcloneTransfersError}</p>
            ) : null}
          </div>
        </SettingsField>

        <SettingsField
          label="Rclone checkers"
          description="Controls --checkers (parallel directory/metadata checks)."
        >
          <div className="space-y-2">
            <Input
              inputMode="numeric"
              type="number"
              value={rcloneCheckersInput}
              onChange={e => setRcloneCheckersInput(e.target.value)}
              onBlur={handleSaveRcloneCheckers}
              aria-invalid={Boolean(rcloneCheckersError)}
            />
            {rcloneCheckersError ? (
              <p className="text-sm text-destructive">{rcloneCheckersError}</p>
            ) : null}
          </div>
        </SettingsField>

        <SettingsField
          label="Rclone retries"
          description="How many times rclone retries a failed transfer before giving up (--retries)."
        >
          <div className="space-y-2">
            <Input
              inputMode="numeric"
              type="number"
              value={rcloneRetriesInput}
              onChange={e => setRcloneRetriesInput(e.target.value)}
              onBlur={handleSaveRcloneRetries}
              aria-invalid={Boolean(rcloneRetriesError)}
            />
            {rcloneRetriesError ? (
              <p className="text-sm text-destructive">{rcloneRetriesError}</p>
            ) : null}
          </div>
        </SettingsField>
      </AdvancedSection>
    </div>
  )
}

function generateId(): string {
  return `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
