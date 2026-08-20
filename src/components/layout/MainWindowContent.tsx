import { cn } from '@/lib/utils'
import { BrowseLocalFiles } from '@/components/upload/BrowseLocalFiles'
import { LeftSideBar } from '@/components/layout/LeftSideBar'
import { LogPanel } from '@/components/logs/LogPanel'
import { DestinationPicker } from '@/components/upload/DestinationPicker'
import { PreflightSection } from '@/components/preflight/PreflightPanel'
import { QueueSummary } from '@/components/transfers/QueueSummary'
import { Separator } from '@/components/ui/separator'
import { useUIStore } from '@/store/ui-store'

interface MainWindowContentProps {
  children?: React.ReactNode
  className?: string
}

export function MainWindowContent({
  children,
  className,
}: MainWindowContentProps) {
  const leftSidebarVisible = useUIStore(s => s.leftSidebarVisible)
  const logPanelVisible = useUIStore(s => s.logPanelVisible)
  const setLogPanelVisible = useUIStore(s => s.setLogPanelVisible)

  if (children) {
    return (
      <div className={cn('flex h-full flex-col bg-background', className)}>
        {children}
      </div>
    )
  }

  return (
    <div className={cn('flex h-full w-full bg-background', className)}>
      {leftSidebarVisible ? (
        // 360px of chrome for a single URL field was mostly empty space. The
        // panel is narrower now and earns its width with the queue summary.
        <LeftSideBar className="w-60 shrink-0">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            <DestinationPicker />
            <Separator />
            <PreflightSection />
            <Separator />
            <QueueSummary />
          </div>
        </LeftSideBar>
      ) : null}
      {/* The log sits under the transfer list rather than beside it: its lines
          are long, and it is a companion to what the table is doing. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <BrowseLocalFiles />
        </div>
        {logPanelVisible ? (
          <LogPanel onClose={() => setLogPanelVisible(false)} />
        ) : null}
      </div>
    </div>
  )
}

export default MainWindowContent
