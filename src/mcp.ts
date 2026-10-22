import { isAbsolute, join, dirname } from 'node:path'
import { stat } from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { compressFiles, type FileReport } from './batch.js'
import { Bitinz, VERSION } from './client.js'
import { resolveSettings } from './config.js'
import { collectImages, OUTPUT_DIR } from './files.js'
import { describeNotes, formatBytes, savedPercent } from './format.js'

const KEYS_URL = 'https://bitinz.com/dashboard?tab=keys'
const SETUP = `No Bitinz API key is configured. Create one at ${KEYS_URL} and give it to this MCP server as the BITINZ_API_KEY environment variable (or run "npx bitinz login" once).`

const input = z.object({
  paths: z.array(z.string()).min(1).describe('Absolute paths of PNG, JPG, WebP or AVIF files, or of folders to search for them.'),
  level: z.enum(['fast', 'default', 'best']).optional().describe('fast, default (balanced) or best (smallest files, a little slower). Omit for the account default.'),
  format: z.enum(['same', 'webp']).optional().describe('same keeps each format (default); webp converts JPG and PNG to WebP, written as new .webp files. AVIF always stays AVIF.'),
  in_place: z.boolean().optional().describe('Replace the original files (default false). WebP results are written next to the originals.'),
  output_dir: z.string().optional().describe(`Absolute folder for the results when not in place. Defaults to a ${OUTPUT_DIR} folder next to the first path.`),
  recursive: z.boolean().optional().describe('Search subfolders (default true). node_modules, .git and hidden folders are skipped.'),
  max_files: z.number().int().min(1).max(1000).optional().describe('Refuse to start when more images are found (default 100). Each image uses one compression of the monthly API quota.'),
})

const fileSchema = z.object({
  path: z.string(),
  output: z.string().optional(),
  status: z.enum(['compressed', 'unchanged', 'larger', 'failed', 'skipped', 'planned']),
  inputSize: z.number(),
  outputSize: z.number().optional(),
  savedPercent: z.number().optional(),
  note: z.string().optional(),
  error: z.string().optional(),
})
const output = z.object({
  files: z.array(fileSchema),
  inputBytes: z.number(),
  outputBytes: z.number(),
  compressionCount: z.number().optional(),
  stopped: z.string().optional(),
})

function fail(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] }
}

function summarize(file: FileReport): z.infer<typeof fileSchema> {
  const note = [describeNotes(file.notes), file.keptFormat ? 'AVIF kept as AVIF' : ''].filter(Boolean).join('; ')
  return {
    path: file.path, output: file.output, status: file.status, inputSize: file.inputSize, outputSize: file.outputSize,
    savedPercent: file.outputSize === undefined ? undefined : savedPercent(file.inputSize, file.outputSize),
    note: note || undefined, error: file.error?.message,
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'bitinz', version: VERSION })
  server.registerTool('compress_images', {
    title: 'Compress images with Bitinz',
    description: 'Compress PNG, JPG, WebP and AVIF images with the Bitinz API, keeping their format or converting JPG and PNG to WebP. ' +
      'Results go to a new folder unless in_place is true. Each image uses one compression of the monthly API quota.',
    inputSchema: input,
    outputSchema: output,
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async args => {
    const relativePaths = [...args.paths, ...args.output_dir ? [args.output_dir] : []].filter(path => !isAbsolute(path))
    if (relativePaths.length) return fail(`Use absolute paths; these are relative: ${relativePaths.join(', ')}`)
    const settings = await resolveSettings()
    if (!settings.apiKey) return fail(SETUP)

    const { files, skipped } = await collectImages(args.paths, { recursive: args.recursive ?? true })
    if (!files.length) return fail(`No PNG, JPG, WebP or AVIF images found${skipped.length ? ` (${skipped.map(s => `${s.path}: ${s.reason}`).join('; ')})` : ''}.`)
    const limit = args.max_files ?? 100
    if (files.length > limit) return fail(`Found ${files.length} images, more than max_files (${limit}). Each uses one compression of the monthly quota; narrow the paths or raise max_files.`)

    const first = args.paths[0]
    const outDir = args.output_dir ?? join((await stat(first)).isDirectory() ? first : dirname(first), OUTPUT_DIR)
    const client = new Bitinz({ apiKey: settings.apiKey, baseUrl: settings.baseUrl })
    const report = await compressFiles(client, files, {
      level: args.level, webp: args.format === 'webp', inPlace: args.in_place, outDir,
    })

    const structured = {
      files: report.files.map(summarize), inputBytes: report.inputBytes, outputBytes: report.outputBytes,
      compressionCount: report.compressionCount, stopped: report.stopped?.message,
    }
    const counts = Object.entries(Object.groupBy(report.files, file => file.status)).map(([status, list]) => `${list!.length} ${status}`).join(', ')
    const lines = [
      `${counts}. ${formatBytes(report.inputBytes)} → ${formatBytes(report.outputBytes)} (${savedPercent(report.inputBytes, report.outputBytes)}% smaller).`,
      args.in_place ? 'Originals were replaced where smaller.' : `Results are in ${outDir}.`,
      ...report.compressionCount !== undefined ? [`API compressions used this month: ${report.compressionCount}.`] : [],
      ...report.stopped ? [`Stopped early: ${report.stopped.message}`] : [],
      ...report.files.filter(file => file.status === 'failed').slice(0, 20).map(file => `Failed: ${file.path}: ${file.error?.message}`),
      ...skipped.map(s => `Skipped: ${s.path}: ${s.reason}`),
    ]
    return { content: [{ type: 'text' as const, text: lines.join('\n') }], structuredContent: structured, isError: !!report.stopped }
  })
  return server
}

/** Serves the tools over standard input and output until the client disconnects. */
export async function serve(): Promise<void> {
  serveStdio(createServer, { onerror: error => console.error('bitinz mcp:', error) })
}
