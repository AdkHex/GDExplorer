import React, { useCallback } from 'react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTheme } from '@/hooks/use-theme'
import { usePreferences, useSavePreferences } from '@/services/preferences'

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

export const AppearancePane: React.FC = () => {
  const { theme, setTheme } = useTheme()
  const savePreferences = useSavePreferences()
  const { data: preferences } = usePreferences()
  const speedUnit = preferences?.speedUnit ?? 'bytes'

  const handleSpeedUnitChange = useCallback(
    (value: 'bytes' | 'bits') => {
      savePreferences.mutate({ speedUnit: value })
    },
    [savePreferences]
  )

  const handleThemeChange = useCallback(
    async (value: 'light' | 'dark' | 'system') => {
      // Update the theme provider immediately for instant UI feedback
      setTheme(value)

      // Persist the theme preference to disk
      savePreferences.mutate({ theme: value })
    },
    [setTheme, savePreferences]
  )

  return (
    <div className="space-y-6">
      <SettingsSection title="Theme">
        <SettingsField
          label="Color Theme"
          description="Choose your preferred color theme"
        >
          <Select
            value={theme}
            onValueChange={handleThemeChange}
            disabled={savePreferences.isPending}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="system">System</SelectItem>
            </SelectContent>
          </Select>
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Transfers">
        <SettingsField
          label="Speed units"
          description="MiB/s matches the file sizes shown next to it. Mbps matches how ISPs and speed tests quote a connection - the same rate looks 8x larger in Mbps."
        >
          <Select
            value={speedUnit}
            onValueChange={handleSpeedUnitChange}
            disabled={savePreferences.isPending}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select speed units" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bytes">Bytes per second (MiB/s)</SelectItem>
              <SelectItem value="bits">Bits per second (Mbps)</SelectItem>
            </SelectContent>
          </Select>
        </SettingsField>
      </SettingsSection>
    </div>
  )
}
