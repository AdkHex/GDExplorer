import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import type { AppPreferences } from '@/types/preferences'
import { defaultPreferences } from '@/types/preferences'

// Query keys for preferences
export const preferencesQueryKeys = {
  all: ['preferences'] as const,
  preferences: () => [...preferencesQueryKeys.all] as const,
}

async function fetchPreferences(): Promise<AppPreferences> {
  try {
    logger.debug('Loading preferences from backend')
    const preferences = await invoke<AppPreferences>('load_preferences')
    logger.info('Preferences loaded successfully', { preferences })
    return { ...defaultPreferences, ...preferences }
  } catch (error) {
    // Return defaults if preferences file doesn't exist yet
    logger.warn('Failed to load preferences, using defaults', { error })
    return defaultPreferences
  }
}

// TanStack Query hooks following the architectural patterns
export function usePreferences() {
  return useQuery({
    queryKey: preferencesQueryKeys.preferences(),
    queryFn: fetchPreferences,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  })
}

// Preferences are saved as a whole object, and the UI saves individual fields
// on blur. Without serialization two saves fired close together would both read
// the same cached snapshot and the second would silently drop the first's edit.
// Every save takes a turn on this chain, reads the cache *after* acquiring its
// turn, and publishes the merged result before awaiting the disk write.
let saveChain: Promise<unknown> = Promise.resolve()

async function savePreferencesSerialized(
  queryClient: QueryClient,
  update: Partial<AppPreferences>
): Promise<AppPreferences> {
  const run = saveChain.then(async () => {
    const key = preferencesQueryKeys.preferences()
    const cached = queryClient.getQueryData<AppPreferences>(key)
    const current: AppPreferences =
      cached ??
      (await queryClient.ensureQueryData<AppPreferences>({
        queryKey: key,
        queryFn: fetchPreferences,
      }))

    const preferences: AppPreferences = { ...current, ...update }
    queryClient.setQueryData(key, preferences)

    try {
      logger.debug('Saving preferences to backend', { preferences })
      await invoke('save_preferences', { preferences })
      logger.info('Preferences saved successfully')
      return preferences
    } catch (error) {
      // Roll the cache back so the UI reflects what is actually on disk.
      queryClient.setQueryData(key, current)
      throw error
    }
  })

  saveChain = run.catch(() => undefined)
  return run
}

export function useSavePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    // Retrying would re-run the whole read-merge-write cycle; the caller
    // surfaces failures and restores its own field state instead.
    retry: 0,
    mutationFn: (preferencesUpdate: Partial<AppPreferences>) =>
      savePreferencesSerialized(queryClient, preferencesUpdate),
    onSuccess: () => {
      toast.success('Preferences saved')
    },
    onError: (error, preferencesUpdate) => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to save preferences', { error, preferencesUpdate })
      toast.error('Failed to save preferences', { description: message })
    },
  })
}
