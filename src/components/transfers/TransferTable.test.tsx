import { render, screen, act } from '@/test/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TransferTable } from './TransferTable'
import { useLocalUploadQueue } from '@/store/local-upload-queue-store'
import { useTransferUiStore } from '@/store/transfer-ui-store'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({
    theme: 'system',
    destinationPresets: [],
  }),
}))

const ITEM_ID = '/movies/Flyboys.2006.mkv'

/**
 * Mirrors how BrowseLocalFiles hosts the table: it subscribes to the queue, so
 * every progress event re-renders it and hands the table brand-new callback
 * identities. The table has to tolerate that without remounting its cells.
 */
function Harness() {
  useLocalUploadQueue(s => s.items)
  return (
    <TransferTable
      isDropActive={false}
      onBrowse={() => undefined}
      onStartSelected={() => undefined}
      onPauseSelected={() => undefined}
      onRemoveSelected={() => undefined}
      isUploading
    />
  )
}

function renderTable() {
  return render(<Harness />)
}

/**
 * Flush the preferences query so preset-driven renders settle first. Saved
 * presets are part of the menu, so a change to them legitimately rebuilds the
 * columns; several turns are needed for the query to resolve and re-render.
 */
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

describe('TransferTable cell stability', () => {
  beforeEach(() => {
    useLocalUploadQueue.setState({
      items: [
        {
          id: ITEM_ID,
          path: ITEM_ID,
          kind: 'file',
          addedAt: 0,
          status: 'uploading',
          bytesSent: 10,
          totalBytes: 1000,
        },
      ],
    })
    useTransferUiStore.setState({
      pausedById: {},
      metricsById: {},
      fileProgressById: {},
      fileOrderById: {},
      fileMetricsById: {},
    })
  })

  // An upload re-renders this table several times a second. `flexRender` turns
  // each column's `cell` into a component, so if the columns array is rebuilt
  // per render React swaps in a new component type and remounts every cell.
  // That destroyed any open destination menu a moment after it was opened.
  it('does not remount cells while upload progress arrives', async () => {
    renderTable()
    await settle()

    const trigger = screen.getByTitle('Follows the destination in the sidebar')
    const nameCell = screen.getByText('Flyboys.2006.mkv')

    for (let i = 1; i <= 10; i += 1) {
      act(() => {
        useLocalUploadQueue.getState().setItemProgress(ITEM_ID, i * 100, 1000)
        // rclone also emits per-file progress several times a second, which
        // rewrites the per-file bookkeeping in the transfer store.
        useTransferUiStore
          .getState()
          .recordFileProgress(ITEM_ID, ITEM_ID, i * 100, 1000)
      })
    }

    // Same DOM nodes means React re-rendered in place rather than remounting.
    expect(screen.getByTitle('Follows the destination in the sidebar')).toBe(
      trigger
    )
    expect(screen.getByText('Flyboys.2006.mkv')).toBe(nameCell)
  })

  it('does not remount cells when transfer metrics tick', async () => {
    renderTable()
    await settle()

    const trigger = screen.getByTitle('Follows the destination in the sidebar')

    act(() => {
      useTransferUiStore.getState().tick([
        {
          id: ITEM_ID,
          status: 'uploading',
          bytesSent: 500,
          totalBytes: 1000,
        },
      ])
    })

    expect(screen.getByTitle('Follows the destination in the sidebar')).toBe(
      trigger
    )
  })
})
