// Types that match the Rust AppPreferences struct
// Only contains settings that should be persisted to disk
export interface AppPreferences {
  theme: string
  autoCheckUpdates: boolean
  /** Post a system notification when a batch of uploads finishes. */
  notifyOnCompletion: boolean
  /** Show the menu bar / tray icon with upload progress. */
  showTrayIcon: boolean
  /** Closing the window hides it instead of quitting. Needs the tray icon. */
  closeToTray: boolean
  serviceAccountFolderPath: string | null
  maxConcurrentUploads: number
  uploadChunkSizeMib: number
  rclonePath: string
  rcloneRemoteName: string
  rcloneTransfers: number
  rcloneCheckers: number
  rcloneRetries: number
  /** rclone `--bwlimit` value, e.g. "10M". Empty means unlimited. */
  rcloneBandwidthLimit: string
  /** Glob patterns passed to rclone as `--exclude`. */
  rcloneExcludePatterns: string[]
  destinationPresets: DestinationPreset[]
}

export interface DestinationPreset {
  id: string
  name: string
  url: string
}

export const defaultPreferences: AppPreferences = {
  theme: 'system',
  autoCheckUpdates: true,
  notifyOnCompletion: true,
  showTrayIcon: true,
  closeToTray: false,
  serviceAccountFolderPath: null,
  maxConcurrentUploads: 3,
  uploadChunkSizeMib: 256,
  rclonePath: 'rclone',
  rcloneRemoteName: 'gdrive',
  rcloneTransfers: 16,
  rcloneCheckers: 16,
  rcloneRetries: 3,
  rcloneBandwidthLimit: '',
  rcloneExcludePatterns: [],
  destinationPresets: [],
}
