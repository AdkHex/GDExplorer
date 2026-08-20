import { invoke } from '@tauri-apps/api/core'

// Copying links is not the only thing that reaches the clipboard any more (the
// log panel does too), so the implementation lives in its own module and is
// re-exported here for the call sites that already import it from here.
export { copyText } from '@/lib/clipboard'

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
