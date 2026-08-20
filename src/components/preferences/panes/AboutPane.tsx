import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { checkForUpdates, installUpdate } from '@/lib/updater'
import { useUIStore } from '@/store/ui-store'
import { usePreferences, useSavePreferences } from '@/services/preferences'

export const AboutPane: React.FC = () => {
  const [appVersion, setAppVersion] = useState<string>('—')
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true)
  const { data: preferences } = usePreferences()
  const savePreferences = useSavePreferences()
  const { updateDownloading, updateProgress, updateReady, updateVersion } =
    useUIStore()

  useEffect(() => {
    getVersion()
      .then(version => setAppVersion(version))
      .catch(() => setAppVersion('Unknown'))
  }, [])

  useEffect(() => {
    if (!preferences) return
    setAutoCheckUpdates(preferences.autoCheckUpdates ?? true)
  }, [preferences])

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium text-foreground">About</h3>
        <Separator className="mt-2" />
      </div>
      <div className="space-y-1">
        <p className="text-sm text-foreground">
          GDrive-Upload{' '}
          <span className="text-xs text-muted-foreground">by ionicboy</span>
        </p>
        <p className="text-sm text-muted-foreground">Version {appVersion}</p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-foreground">Auto-check updates</p>
            <p className="text-sm text-muted-foreground">
              Check for updates when the app starts.
            </p>
          </div>
          <Switch
            checked={autoCheckUpdates}
            disabled={savePreferences.isPending}
            onCheckedChange={checked => {
              setAutoCheckUpdates(checked)
              savePreferences
                .mutateAsync({ autoCheckUpdates: checked })
                .catch(() => {
                  setAutoCheckUpdates(preferences?.autoCheckUpdates ?? true)
                })
            }}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Download updates automatically and restart when you are ready.
        </p>
        <Button
          type="button"
          onClick={async () => {
            if (updateReady) {
              setConfirmOpen(true)
              return
            }
            if (isCheckingUpdates) return
            setIsCheckingUpdates(true)
            setStatusMessage(null)
            try {
              const result = await checkForUpdates({
                notifyIfLatest: false,
                notifyOnError: false,
                notifyOnReady: false,
              })
              if (result === 'latest') {
                setStatusMessage("You're up to date.")
              } else if (result === 'error') {
                setStatusMessage('Update check failed. Try again.')
              }
            } finally {
              setIsCheckingUpdates(false)
            }
          }}
          disabled={isCheckingUpdates || updateDownloading}
          aria-busy={isCheckingUpdates || updateDownloading}
        >
          {updateReady ? (
            updateVersion ? (
              `Restart to update (${updateVersion})`
            ) : (
              'Restart to update'
            )
          ) : updateDownloading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {updateProgress !== null
                ? `Downloading (${updateProgress}%)`
                : 'Downloading…'}
            </>
          ) : isCheckingUpdates ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking…
            </>
          ) : (
            'Check for updates'
          )}
        </Button>
        {statusMessage ? (
          <p className="text-sm text-muted-foreground">{statusMessage}</p>
        ) : null}
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart to update?</AlertDialogTitle>
            <AlertDialogDescription>
              GDrive-Upload will restart to install the update.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Later</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                await installUpdate()
              }}
            >
              Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
