// Types that match the Rust AppPreferences struct
// Only contains settings that should be persisted to disk
export interface AppPreferences {
  theme: string
  autoCheckUpdates: boolean
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
