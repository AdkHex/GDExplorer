import { TitleBar } from '@/components/titlebar/TitleBar'
import { MainWindowContent } from './MainWindowContent'
import { PreferencesDialog } from '@/components/preferences/PreferencesDialog'
import { Toaster } from 'sonner'
import { useTheme } from '@/hooks/use-theme'
import { useMainWindowEventListeners } from '@/hooks/useMainWindowEventListeners'
import { useTrayStatus } from '@/hooks/useTrayStatus'

export function MainWindow() {
  const { theme } = useTheme()

  // Set up global event listeners (keyboard shortcuts, etc.)
  useMainWindowEventListeners()

  // Keep the menu bar / tray icon showing how the queue is doing.
  useTrayStatus()

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden rounded-xl bg-background">
      {/* Title Bar */}
      <TitleBar />

      {/* Main Content Area */}
      <div className="flex-1 overflow-hidden">
        <MainWindowContent className="w-full" />
      </div>

      {/* Global UI Components (hidden until triggered) */}
      <PreferencesDialog />
      <Toaster
        position="bottom-right"
        theme={
          theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system'
        }
        className="toaster group"
        toastOptions={{
          classNames: {
            toast:
              'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
            description: 'group-[.toast]:text-muted-foreground',
            actionButton:
              'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
            cancelButton:
              'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          },
        }}
      />
    </div>
  )
}

export default MainWindow
