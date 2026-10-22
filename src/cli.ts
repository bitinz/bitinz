#!/usr/bin/env node
import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import { compressFiles, type FileReport } from './batch.js'
import { Bitinz, BitinzError, VERSION, type Level } from './client.js'
import { configPath, forgetApiKey, KEY_PATTERN, resolveSettings, saveApiKey } from './config.js'
import { collectImages, OUTPUT_DIR } from './files.js'
import { describeNotes, formatBytes, savedPercent } from './format.js'

const KEYS_URL = 'https://bitinz.com/dashboard?tab=keys'

const HELP = `bitinz ${VERSION}: compress JPG, PNG and WebP images with the Bitinz API

Usage
  bitinz compress <files or folders...> [options]
  bitinz login        save an API key for later runs
  bitinz logout       forget the saved key
  bitinz mcp          run the MCP server for AI agents (stdio)

Compress options
  -l, --level <level>     fast, default or best (default: your account's default)
      --webp              convert JPG and PNG to WebP (written as new .webp files)
  -o, --out-dir <dir>     where results go (default: ./${OUTPUT_DIR})
      --in-place          replace the original files instead
      --no-recursive      do not look inside subfolders
  -c, --concurrency <n>   parallel uploads, 1 to 8 (default: 3)
      --dry-run           list the images without uploading them
      --keep-larger       also write WebP files that are larger than the original
      --min-savings <n>   keep the original when a result saves less than n percent
      --json              print a JSON report
      --api-key <key>     API key (default: $BITINZ_API_KEY, then the saved key)

Get an API key at ${KEYS_URL}
Every image sent counts towards your account's monthly API quota.`

const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: number, text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text
const green = (text: string) => paint(32, text), yellow = (text: string) => paint(33, text)
const red = (text: string) => paint(31, text), dim = (text: string) => paint(2, text)

class UsageError extends Error {}

function show(path: string) {
  const local = relative(process.cwd(), path)
  return local && !local.startsWith('..') ? local : path
}

function line(file: FileReport): string {
  const name = show(file.path)
  const sizes = file.outputSize !== undefined ? `${formatBytes(file.inputSize)} → ${formatBytes(file.outputSize)}` : formatBytes(file.inputSize)
  const notes = describeNotes(file.notes) + (file.keptFormat ? `${file.notes?.length ? '; ' : ''}AVIF kept as AVIF` : '')
  switch (file.status) {
    case 'compressed': return `${green('✓')} ${name}  ${sizes}  ${green(`−${savedPercent(file.inputSize, file.outputSize!)}%`)}${notes ? dim(`  ${notes}`) : ''}`
    case 'unchanged': return `${dim('=')} ${name}  ${formatBytes(file.inputSize)}  ${dim(notes || 'already optimized')}`
    case 'larger': return `${yellow('!')} ${name}  ${sizes}  ${yellow(`+${-savedPercent(file.inputSize, file.outputSize!)}%`)}  ${dim(file.output ? 'written anyway' : 'not written; the original is smaller')}`
    case 'planned': return `${dim('·')} ${name}  ${formatBytes(file.inputSize)}  ${dim(`→ ${show(file.output!)}`)}`
    case 'skipped': return `${dim('-')} ${name}  ${dim(`skipped: ${file.error?.message ?? ''}`)}`
    default: return `${red('✗')} ${name}  ${red(file.error?.message ?? 'failed')}`
  }
}

