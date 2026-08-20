import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useUIStore } from '@/store/ui-store'
import { logger } from '@/lib/logger'
import { checkForUpdates } from '@/lib/updater'

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false

  const el = target.closest(
    'input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]'
  )
  if (!el) return false

  if (el instanceof HTMLInputElement) {
    const nonTextTypes = new Set([
      'button',
      'checkbox',
      'color',
      'file',
      'radio',
      'range',
      'reset',
      'submit',
    ])
    return !nonTextTypes.has(el.type)
  }

  return true
}

/**
 * Main window event listeners - handles global keyboard shortcuts and other app-level events
 *
 * This hook provides a centralized place for all global event listeners, keeping
 * the MainWindow component clean while maintaining good separation of concerns.
 */
export function useMainWindowEventListeners() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextInputTarget(e.target)) return

      // Check for keyboard shortcuts
      if (e.metaKey || e.ctrlKey) {
        switch (e.key) {
          case ',': {
            e.preventDefault()
            useUIStore.getState().setPreferencesOpen(true)
            break
          }
          case '1': {
            e.preventDefault()
            const { leftSidebarVisible, setLeftSidebarVisible } =
              useUIStore.getState()
            setLeftSidebarVisible(!leftSidebarVisible)
            break
          }
          case '2': {
            e.preventDefault()
            useUIStore.getState().toggleLogPanel()
            break
          }
        }
      }
    }

    // Set up native menu event listeners
    const setupMenuListeners = async () => {
      logger.debug('Setting up menu event listeners')
      const unlisteners = await Promise.all([
        listen('menu-about', () => {
          logger.debug('About menu event received')
          // Open the About pane, which reads the real version from Tauri,
          // rather than a blocking alert with a hardcoded version string.
          useUIStore.getState().openPreferencesAt('about')
        }),

        listen('menu-check-updates', async () => {
          logger.debug('Check for updates menu event received')
          await checkForUpdates({
            notifyIfLatest: true,
            notifyOnError: true,
            notifyOnReady: true,
          })
        }),

        listen('menu-preferences', () => {
          logger.debug('Preferences menu event received')
          useUIStore.getState().setPreferencesOpen(true)
        }),

        listen('menu-toggle-left-sidebar', () => {
          logger.debug('Toggle left sidebar menu event received')
          const { leftSidebarVisible, setLeftSidebarVisible } =
            useUIStore.getState()
          setLeftSidebarVisible(!leftSidebarVisible)
        }),

        listen('menu-toggle-log-panel', () => {
          logger.debug('Toggle log panel menu event received')
          useUIStore.getState().toggleLogPanel()
        }),
      ])

      logger.debug(
        `Menu listeners set up successfully: ${unlisteners.length} listeners`
      )
      return unlisteners
    }

    document.addEventListener('keydown', handleKeyDown)

    let menuUnlisteners: (() => void)[] = []
    setupMenuListeners()
      .then(unlisteners => {
        menuUnlisteners = unlisteners
        logger.debug('Menu listeners initialized successfully')
      })
      .catch(error => {
        logger.error('Failed to setup menu listeners:', error)
      })

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      menuUnlisteners.forEach(unlisten => {
        if (unlisten && typeof unlisten === 'function') {
          unlisten()
        }
      })
    }
  }, [])

  // Future: Other global event listeners can be added here
  // useWindowFocusListeners()
}
