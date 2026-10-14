// One-time notice on Windows: the installer now installs per user and cannot
// remove a copy an earlier installer put in Program Files for every account.
// Only an administrator can. See docs/REMOTE-STATUS.md.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { logger } from '@/lib/logger'
import { inTauri, useServiceLockStore } from '@/lib/service-lock'

export function AllUsersInstallNotice() {
  // Wait until the lock screen is gone, so the two never stack.
  const locked = useServiceLockStore(state => state.lock?.locked ?? true)
  const [location, setLocation] = useState<string | null>(null)
  const asked = useRef(false)

  useEffect(() => {
    if (locked || asked.current || !inTauri()) return
    asked.current = true
    invoke<string | null>('all_users_install_notice')
      .then(setLocation)
      .catch(error =>
        logger.debug('All-users install check failed', {
          error: String(error),
        })
      )
  }, [locked])

  const dismiss = () => {
    setLocation(null)
    invoke('dismiss_all_users_install_notice').catch(error =>
      logger.warn('Could not save the notice as shown', {
        error: String(error),
      })
    )
  }

  return (
    <AlertDialog
      open={location !== null}
      onOpenChange={open => {
        if (!open) dismiss()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>An all-users copy is installed</AlertDialogTitle>
          <AlertDialogDescription>
            An all-users copy is installed in Program Files. Ask an
            administrator to uninstall it from Settings &gt; Apps.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {location ? (
          <p className="break-all text-xs text-muted-foreground select-text">
            {location}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          This copy is installed for your account only. Until the old copy is
          removed, every account on this computer still sees it.
        </p>
        <AlertDialogFooter>
          <AlertDialogAction onClick={dismiss}>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
