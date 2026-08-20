import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Mock ResizeObserver for libraries like react-resizable-panels
class ResizeObserverMock {
  observe() {
    return
  }
  unobserve() {
    return
  }
  disconnect() {
    return
  }
}

;(
  globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }
).ResizeObserver = ResizeObserverMock

// Mock matchMedia for tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Radix primitives use pointer capture and scrollIntoView, neither of which
// jsdom implements. Without these, opening a menu or select throws.
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.setPointerCapture = vi.fn()
Element.prototype.releasePointerCapture = vi.fn()
Element.prototype.scrollIntoView = vi.fn()

// Mock Tauri APIs for tests
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {
    // Mock unlisten function
  }),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn().mockResolvedValue(null),
}))
