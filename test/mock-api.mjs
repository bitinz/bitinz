// A stand-in for the Bitinz API with the same contract: raw image bodies,
// 201 with a download Location, 202 with polling, error bodies and headers.
import { createServer } from 'node:http'

export const KEY = 'bz_' + 'a'.repeat(48)

export const bytes = {
  png: payload => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(payload)]),
  jpeg: payload => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(payload)]),
  webp: payload => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(payload)]),
  avif: payload => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypavif'), Buffer.from(payload)]),
}

function sniff(body) {
  if (body[0] === 0x89 && body.subarray(1, 4).toString() === 'PNG') return 'png'
  if (body[0] === 0xff && body[1] === 0xd8) return 'jpeg'
  if (body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP') return 'webp'
  if (body.subarray(4, 8).toString() === 'ftyp') return 'avif'
}

/**
 * Behaviour per test: busy (503 answers before accepting), queued (polls
 * before done), quota (compressions allowed), and markers inside the image:
 * OPTIMIZED (no smaller version), BIGWEBP (a WebP larger than the source),
 * BROKEN (a queued job that fails as unsupported).
 */
export async function startMockApi(scenario = {}) {
  const state = { requests: [], jobs: new Map(), count: 0, busy: scenario.busy ?? 0 }
  const error = (res, status, code, message, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify({ error: { code, message } }))
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, size: body.length })
    const origin = `http://${req.headers.host}`

    if (req.method === 'POST' && url.pathname === '/api/v1/shrink') {
      const auth = req.headers.authorization
      if (!auth) return error(res, 401, 'unauthorized', 'missing API key', { 'www-authenticate': 'Basic realm="bitinz"' })
      if (auth !== `Bearer ${KEY}`) return error(res, 401, 'invalid_key', 'invalid API key')
      if (scenario.quota !== undefined && state.count >= scenario.quota) {
        return error(res, 429, 'quota_exceeded', `monthly compression quota of ${scenario.quota} reached`, { 'compression-count': String(state.count) })
      }
      const format = url.searchParams.get('format') ?? 'same'
      if (!['same', 'webp'].includes(format)) return error(res, 400, 'bad_request', 'format must be same or webp')
      if (state.busy > 0) { state.busy--; return error(res, 503, 'busy', 'busy, try again shortly', { 'retry-after': '0' }) }
      const input = sniff(body)
      if (!input) return error(res, 415, 'unsupported_image', 'not a supported PNG, JPEG, WebP or AVIF image')
      if (format === 'webp' && input === 'avif') return error(res, 415, 'unsupported_image', 'not a supported PNG, JPEG, WebP or AVIF image')
      state.count++
      const text = body.toString('latin1')
      const webp = format === 'webp' && input !== 'webp'
      let output, unchanged = false, notes
      if (text.includes('OPTIMIZED') && !webp) { output = body; unchanged = true; notes = [{ code: 'already_optimized' }] }
      else if (webp) output = bytes.webp(text.includes('BIGWEBP') ? body.toString('latin1').repeat(3) : 'w'.repeat(Math.max(1, Math.floor(body.length / 3))))
      else output = body.subarray(0, Math.max(12, Math.floor(body.length / 2)))
      const name = (url.searchParams.get('filename') ?? 'image')
      const id = 'job' + state.count + 'a'.repeat(29 - String(state.count).length)
      const job = {
        id, filename: webp ? name.replace(/\.[^.]+$/, '') + '.webp' : name, output, input: body.length, unchanged, notes,
        format: webp ? 'webp' : input, polls: 0, failed: text.includes('BROKEN'),
      }
      state.jobs.set(id, job)
      const headers = { 'content-type': 'application/json', 'compression-count': String(state.count) }
      if (scenario.queued || job.failed) {
        res.writeHead(202, { ...headers, location: `${origin}/api/v1/results/${id}` })
        return res.end(JSON.stringify({ id, status: 'pending', filename: job.filename, input: { size: body.length } }))
      }
      res.writeHead(201, { ...headers, location: `${origin}/api/v1/results/${id}/download` })
      return res.end(JSON.stringify({
        id, status: 'done', filename: job.filename, unchanged,
        input: { size: body.length, format: input },
        output: { size: output.length, type: `image/${job.format}`, format: job.format, ratio: output.length / body.length, url: `${origin}/api/v1/results/${id}/download`, notes },
      }))
    }
    const match = url.pathname.match(/^\/api\/v1\/results\/([a-z0-9]+)(\/download)?$/)
    const job = match && state.jobs.get(match[1])
    if (req.method === 'GET' && job && !match[2]) {
      job.polls++
      const pending = job.polls <= (scenario.queued ?? 1)
      const status = pending ? 'pending' : job.failed ? 'failed' : 'done'
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        id: job.id, filename: job.filename, format: job.format, status, inputSize: job.input,
        outputSize: status === 'done' ? job.output.length : 0, ratio: job.output.length / job.input, unchanged: job.unchanged,
        notes: job.notes, available: status === 'done', ...status === 'done' && { downloadUrl: `/api/v1/results/${job.id}/download` },
        ...status === 'failed' && { failure: 'unsupported', note: 'this image uses a feature that is not supported' },
        ...pending && { queuePosition: 1 },
      }))
    }
    if (req.method === 'GET' && job && match[2]) {
      res.writeHead(200, { 'content-type': `image/${job.format}`, 'content-length': job.output.length })
      return res.end(job.output)
    }
    error(res, 404, 'not_found', 'not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, state, close: () => new Promise(resolve => server.close(resolve)) }
}