async function compress(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      level: { type: 'string', short: 'l' }, webp: { type: 'boolean' },
      'out-dir': { type: 'string', short: 'o' }, 'in-place': { type: 'boolean' }, 'no-recursive': { type: 'boolean' },
      concurrency: { type: 'string', short: 'c' }, 'dry-run': { type: 'boolean' }, 'keep-larger': { type: 'boolean' }, 'min-savings': { type: 'string' },
      json: { type: 'boolean' }, 'api-key': { type: 'string' }, 'base-url': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) { console.log(HELP); return 0 }
  if (!positionals.length) throw new UsageError('Name the images or folders to compress, e.g. bitinz compress images/')
  if (values.level && !['fast', 'default', 'best'].includes(values.level)) throw new UsageError('--level must be fast, default or best')
  if (values['in-place'] && values['out-dir']) throw new UsageError('Use either --in-place or --out-dir, not both')
  const concurrency = values.concurrency === undefined ? 3 : Number(values.concurrency)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new UsageError('--concurrency must be a whole number from 1 to 8')

  const minSavings = values['min-savings'] === undefined ? 0 : Number(values['min-savings'])
  if (!Number.isFinite(minSavings) || minSavings < 0 || minSavings >= 100) throw new UsageError('--min-savings must be a percentage from 0 to 99')

  const { files, skipped } = await collectImages(positionals, { recursive: !values['no-recursive'] })
  for (const { path, reason } of skipped) console.error(`${yellow('!')} ${show(path)}: ${reason}`)
  if (!files.length) {
    console.error('No PNG, JPG, WebP or AVIF images found.')
    return 1
  }
  const settings = await resolveSettings({ apiKey: values['api-key'], baseUrl: values['base-url'] })
  if (!values['dry-run'] && !settings.apiKey) {
    throw new UsageError(`No API key. Run "bitinz login", set BITINZ_API_KEY or pass --api-key.\nGet a key at ${KEYS_URL}`)
  }
  const client = values['dry-run'] ? undefined : new Bitinz({ apiKey: settings.apiKey!, baseUrl: settings.baseUrl })
  const json = values.json
  if (!json && !values['dry-run']) console.error(dim(`Compressing ${files.length} image${files.length === 1 ? '' : 's'}…`))

  const abort = new AbortController()
  process.once('SIGINT', () => abort.abort())
  const report = await compressFiles(client, files, {
    level: values.level as Level | undefined, webp: values.webp, inPlace: values['in-place'], outDir: values['out-dir'],
    concurrency, dryRun: values['dry-run'], keepLarger: values['keep-larger'], minSavings, signal: abort.signal,
    onFile: json ? undefined : file => console.log(line(file)),
  })

  const failed = report.files.filter(file => file.status === 'failed').length
  if (json) {
    console.log(JSON.stringify({ ...report, skippedPaths: skipped }, null, 2))
  } else if (values['dry-run']) {
    const total = report.files.reduce((sum, file) => sum + file.inputSize, 0)
    console.log(`\n${files.length} image${files.length === 1 ? '' : 's'}, ${formatBytes(total)}. Nothing was uploaded (dry run).`)
  } else {
    const done = report.files.filter(file => file.status !== 'failed' && file.status !== 'skipped').length
    const saved = report.inputBytes - report.outputBytes
    console.log(`\n${done} of ${files.length} done: ${formatBytes(report.inputBytes)} → ${formatBytes(report.outputBytes)}, ` +
      `saved ${formatBytes(Math.max(0, saved))} (${savedPercent(report.inputBytes, report.outputBytes)}%)`)
    if (!values['in-place'] && done) console.log(dim(`Results in ${show(values['out-dir'] ?? OUTPUT_DIR)}`))
    if (report.compressionCount !== undefined) console.log(dim(`API compressions this month: ${report.compressionCount}`))
    if (report.stopped) console.error(red(`Stopped: ${report.stopped.message}`))
  }
  return report.stopped ? 3 : failed ? 1 : 0
}

// Reads a key without echoing it on a terminal, or from a pipe.
async function readKey(): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    let text = ''
    for await (const chunk of stdin) text += chunk
    return text.trim()
  }
  process.stderr.write(`Paste your API key from ${KEYS_URL}\nAPI key: `)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let key = ''
    const finish = (error?: Error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stderr.write('\n')
      if (error) reject(error)
      else resolve(key.trim())
    }
    const onData = (data: string) => {
      for (const char of data) {
        if (char === '\r' || char === '\n') return finish()
        if (char === '\u0003') return finish(new UsageError('Cancelled'))
        if (char === '\u007f' || char === '\b') key = key.slice(0, -1)
        else if (char >= ' ') key += char
      }
    }
    stdin.on('data', onData)
  })
}

async function login(): Promise<number> {
  const key = await readKey()
  if (!KEY_PATTERN.test(key)) throw new UsageError(`That does not look like a Bitinz API key (bz_…). Create one at ${KEYS_URL}`)
  await saveApiKey(key)
  console.log(`Saved to ${configPath()} (readable by you only).`)
  return 0
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'compress': return compress(rest)
    case 'login': return login()
    case 'logout':
      console.log(await forgetApiKey() ? 'The saved API key was removed.' : 'No saved API key.')
      return 0
    case 'mcp':
      await (await import('./mcp.js')).serve()
      return -1
    case '-v': case '--version': case 'version':
      console.log(VERSION)
      return 0
    case undefined: case '-h': case '--help': case 'help':
      console.log(HELP)
      return 0
    default:
      throw new UsageError(`Unknown command "${command}". Run "bitinz --help".`)
  }
}

main(process.argv.slice(2)).then(code => {
  // The MCP server keeps running until its client closes standard input.
  if (code >= 0) process.exitCode = code
}, error => {
  if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
    console.error(red(error.message))
    process.exitCode = 2
  } else if (error instanceof BitinzError) {
    console.error(red(error.message))
    process.exitCode = error.fatal ? 3 : 1
  } else if ((error as Error).name === 'AbortError') {
    console.error('Cancelled.')
    process.exitCode = 130
  } else {
    console.error(error)
    process.exitCode = 1
  }
})
