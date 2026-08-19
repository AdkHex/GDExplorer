import { cn } from '@/lib/utils'

interface LeftSideBarProps {
  children?: React.ReactNode
  className?: string
}

export function LeftSideBar({ children, className }: LeftSideBarProps) {
  return (
    <div
      className={cn(
        // `bg-sidebar` gives the standard macOS sidebar/content tonal split;
        // the panel used to be the same flat colour as the content area.
        'flex h-full flex-col border-r bg-sidebar text-sidebar-foreground',
        className
      )}
    >
      {children}
    </div>
  )
}

export default LeftSideBar
