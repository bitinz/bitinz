import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { bytes, KEY, startMockApi } from './mock-api.mjs'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

async function connect(t, env, versionNegotiation) {
  const client = new Client({ name: 'bitinz-test', version: '1.0.0' }, versionNegotiation ? { versionNegotiation } : {})
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { PATH: process.env.PATH, ...env }, stderr: 'pipe' })
  await client.connect(transport)
  t.after(() => client.close())
  return client
}

for (const [era, negotiation] of [['2025-era clients', undefined], ['2026-07-28 clients', { mode: { pin: '2026-07-28' } }]]) {
  test(`MCP for ${era}: lists compress_images and compresses a folder into bitinz-compressed`, async t => {
    const api = await startMockApi()
    t.after(api.close)
    const root = await mkdtemp(join(tmpdir(), 'bitinz-mcp-'))
    await mkdir(join(root, 'public'))
    await writeFile(join(root, 'public/a.png'), bytes.png('a'.repeat(120)))
    await writeFile(join(root, 'public/b.jpg'), bytes.jpeg('b'.repeat(80)))
    const client = await connect(t, { BITINZ_API_KEY: KEY, BITINZ_BASE_URL: api.url, XDG_CONFIG_HOME: root }, negotiation)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(tool => tool.name), ['compress_images'])
    assert.ok(tools[0].inputSchema.properties.paths && tools[0].outputSchema)

    const result = await client.callTool({ name: 'compress_images', arguments: { paths: [join(root, 'public')], level: 'best' } })
    assert.ok(!result.isError, JSON.stringify(result.content))
    assert.match(result.content[0].text, /2 compressed\. .*Results are in .*bitinz-compressed/s)
    assert.equal(result.structuredContent.files.length, 2)
    assert.equal(result.structuredContent.compressionCount, 2)
    assert.deepEqual((await readdir(join(root, 'public/bitinz-compressed'))).sort(), ['a.png', 'b.jpg'])
    assert.ok(api.state.requests.filter(r => r.method === 'POST').every(r => r.query.level === 'best'))
  })
}

test('MCP explains a missing key, relative paths and oversized batches instead of failing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bitinz-mcp-'))
  await writeFile(join(root, 'a.png'), bytes.png('a'))
  await writeFile(join(root, 'b.png'), bytes.png('b'))
  const nokey = await connect(t, { XDG_CONFIG_HOME: root, HOME: root })
  const missing = await nokey.callTool({ name: 'compress_images', arguments: { paths: [root] } })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /BITINZ_API_KEY/)
  const relative = await nokey.callTool({ name: 'compress_images', arguments: { paths: ['images'] } })
  assert.match(relative.content[0].text, /Use absolute paths/)

  const api = await startMockApi({ quota: 0 })
  t.after(api.close)
  const client = await connect(t, { BITINZ_API_KEY: KEY, BITINZ_BASE_URL: api.url, XDG_CONFIG_HOME: root })
  const limited = await client.callTool({ name: 'compress_images', arguments: { paths: [root], max_files: 1 } })
  assert.match(limited.content[0].text, /Found 2 images, more than max_files \(1\)/)
  assert.equal(api.state.requests.length, 0)
  const quota = await client.callTool({ name: 'compress_images', arguments: { paths: [root], in_place: true } })
  assert.equal(quota.isError, true)
  assert.match(quota.content[0].text, /Stopped early: monthly compression quota of 0 reached/)
})
