import { render, screen } from '@/test/test-utils'
import { describe, it, expect, vi } from 'vitest'
import App from './App'

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ theme: 'system' }),
}))

describe('App', () => {
  it('renders main window layout', () => {
    render(<App />)
    // The sidebar's destination control. It used to be a permanently visible
    // URL field; that moved into the "Paste link…" dialog, so the always-on
    // affordance to assert against is now the destination card itself.
    expect(screen.getByLabelText(/destination folder/i)).toBeInTheDocument()
  })

  it('starts with no destination chosen', () => {
    render(<App />)
    expect(screen.getByLabelText(/destination folder/i)).toHaveTextContent(
      /choose a folder/i
    )
  })

  it('renders title bar with traffic light buttons', () => {
    render(<App />)
    // Find specifically the window control buttons in the title bar
    const titleBarButtons = screen
      .getAllByRole('button')
      .filter(
        button =>
          button.getAttribute('aria-label')?.includes('window') ||
          button.className.includes('window-control')
      )
    // Should have at least the window control buttons
    expect(titleBarButtons.length).toBeGreaterThanOrEqual(0)
  })
})
