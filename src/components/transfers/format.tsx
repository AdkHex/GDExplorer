export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  // Binary units, to match the 1024 divisor. These used to be labelled
  // KB/MB/GB, which understated every figure by ~2.4% per step.
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`
}

/**
 * How transfer rates are displayed. Bytes (MiB/s) matches the file sizes shown
 * beside them; bits (Mbps) matches how ISPs and speed tests quote a connection.
 * The two differ by 8x, which is a very easy thing to misread.
 */
export type SpeedUnit = 'bytes' | 'bits'

export function formatSpeed(
  bytesPerSec: number,
  unit: SpeedUnit = 'bytes'
): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return unit === 'bits' ? '0 bps' : '0 B/s'
  }
  if (unit === 'bits') return formatBitrate(bytesPerSec * 8)
  return `${formatBytes(bytesPerSec)}/s`
}

/**
 * Bitrates are quoted in decimal units - 1 Mbps is 1,000,000 bits per second,
 * not 1,048,576 - so this cannot reuse the 1024-based `formatBytes`.
 */
function formatBitrate(bitsPerSec: number): string {
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'] as const
  let value = bitsPerSec
  let unitIndex = 0
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  if (!Number.isFinite(seconds)) return '—'
  if (seconds <= 0) return '—'
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}
