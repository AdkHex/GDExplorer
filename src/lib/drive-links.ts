import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { logger } from '@/lib/logger'

export interface DriveFileLink {
  /** Path relative to the uploaded item, matching what the file rows show. */
  filePath: string
  fileId: string
}

export interface ItemLinks {
  /** Set for folder items once rclone has created the folder in Drive. */
  folderId: string | null
  files: DriveFileLink[]
}

export function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`
}

export function driveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`
}

/**
 * Asks the backend to list the item back out of Drive to get its IDs.
 *
 * rclone never reports the IDs it creates, so there is nothing to capture
 * during the upload itself. A folder resolves as soon as rclone has created it,
 * which is why a folder link can be copied mid-upload; a single file only
 * exists in Drive once its upload finishes.
 */
export function resolveItemLinks(
  path: string,
  kind: 'file' | 'folder',
  destinationFolderId: string
): Promise<ItemLinks> {
  return invoke<ItemLinks>('resolve_item_links', {
    args: { path, kind, destinationFolderId },
  })
}

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
