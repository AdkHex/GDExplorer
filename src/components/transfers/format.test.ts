import { describe, it, expect } from 'vitest'
import { formatBytes, formatEta, formatSpeed } from './format'

describe('formatBytes', () => {
  it('handles zero and invalid input', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })

  it('uses binary units matching the 1024 divisor', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GiB')
  })

  it('drops the decimal for large values', () => {
    expect(formatBytes(20 * 1024)).toBe('20 KiB')
  })
})

describe('formatSpeed', () => {
  it('renders a per-second rate', () => {
    expect(formatSpeed(0)).toBe('0 B/s')
    expect(formatSpeed(1024 * 1024)).toBe('1.0 MiB/s')
  })
})

describe('formatEta', () => {
  it('renders nothing meaningful for unknown values', () => {
    expect(formatEta(null)).toBe('—')
    expect(formatEta(undefined)).toBe('—')
    expect(formatEta(0)).toBe('—')
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('formats seconds, minutes and hours', () => {
    expect(formatEta(45)).toBe('45s')
    expect(formatEta(90)).toBe('1m 30s')
    expect(formatEta(3725)).toBe('1h 2m')
  })
})
