// Google Drive folder IDs are base64url-ish strings. Real IDs are at least ~19
// characters; the floor here just keeps obvious typos from being treated as IDs.
const FOLDER_ID = /^[A-Za-z0-9_-]+$/
const BARE_FOLDER_ID = /^[A-Za-z0-9_-]{15,}$/

// Matches /drive/folders/<id>, /drive/u/0/folders/<id>, and the shared-drive
// equivalents Drive hands out for Shared Drive roots.
const FOLDER_PATH =
  /^\/drive(?:\/u\/\d+)?\/(?:folders|shared-drives)\/([A-Za-z0-9_-]+)\/?$/

export function extractDriveFolderId(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    // Not a URL - accept a bare folder ID so users can paste just the ID.
    return BARE_FOLDER_ID.test(trimmed) ? trimmed : null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname !== 'drive.google.com') return null

  // /file/d/<id> is a file, not a folder - reject rather than fall through.
  if (/^\/file\/d\/[A-Za-z0-9_-]+/.test(url.pathname)) return null

  const folderMatch = url.pathname.match(FOLDER_PATH)
  if (folderMatch?.[1]) return folderMatch[1]

  if (url.pathname === '/open' || url.pathname === '/drive/open') {
    const id = url.searchParams.get('id')
    if (id && FOLDER_ID.test(id)) return id
  }

  return null
}
