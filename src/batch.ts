import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Bitinz, BitinzError, type Level, type Note } from './client.js'
import { planOutputs, type ImageFile } from './files.js'

export type FileStatus = 'compressed' | 'unchanged' | 'larger' | 'failed' | 'skipped' | 'planned'

export interface FileReport {
  path: string
  output?: string
  status: FileStatus
  inputSize: number
  outputSize?: number
  notes?: Note[]
  /** AVIF stays AVIF when WebP is requested. */
  keptFormat?: boolean
  error?: { code: string; message: string }
}

export interface BatchOptions {
  level?: Level
  webp?: boolean
  outDir?: string
  inPlace?: boolean
  /** Parallel uploads, 1 to 8 (default 3). */
  concurrency?: number
  /** List what would be sent without calling the API. */
  dryRun?: boolean
  /** Write a WebP even when it is larger than the original (default false). */
  keepLarger?: boolean
  /** Treat results that save less than this percentage as unchanged (default 0). */
  minSavings?: number
  signal?: AbortSignal
  onFile?: (report: FileReport) => void
}

export interface BatchReport {
  files: FileReport[]
  inputBytes: number
  outputBytes: number
  /** Compressions used this month, from the last response that reported it. */
  compressionCount?: number
  /** Why the batch stopped early, e.g. an invalid key or a used-up quota. */
  stopped?: { code: string; message: string }
}

// Write next to the target and rename, so an interrupted run never leaves half an image.
async function writeAtomic(path: string, data: Uint8Array) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, data)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Compresses a list of images with a few uploads at a time and writes the results. */
export async function compressFiles(client: Bitinz | undefined, files: ImageFile[], options: BatchOptions = {}): Promise<BatchReport> {
  const outputs = planOutputs(files, options)
  const reports: FileReport[] = new Array(files.length)
  const report: BatchReport = { files: reports, inputBytes: 0, outputBytes: 0 }
  const concurrency = Math.min(8, Math.max(1, Math.floor(options.concurrency ?? 3)))
  const stop = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal
  let next = 0

  const one = async (index: number) => {
    const file = files[index], output = outputs.get(file.path)!
    const inputSize = (await stat(file.path)).size
    const done = (entry: FileReport) => {
      reports[index] = entry
      options.onFile?.(entry)
    }
    if (report.stopped) return done({ path: file.path, output, status: 'skipped', inputSize, error: report.stopped })
    if (options.dryRun || !client) return done({ path: file.path, output, status: 'planned', inputSize })
    try {
      const result = await client.compress(file.path, { level: options.level, format: options.webp ? 'webp' : 'same', signal })
      if (result.compressionCount !== undefined) report.compressionCount = Math.max(report.compressionCount ?? 0, result.compressionCount)
      const larger = result.outputSize >= result.inputSize && !result.unchanged
      // A same-format result that saves too little is not worth replacing the original for.
      const slight = !larger && !result.unchanged && !options.webp && (1 - result.outputSize / result.inputSize) * 100 < (options.minSavings ?? 0)
      const entry: FileReport = {
        path: file.path, output, inputSize: result.inputSize, outputSize: slight ? result.inputSize : result.outputSize,
        notes: slight ? [...result.notes, { code: 'below_min_savings', args: { saved: result.inputSize - result.outputSize } }] : result.notes,
        keptFormat: result.keptFormat, status: result.unchanged || slight ? 'unchanged' : larger ? 'larger' : 'compressed',
      }
      // In place, an unchanged image is left alone; a larger WebP is not written unless asked.
      const skipWrite = (entry.status === 'unchanged' && output === file.path) || (entry.status === 'larger' && !options.keepLarger)
      if (skipWrite) entry.output = output === file.path ? file.path : undefined
      else if (slight) await mkdir(dirname(output), { recursive: true }).then(() => copyFile(file.path, output))
      else await writeAtomic(output, result.data)
      report.inputBytes += entry.inputSize
      // A WebP that is not kept leaves the original as the file in use.
      report.outputBytes += entry.status === 'larger' && !options.keepLarger ? entry.inputSize : entry.outputSize!
      done(entry)
    } catch (error) {
      if ((error as Error).name === 'AbortError' && report.stopped) return done({ path: file.path, output, status: 'skipped', inputSize, error: report.stopped })
      if ((error as Error).name === 'AbortError') throw error
      const { code, message } = error instanceof BitinzError ? error : { code: 'write_failed', message: (error as Error).message }
      if (error instanceof BitinzError && error.fatal && !report.stopped) {
        report.stopped = { code, message }
        stop.abort()
      }
      done({ path: file.path, output, status: 'failed', inputSize, error: { code, message } })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (next < files.length) await one(next++)
  }))
  return report
}
