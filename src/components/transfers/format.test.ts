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

  it('defaults to bytes when no unit is given', () => {
    expect(formatSpeed(1024 * 1024, 'bytes')).toBe('1.0 MiB/s')
  })

  it('renders bitrates in decimal units', () => {
    // Bitrates are quoted per 1000, not 1024: 125,000 B/s is exactly 1 Mbps.
    expect(formatSpeed(125_000, 'bits')).toBe('1.0 Mbps')
    expect(formatSpeed(0, 'bits')).toBe('0 bps')
  })

  it('converts a real transfer rate to the figure ISPs quote', () => {
    // 112 MiB/s is ~940 Mbps - the 8x gap that makes MiB/s look slow.
    expect(formatSpeed(112 * 1024 * 1024, 'bits')).toBe('940 Mbps')
    expect(formatSpeed(112 * 1024 * 1024, 'bytes')).toBe('112 MiB/s')
  })

  it('steps up to Gbps', () => {
    expect(formatSpeed(250_000_000, 'bits')).toBe('2.0 Gbps')
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
