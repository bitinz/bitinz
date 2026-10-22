import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { VERSION } from './version.js'

export { VERSION }

export type Level = 'fast' | 'default' | 'best'
export type OutputFormat = 'same' | 'webp'
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif'

/** A machine-readable remark about a result, e.g. `already_optimized`. */
export interface Note {
  code: string
  args?: Record<string, string | number>
}

export interface CompressOptions {
  /** fast, default (balanced) or best. The account's default applies when omitted. */
  level?: Level
  /** Keep the format (`same`, the default) or convert JPG and PNG to `webp`. */
  format?: OutputFormat
  /** The name the result is stored under; defaults to the file name of a path input. */
  filename?: string
  signal?: AbortSignal
}

export interface CompressResult {
  id: string
  /** The result's file name, with a .webp extension after a conversion. */
  filename: string
  data: Uint8Array
  inputSize: number
  outputSize: number
  /** outputSize / inputSize. */
  ratio: number
  format: ImageFormat
  /** The original bytes came back: the image could not be made smaller in its format. */
  unchanged: boolean
  notes: Note[]
  /** WebP was requested for an AVIF image, which is compressed in its own format instead. */
  keptFormat: boolean
  /** API compressions of this account in the current calendar month (UTC), when reported. */
  compressionCount?: number
  expiresAt?: string
}

export interface ClientOptions {
  apiKey: string
  baseUrl?: string
  /** How often a busy server is retried before giving up (default 3). */
  retries?: number
  /** How long a queued job is followed before giving up, in milliseconds (default 10 minutes). */
  pollTimeout?: number
  fetch?: typeof fetch
}

/** An error reported by the API, or a failure to reach it. */
export class BitinzError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfter?: number

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message)
    this.name = 'BitinzError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }

  /** Errors that end a batch: every following request would fail the same way. */
  get fatal(): boolean {
    return ['unauthorized', 'invalid_key', 'email_not_verified', 'quota_exceeded'].includes(this.code)
  }
}

export const DEFAULT_BASE_URL = 'https://bitinz.com'

type Input = string | Uint8Array | Blob

interface ShrinkView {
  id: string
  status: string
  filename: string
  expiresAt?: string
  input: { size: number }
  output?: { size: number; type?: string; format?: ImageFormat; ratio: number; url: string; notes?: Note[] }
  unchanged?: boolean
}

interface ResultView {
  id: string
  filename: string
  format: ImageFormat
  status: 'pending' | 'processing' | 'done' | 'failed'
  inputSize: number
  outputSize: number
  ratio: number
  unchanged: boolean
  note?: string
  notes?: Note[]
  failure?: string
  expiresAt?: string
  available?: boolean
  downloadUrl?: string
}

// Queued jobs that fail report a category; give it the code a direct answer would carry.
const FAILURE_CODES: Record<string, string> = {
  unsupported: 'unsupported_image', invalid: 'invalid_image', too_large: 'image_too_large', abandoned: 'busy',
}

/** Detects PNG, JPEG, WebP and AVIF from the first bytes of a file. */
export function sniffFormat(head: Uint8Array): ImageFormat | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to))
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (head.length >= 12 && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'avif'
  return undefined
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000)
}

async function errorFrom(response: Response): Promise<BitinzError> {
  let code = response.status >= 500 ? 'internal' : 'bad_request', message = `HTTP ${response.status}`
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } }
    if (body.error?.code) code = body.error.code
    if (body.error?.message) message = body.error.message
  } catch { /* Not a JSON error body. */ }
  return new BitinzError(response.status, code, message, parseRetryAfter(response.headers.get('retry-after')))
}

/**
 * A client of the Bitinz image compression API.
 *
 * ```ts
 * const bitinz = new Bitinz({ apiKey: process.env.BITINZ_API_KEY! })
 * const result = await bitinz.compress('photo.jpg', { level: 'best' })
 * ```
 */
export class Bitinz {
  readonly baseUrl: string
  readonly #apiKey: string
  readonly #retries: number
  readonly #pollTimeout: number
  readonly #fetch: typeof fetch

  constructor(options: ClientOptions) {
    if (!options?.apiKey) throw new BitinzError(0, 'unauthorized', 'An API key is required')
    this.#apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#retries = options.retries ?? 3
    this.#pollTimeout = options.pollTimeout ?? 10 * 60_000
    this.#fetch = options.fetch ?? fetch
  }

