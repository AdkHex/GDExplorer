import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { logger } from '@/lib/logger'

export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text)
    return
  } catch (error) {
    // `removeUnusedCommands` is enabled in tauri.conf.json, and it strips
    // plugin commands it cannot see used in the frontend - the clipboard
    // commands were being removed before this feature existed. If the native
    // command is missing, the webview's own clipboard still works.
    logger.debug('Native clipboard unavailable, using the webview clipboard', {
      error: String(error),
    })
  }

  await navigator.clipboard.writeText(text)
}
