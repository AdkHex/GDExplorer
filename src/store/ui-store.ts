import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export type PreferencePane = 'general' | 'appearance' | 'about'

interface UIState {
  leftSidebarVisible: boolean
  preferencesOpen: boolean
  preferencesPane: PreferencePane
  updateDownloading: boolean
  updateReady: boolean
  updateVersion: string | null
  updateProgress: number | null
  updateChecking: boolean
  updateSplashDismissed: boolean

  toggleLeftSidebar: () => void
  setLeftSidebarVisible: (visible: boolean) => void
  togglePreferences: () => void
  setPreferencesOpen: (open: boolean) => void
  setPreferencesPane: (pane: PreferencePane) => void
  openPreferencesAt: (pane: PreferencePane) => void
  setUpdateDownloading: (downloading: boolean, version?: string | null) => void
  setUpdateReady: (ready: boolean, version?: string | null) => void
  setUpdateProgress: (progress: number | null) => void
  setUpdateChecking: (checking: boolean) => void
  dismissUpdateSplash: () => void
}

export const useUIStore = create<UIState>()(
  devtools(
    set => ({
      leftSidebarVisible: true,
      preferencesOpen: false,
      preferencesPane: 'general',
      updateDownloading: false,
      updateReady: false,
      updateVersion: null,
      updateProgress: null,
      updateChecking: false,
      updateSplashDismissed: false,

      toggleLeftSidebar: () =>
        set(
          state => ({ leftSidebarVisible: !state.leftSidebarVisible }),
          undefined,
          'toggleLeftSidebar'
        ),

      setLeftSidebarVisible: visible =>
        set(
          { leftSidebarVisible: visible },
          undefined,
          'setLeftSidebarVisible'
        ),

      togglePreferences: () =>
        set(
          state => ({ preferencesOpen: !state.preferencesOpen }),
          undefined,
          'togglePreferences'
        ),

      setPreferencesOpen: open =>
        set({ preferencesOpen: open }, undefined, 'setPreferencesOpen'),

      setPreferencesPane: pane =>
        set({ preferencesPane: pane }, undefined, 'setPreferencesPane'),

      openPreferencesAt: pane =>
        set(
          { preferencesOpen: true, preferencesPane: pane },
          undefined,
          'openPreferencesAt'
        ),

      setUpdateDownloading: (downloading, version = null) =>
        set(
          {
            updateDownloading: downloading,
            updateVersion: downloading ? version : null,
            updateProgress: null,
          },
          undefined,
          'setUpdateDownloading'
        ),

      setUpdateReady: (ready, version = null) =>
        set(
          {
            updateReady: ready,
            updateVersion: ready ? version : null,
            updateDownloading: false,
            updateProgress: null,
          },
          undefined,
          'setUpdateReady'
        ),

      setUpdateProgress: progress =>
        set({ updateProgress: progress }, undefined, 'setUpdateProgress'),

      // Starting a new check re-arms the splash; dismissing it during a check
      // keeps it hidden for the download that follows, so the user is never
      // locked out of the app while an update transfers in the background.
      setUpdateChecking: checking =>
        set(
          checking
            ? { updateChecking: true, updateSplashDismissed: false }
            : { updateChecking: false },
          undefined,
          'setUpdateChecking'
        ),

      dismissUpdateSplash: () =>
        set({ updateSplashDismissed: true }, undefined, 'dismissUpdateSplash'),
    }),
    {
      name: 'ui-store',
    }
  )
)
