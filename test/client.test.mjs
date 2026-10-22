import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Bitinz, BitinzError, sniffFormat } from '../dist/index.js'
import { bytes, KEY, startMockApi } from './mock-api.mjs'

const temp = () => mkdtemp(join(tmpdir(), 'bitinz-client-'))

test('a direct answer: uploads the bytes with the key, downloads the result without it', async t => {
  const api = await startMockApi()
  t.after(api.close)
  const dir = await temp(), path = join(dir, 'photo.png')
  await writeFile(path, bytes.png('x'.repeat(200)))
  const result = await new Bitinz({ apiKey: KEY, baseUrl: api.url }).compress(path, { level: 'best' })
  assert.equal(result.inputSize, 208)
  assert.equal(result.outputSize, 104)
  assert.equal(result.data.length, 104)
  assert.equal(result.format, 'png')
  assert.equal(result.filename, 'photo.png')
  assert.equal(result.compressionCount, 1)
  assert.equal(result.unchanged, false)
  const [upload, download] = api.state.requests
  assert.deepEqual(upload.query, { level: 'best', filename: 'photo.png' })
  assert.equal(upload.headers['content-type'], 'application/octet-stream')
  assert.match(upload.headers['user-agent'], /^bitinz-js\/\d+\.\d+\.\d+ node\//)
  assert.equal(upload.size, 208)
  assert.equal(download.path, `/api/v1/results/${result.id}/download`)
  assert.equal(download.headers.authorization, undefined, 'the key goes with uploads only')
})

test('a queued job is followed until done and never uploaded twice', async t => {
  const api = await startMockApi({ queued: 2 })
  t.after(api.close)
  const result = await new Bitinz({ apiKey: KEY, baseUrl: api.url }).compress(bytes.jpeg('y'.repeat(100)), { filename: 'a.jpg' })
  assert.equal(result.outputSize, 52)
  assert.deepEqual(api.state.requests.map(r => r.method + ' ' + r.path.replace(/job\w+/, 'ID')),
    ['POST /api/v1/shrink', 'GET /api/v1/results/ID', 'GET /api/v1/results/ID', 'GET /api/v1/results/ID', 'GET /api/v1/results/ID/download'])
})

test('a busy server is retried as asked; without retries the error surfaces', async t => {
  const api = await startMockApi({ busy: 2 })
  t.after(api.close)
  const result = await new Bitinz({ apiKey: KEY, baseUrl: api.url }).compress(bytes.png('z'.repeat(50)))
  assert.equal(result.outputSize, 29)
  assert.equal(api.state.requests.filter(r => r.method === 'POST').length, 3)
  api.state.busy = 1
  await assert.rejects(new Bitinz({ apiKey: KEY, baseUrl: api.url, retries: 0 }).compress(bytes.png('z')), { code: 'busy', status: 503 })
})

test('quota, key and format errors carry the API code; fatal ones are marked', async t => {
  const api = await startMockApi({ quota: 0 })
  t.after(api.close)
  const quota = await new Bitinz({ apiKey: KEY, baseUrl: api.url }).compress(bytes.png('a')).catch(e => e)
  assert.ok(quota instanceof BitinzError)
  assert.equal(quota.code, 'quota_exceeded')
  assert.equal(quota.status, 429)
  assert.ok(quota.fatal)
  assert.match(quota.message, /quota of 0 reached/)
  const key = await new Bitinz({ apiKey: 'bz_wrong', baseUrl: api.url }).compress(bytes.png('a')).catch(e => e)
  assert.equal(key.code, 'invalid_key')
  assert.ok(key.fatal)
  assert.throws(() => new Bitinz({ apiKey: '' }), { code: 'unauthorized' })
})

test('AVIF stays AVIF when WebP is requested, as on the website', async t => {
  const api = await startMockApi()
  t.after(api.close)
  const result = await new Bitinz({ apiKey: KEY, baseUrl: api.url }).compress(bytes.avif('q'.repeat(40)), { format: 'webp' })
  assert.equal(result.keptFormat, true)
  assert.equal(result.format, 'avif')
  assert.equal(api.state.requests[0].query.format, undefined)
  const png = await new Bitinz({ apiKey: KEY, baseUrl: api.url }).compress(bytes.png('q'.repeat(40)), { format: 'webp' })
  assert.equal(png.format, 'webp')
  assert.equal(png.keptFormat, false)
  assert.equal(api.state.requests.at(-2).query.format, 'webp')
})

test('a queued job that fails reports why; an unreachable server is a network error', async t => {
  const api = await startMockApi()
  t.after(api.close)
  await assert.rejects(new Bitinz({ apiKey: KEY, baseUrl: api.url }).compress(bytes.png('BROKEN')), { code: 'unsupported_image', message: /not supported/ })
  await assert.rejects(new Bitinz({ apiKey: KEY, baseUrl: 'http://127.0.0.1:9' }).compress(bytes.png('a')), { code: 'network' })
})

test('formats are recognised from their first bytes', () => {
  assert.equal(sniffFormat(bytes.png('')), 'png')
  assert.equal(sniffFormat(bytes.jpeg('')), 'jpeg')
  assert.equal(sniffFormat(bytes.webp('')), 'webp')
  assert.equal(sniffFormat(bytes.avif('')), 'avif')
  assert.equal(sniffFormat(Buffer.from('GIF89a')), undefined)
})
