import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { extractDriveFolderId } from '@/lib/drive-url'

export interface UploadDestinationState {
  destinationUrl: string
  destinationFolderId: string | null
  destinationError: boolean
  /**
   * Human labels for the chosen folder. The browser walks these anyway; keeping
   * them means the sidebar can show "Ionicboy TD > Ionic Mux > 2026" instead of
   * an opaque ID. Null when a link was pasted and the name is not known yet.
   */
  destinationName: string | null
  destinationPath: string[]
  /** True once the user has typed or picked a destination themselves. */
  hasUserSetDestination: boolean
  setDestinationUrl: (url: string) => void
  /** Record a folder chosen in the browser, complete with its ancestor path. */
  setDestinationFolder: (url: string, name: string, path: string[]) => void
  /** Attach a name resolved after the fact, e.g. for a pasted link. */
  setDestinationName: (folderId: string, name: string) => void
  /**
   * Seed the field from a saved preset. Ignored once the user has touched the
   * destination - otherwise clearing the input to paste a new URL instantly
   * refilled it with the first preset.
   */
  applyDefaultDestination: (url: string, name?: string) => void
  clearDestination: () => void
}

function derive(url: string) {
  const trimmed = url.trim()
  const folderId = extractDriveFolderId(trimmed)
  return {
    destinationUrl: url,
    destinationFolderId: folderId,
    destinationError: Boolean(trimmed) && !folderId,
    // Typing a new URL invalidates whatever name we were showing.
    destinationName: null,
    destinationPath: [] as string[],
  }
}

export const useUploadDestinationStore = create<UploadDestinationState>()(
  devtools(
    (set, get) => ({
      destinationUrl: '',
      destinationFolderId: null,
      destinationError: false,
      destinationName: null,
      destinationPath: [],
      hasUserSetDestination: false,

      setDestinationUrl: url =>
        set(
          { ...derive(url), hasUserSetDestination: true },
          undefined,
          'setDestinationUrl'
        ),

      applyDefaultDestination: (url, name) => {
        const { hasUserSetDestination, destinationUrl } = get()
        if (hasUserSetDestination || destinationUrl.trim()) return
        // `derive` clears the name, because typing a new URL invalidates it.
        // A preset already knows what it is called, so put that straight back -
        // otherwise the card showed a raw ID on every launch while it waited on
        // a Drive lookup that may never answer.
        set(
          { ...derive(url), destinationName: name ?? null },
          undefined,
          'applyDefaultDestination'
        )
      },

      setDestinationFolder: (url, name, path) =>
        set(
          {
            ...derive(url),
            destinationName: name,
            destinationPath: path,
            hasUserSetDestination: true,
          },
          undefined,
          'setDestinationFolder'
        ),

      setDestinationName: (folderId, name) =>
        set(
          state =>
            // Guard against a slow lookup landing after the user moved on.
            state.destinationFolderId === folderId
              ? { destinationName: name }
              : state,
          undefined,
          'setDestinationName'
        ),

      clearDestination: () =>
        set(
          {
            destinationUrl: '',
            destinationFolderId: null,
            destinationError: false,
            destinationName: null,
            destinationPath: [],
            hasUserSetDestination: false,
          },
          undefined,
          'clearDestination'
        ),
    }),
    { name: 'upload-destination' }
  )
)
