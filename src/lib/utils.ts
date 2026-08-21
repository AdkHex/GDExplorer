import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Basename of a path, handling both separators and trailing slashes. */
export function getPathName(path: string): string {
  const normalized = path.replace(/[/\\]+$/g, '')
  const parts = normalized.split(/[/\\]/)
  return parts[parts.length - 1] || normalized
}
