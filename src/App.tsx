import { useEffect, useRef } from 'react'
import { logger } from './lib/logger'
import { cleanupOldFiles } from './lib/recovery'
import { checkForUpdates } from './lib/updater'
import './App.css'
import MainWindow from './components/layout/MainWindow'
import { ThemeProvider } from './components/ThemeProvider'
import ErrorBoundary from './components/ErrorBoundary'
import { usePreferences } from './services/preferences'
import { UpdateSplash } from './components/update/UpdateSplash'
import { useUIStore } from './store/ui-store'
import { ServiceLockOverlay } from './components/service/ServiceLockOverlay'
import { AllUsersInstallNotice } from './components/service/AllUsersInstallNotice'
import { startServiceLockSync, useServiceLockStore } from './lib/service-lock'
import { queryClient } from './lib/query-client'

function App() {
  const { data: preferences } = usePreferences()
  const { updateChecking, updateDownloading, updateSplashDismissed } =
    useUIStore()
  const hasCheckedUpdates = useRef(false)

  // The remote switch and access password. Anything that failed while locked
  // is fetched again once the lock lifts.
  useEffect(() => {
    const stop = startServiceLockSync()
    const unsubscribe = useServiceLockStore.subscribe((state, previous) => {
      if (previous.lock?.locked && state.lock && !state.lock.locked) {
        void queryClient.invalidateQueries()
      }
    })
    return () => {
      unsubscribe()
      void stop.then(f => f())
    }
  }, [])

  // Initialize command system and cleanup on app startup
  useEffect(() => {
    logger.info('🚀 Frontend application starting up')

    // Clean up old recovery files on startup
    cleanupOldFiles().catch(error => {
      logger.warn('Failed to cleanup old recovery files', { error })
    })

    // Example of logging with context
    logger.info('App environment', {
      isDev: import.meta.env.DEV,
      mode: import.meta.env.MODE,
    })
  }, [])

  useEffect(() => {
    if (!preferences) return
    if (!preferences.autoCheckUpdates) return
    if (hasCheckedUpdates.current) return
    hasCheckedUpdates.current = true

    checkForUpdates({
      notifyIfLatest: false,
      notifyOnError: false,
      notifyOnReady: false,
    }).catch(() => undefined)
  }, [preferences])

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <MainWindow />
        <UpdateSplash
          visible={
            (updateChecking || updateDownloading) && !updateSplashDismissed
          }
        />
        <ServiceLockOverlay />
        <AllUsersInstallNotice />
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
