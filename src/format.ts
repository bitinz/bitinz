import type { Note } from './client.js'

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** Percentage saved, rounded; negative when the result grew. */
export function savedPercent(input: number, output: number): number {
  return input ? Math.round((1 - output / input) * 100) : 0
}

const NOTES: Record<string, (args: Record<string, string | number>) => string> = {
  already_optimized: () => 'already optimized',
  below_min_savings: args => `would save only ${args.saved} bytes, below the minimum; original kept`,
  nothing_to_remove: () => 'nothing to remove',
  unsupported_feature: args => `kept as is (${String(args.feature ?? 'unsupported feature').replaceAll('_', ' ')})`,
  optimization_failed: () => 'could not be optimized; original kept',
  webp_larger_than_source: () => 'WebP is larger than the original',
  webp_larger_than_png: () => 'WebP is larger than an optimized PNG',
}

export function describeNotes(notes: Note[] = []): string {
  return notes.map(note => NOTES[note.code]?.(note.args ?? {}) ?? note.code.replaceAll('_', ' ')).join('; ')
}
