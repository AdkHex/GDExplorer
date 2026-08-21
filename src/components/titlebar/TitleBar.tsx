import { useState } from 'react'
import { cn } from '@/lib/utils'
import { MacOSWindowControls } from './MacOSWindowControls'
import { WindowsWindowControls } from './WindowsWindowControls'
import { Button } from '@/components/ui/button'
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
import { useUIStore } from '@/store/ui-store'
import {
  Download,
  Loader2,
  PanelLeft,
  PanelLeftClose,
  ScrollText,
  Settings,
  ShieldCheck,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { installUpdate } from '@/lib/updater'
import { detectPlatform } from '@/lib/platform'

interface TitleBarProps {
  className?: string
  title?: string
}

export function TitleBar({
  className,
  title = 'GDrive-Upload',
}: TitleBarProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const {
    leftSidebarVisible,
    toggleLeftSidebar,
    logPanelVisible,
    toggleLogPanel,
    setPreferencesOpen,
    setPreflightOpen,
    updateReady,
    updateDownloading,
    updateVersion,
    updateProgress,
  } = useUIStore()

  const platformName = detectPlatform()

  return (
    <div
      data-tauri-drag-region
      className={cn(
        'relative flex h-9 w-full shrink-0 items-center justify-between border-b bg-background',
        className
      )}
    >
      {/* Left side - Window Controls + Left Actions */}
      <div className="flex items-center">
        {platformName === 'macos' ? <MacOSWindowControls /> : null}

        {/* Left Action Buttons */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={toggleLeftSidebar}
                variant="ghost"
                size="icon"
                className="size-7 text-foreground/70 hover:text-foreground"
                aria-label={
                  leftSidebarVisible ? 'Hide sidebar' : 'Show sidebar'
                }
              >
                {leftSidebarVisible ? (
                  <PanelLeftClose className="size-3.5" />
                ) : (
                  <PanelLeft className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {leftSidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
              <span className="ml-2 opacity-60">⌘1</span>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={toggleLogPanel}
                variant="ghost"
                size="icon"
                className={cn(
                  'size-7 text-foreground/70 hover:text-foreground',
                  logPanelVisible && 'text-foreground'
                )}
                aria-label={logPanelVisible ? 'Hide log' : 'Show log'}
                aria-pressed={logPanelVisible}
              >
                <ScrollText className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {logPanelVisible ? 'Hide log' : 'Show log'}
              <span className="ml-2 opacity-60">⌘2</span>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Center - Title */}
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-baseline gap-1.5">
        <span className="text-sm font-medium text-foreground/80">{title}</span>
        <span className="text-[10px] text-muted-foreground">by ionicboy</span>
      </div>

      {/* Right side - Right Actions */}
      <div className="flex items-center gap-1 pr-2">
        {updateDownloading ? (
          <div
            className="flex items-center gap-1 text-foreground/70 text-xs"
            title={
              updateProgress !== null
                ? `Downloading update (${updateProgress}%)`
                : 'Downloading update'
            }
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            {updateProgress !== null ? `${updateProgress}%` : 'Downloading…'}
          </div>
        ) : null}
        {updateReady ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => setConfirmOpen(true)}
                variant="ghost"
                size="icon"
                className="size-7 text-status-info hover:text-status-info"
                aria-label="Restart to install update"
              >
                <Download className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {updateVersion
                ? `Restart to update (${updateVersion})`
                : 'Restart to update'}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {/* Checking the setup is app-level configuration, so it groups with
            Settings here rather than sitting in the transfers toolbar. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={() => setPreflightOpen(true)}
              variant="ghost"
              size="icon"
              className="size-7 text-foreground/70 hover:text-foreground"
              aria-label="Check setup"
            >
              <ShieldCheck className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Check setup</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={() => setPreferencesOpen(true)}
              variant="ghost"
              size="icon"
              className="size-7 text-foreground/70 hover:text-foreground"
              aria-label="Settings"
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Settings
            <span className="ml-2 opacity-60">⌘,</span>
          </TooltipContent>
        </Tooltip>
        {platformName === 'windows' ? (
          <WindowsWindowControls className="ml-2" />
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

export default TitleBar