  /** Compresses one image: a file path, bytes or a Blob. */
  async compress(input: Input, options: CompressOptions = {}): Promise<CompressResult> {
    const body = typeof input === 'string' ? await openAsBlob(input) : input instanceof Blob ? input : new Blob([input as Uint8Array<ArrayBuffer>])
    const filename = options.filename ?? (typeof input === 'string' ? basename(input) : undefined)
    // AVIF cannot become WebP; it is compressed in its own format, as on the website.
    let format = options.format ?? 'same', keptFormat = false
    if (format === 'webp' && sniffFormat(new Uint8Array(await body.slice(0, 16).arrayBuffer())) === 'avif') {
      format = 'same'
      keptFormat = true
    }
    const url = new URL('/api/v1/shrink', this.baseUrl)
    if (options.level) url.searchParams.set('level', options.level)
    if (format !== 'same') url.searchParams.set('format', format)
    if (filename) url.searchParams.set('filename', filename)

    const response = await this.#submit(url, body, options.signal)
    const count = Number(response.headers.get('compression-count'))
    const compressionCount = Number.isInteger(count) && response.headers.has('compression-count') ? count : undefined
    const view = await response.json() as ShrinkView
    if (response.status === 201 && view.output) {
      const location = response.headers.get('location') ?? view.output.url
      return {
        id: view.id, filename: view.filename, data: await this.#download(location, options.signal),
        inputSize: view.input.size, outputSize: view.output.size, ratio: view.output.ratio,
        format: view.output.format ?? (view.output.type?.replace('image/', '') as ImageFormat),
        unchanged: !!view.unchanged, notes: view.output.notes ?? [], keptFormat, compressionCount, expiresAt: view.expiresAt,
      }
    }
    // 202: the job waits in the queue. Follow it; never upload the image again.
    const done = await this.#follow(view.id, options.signal)
    return {
      id: done.id, filename: done.filename, data: await this.#download(done.downloadUrl!, options.signal),
      inputSize: done.inputSize, outputSize: done.outputSize, ratio: done.ratio, format: done.format,
      unchanged: done.unchanged, notes: done.notes ?? [], keptFormat, compressionCount, expiresAt: done.expiresAt,
    }
  }

  // Results and downloads need no key; it goes with uploads only.
  readonly #agent = { 'user-agent': `bitinz-js/${VERSION} node/${process.versions.node}` }

  async #request(url: string | URL, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init)
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
      throw new BitinzError(0, 'network', `Could not reach ${this.baseUrl}: ${(error as Error).message}`)
    }
  }

  async #submit(url: URL, body: Blob, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#request(url, {
        method: 'POST', body, signal,
        headers: { ...this.#agent, authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/octet-stream' },
      })
      if (response.status === 201 || response.status === 202) return response
      const error = await errorFrom(response)
      // A busy server has not accepted the image, so it is safe to send it again.
      if (error.code !== 'busy' || attempt >= this.#retries) throw error
      await sleep(Math.min(error.retryAfter ?? 30, 60) * 1000, undefined, { signal })
    }
  }

  async #follow(id: string, signal?: AbortSignal): Promise<ResultView> {
    const started = Date.now()
    const url = new URL(`/api/v1/results/${encodeURIComponent(id)}`, this.baseUrl)
    for (let polls = 0; ; polls++) {
      // Every second for the first ten seconds, then every two.
      await sleep(polls < 10 ? 1000 : 2000, undefined, { signal })
      const response = await this.#request(url, { headers: this.#agent, signal }).catch(error => {
        if (error instanceof BitinzError) return undefined
        throw error
      })
      if (response?.ok) {
        const view = await response.json() as ResultView
        if (view.status === 'done' && view.downloadUrl) return view
        if (view.status === 'done') throw new BitinzError(410, 'expired', 'The result is no longer available')
        if (view.status === 'failed') {
          throw new BitinzError(422, FAILURE_CODES[view.failure ?? ''] ?? 'internal', view.note ?? 'The image could not be compressed')
        }
      } else if (response && response.status < 500 && response.status !== 429) {
        throw await errorFrom(response)
      } else if (response) {
        // A busy server or a rate limit: wait as asked, then poll again.
        const { retryAfter } = await errorFrom(response)
        if (retryAfter) await sleep(Math.min(retryAfter, 60) * 1000, undefined, { signal })
      }
      if (Date.now() - started > this.#pollTimeout) {
        throw new BitinzError(504, 'timeout', `The image is still queued after ${Math.round(this.#pollTimeout / 60000)} minutes`)
      }
    }
  }

  async #download(location: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.#request(new URL(location, this.baseUrl), { headers: this.#agent, signal })
    if (!response.ok) throw await errorFrom(response)
    return new Uint8Array(await response.arrayBuffer())
  }
}
