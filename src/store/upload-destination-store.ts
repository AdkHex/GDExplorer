import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { extractDriveFolderId } from '@/lib/drive-url'

export interface UploadDestinationState {
  destinationUrl: string
  destinationFolderId: string | null
  destinationError: boolean
  /** True once the user has typed or picked a destination themselves. */
  hasUserSetDestination: boolean
  setDestinationUrl: (url: string) => void
  /**
   * Seed the field from a saved preset. Ignored once the user has touched the
   * destination - otherwise clearing the input to paste a new URL instantly
   * refilled it with the first preset.
   */
  applyDefaultDestination: (url: string) => void
  clearDestination: () => void
}

function derive(url: string) {
  const trimmed = url.trim()
  const folderId = extractDriveFolderId(trimmed)
  return {
    destinationUrl: url,
    destinationFolderId: folderId,
    destinationError: Boolean(trimmed) && !folderId,
  }
}

export const useUploadDestinationStore = create<UploadDestinationState>()(
  devtools(
    (set, get) => ({
      destinationUrl: '',
      destinationFolderId: null,
      destinationError: false,
      hasUserSetDestination: false,

      setDestinationUrl: url =>
        set(
          { ...derive(url), hasUserSetDestination: true },
          undefined,
          'setDestinationUrl'
        ),

      applyDefaultDestination: url => {
        const { hasUserSetDestination, destinationUrl } = get()
        if (hasUserSetDestination || destinationUrl.trim()) return
        set(derive(url), undefined, 'applyDefaultDestination')
      },

      clearDestination: () =>
        set(
          {
            destinationUrl: '',
            destinationFolderId: null,
            destinationError: false,
            hasUserSetDestination: false,
          },
          undefined,
          'clearDestination'
        ),
    }),
    { name: 'upload-destination' }
  )
)
