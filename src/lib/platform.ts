export type DesktopPlatform = 'macos' | 'windows' | 'linux' | null

/**
 * Best-effort platform detection from the webview.
 *
 * Used to pick the right window controls and to hide platform-specific
 * features (the bundled rclone installer only supports Windows).
 */
export function detectPlatform(): DesktopPlatform {
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('mac')) return 'macos'
  if (platform.includes('win')) return 'windows'
  if (platform.includes('linux')) return 'linux'

  const userAgent = navigator.userAgent.toLowerCase()
  if (userAgent.includes('mac')) return 'macos'
  if (userAgent.includes('windows')) return 'windows'
  if (userAgent.includes('linux')) return 'linux'

  return null
}

export function isWindows(): boolean {
  return detectPlatform() === 'windows'
}
