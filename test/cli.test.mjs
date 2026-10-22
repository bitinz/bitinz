import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { bytes, KEY, startMockApi } from './mock-api.mjs'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
// Output names paths the platform's way; compare them with forward slashes.
const slashes = text => text.replaceAll('\\', '/')
const tree = async dir => (await readdir(dir, { recursive: true })).map(slashes).sort()

function run(args, { cwd, env = {}, input } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH, NO_COLOR: '1', ...env } })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => stdout += d)
    child.stderr.on('data', d => stderr += d)
    child.on('close', code => resolve({ code, stdout: slashes(stdout), stderr: slashes(stderr) }))
    child.stdin.end(input)
  })
}

// A small site: a nested folder, an already optimized image, a non-image and node_modules.
async function site() {
  const root = await mkdtemp(join(tmpdir(), 'bitinz-cli-'))
  await mkdir(join(root, 'images/icons'), { recursive: true })
  await mkdir(join(root, 'images/node_modules'), { recursive: true })
  await writeFile(join(root, 'images/hero.jpg'), bytes.jpeg('h'.repeat(300)))
  await writeFile(join(root, 'images/icons/logo.png'), bytes.png('l'.repeat(100)))
  await writeFile(join(root, 'images/icons/done.png'), bytes.png('OPTIMIZED' + 'd'.repeat(60)))
  await writeFile(join(root, 'images/readme.txt'), 'not an image')
  await writeFile(join(root, 'images/node_modules/dep.png'), bytes.png('n'))
  return root
}

test('compress writes results to ./bitinz-compressed, keeps the folders and leaves originals alone', async t => {
  const api = await startMockApi()
  t.after(api.close)
  const root = await site()
  const { code, stdout } = await run(['compress', 'images', '--base-url', api.url, '--api-key', KEY], { cwd: root })
  assert.equal(code, 0, stdout)
  assert.match(stdout, /✓ images\/hero\.jpg {2}304 B → 152 B {2}−50%/)
  assert.match(stdout, /= images\/icons\/done\.png .*already optimized/)
  assert.match(stdout, /3 of 3 done/)
  assert.match(stdout, /API compressions this month: 3/)
  const out = join(root, 'bitinz-compressed')
  assert.deepEqual(await tree(out), ['hero.jpg', 'icons', 'icons/done.png', 'icons/logo.png'])
  assert.equal((await readFile(join(out, 'hero.jpg'))).length, 152)
  assert.equal((await readFile(join(root, 'images/hero.jpg'))).length, 304, 'the original is untouched')
  assert.ok(!api.state.requests.some(r => r.query.filename === 'dep.png'), 'node_modules is skipped')
})

test('--in-place replaces smaller images only; --dry-run uploads nothing', async t => {
  const api = await startMockApi()
  t.after(api.close)
  const root = await site()
  const before = (await stat(join(root, 'images/icons/done.png'))).mtimeMs
  const dry = await run(['compress', 'images', '--dry-run'], { cwd: root })
  assert.equal(dry.code, 0)
  assert.match(dry.stdout, /3 images, .*Nothing was uploaded/)
  assert.equal(api.state.requests.length, 0)
  const { code } = await run(['compress', 'images', '--in-place', '--concurrency', '1', '--base-url', api.url, '--api-key', KEY], { cwd: root })
  assert.equal(code, 0)
  assert.equal((await readFile(join(root, 'images/hero.jpg'))).length, 152)
  assert.equal((await stat(join(root, 'images/icons/done.png'))).mtimeMs, before, 'an unchanged image is not rewritten')
  assert.ok(!(await readdir(root)).includes('bitinz-compressed'))
})

test('--webp writes new .webp files, keeps clashing names apart and skips larger results', async t => {
  const api = await startMockApi()
  t.after(api.close)
  const root = await mkdtemp(join(tmpdir(), 'bitinz-cli-'))
  await writeFile(join(root, 'photo.jpg'), bytes.jpeg('p'.repeat(90)))
  await writeFile(join(root, 'photo.png'), bytes.png('p'.repeat(90)))
  await writeFile(join(root, 'flat.png'), bytes.png('BIGWEBP'))
  await writeFile(join(root, 'still.avif'), bytes.avif('s'.repeat(90)))
  const { code, stdout } = await run(['compress', '.', '--webp', '--in-place', '--base-url', api.url, '--api-key', KEY], { cwd: root })
  assert.equal(code, 0, stdout)
  // AVIF cannot become WebP: it is compressed as AVIF and keeps its name.
  assert.deepEqual((await readdir(root)).sort(), ['flat.png', 'photo.jpg', 'photo.jpg.webp', 'photo.png', 'photo.png.webp', 'still.avif'])
  assert.match(stdout, /✓ still\.avif .*AVIF kept as AVIF/)
  assert.equal((await readFile(join(root, 'still.avif'))).subarray(4, 8).toString(), 'ftyp')
  assert.match(stdout, /! flat\.png .*not written; the original is smaller/)
  const kept = await run(['compress', 'flat.png', '--webp', '--keep-larger', '--base-url', api.url, '--api-key', KEY], { cwd: root })
  assert.equal(kept.code, 0)
  assert.ok((await readdir(join(root, 'bitinz-compressed'))).includes('flat.webp'))
})

test('--min-savings keeps originals whose saving is too small', async t => {
  const api = await startMockApi()
  t.after(api.close)
  const root = await site()
  // The mock halves every image, a 50% saving: below 60, above 40.
  const high = await run(['compress', 'images/hero.jpg', '--in-place', '--min-savings', '60', '--base-url', api.url, '--api-key', KEY], { cwd: root })
  assert.equal(high.code, 0)
  assert.match(high.stdout, /= images\/hero\.jpg .*below the minimum; original kept/)
  assert.equal((await readFile(join(root, 'images/hero.jpg'))).length, 304)
  const low = await run(['compress', 'images/hero.jpg', '--in-place', '--min-savings', '40', '--base-url', api.url, '--api-key', KEY], { cwd: root })
  assert.equal(low.code, 0)
  assert.equal((await readFile(join(root, 'images/hero.jpg'))).length, 152)
  assert.equal((await run(['compress', 'images', '--min-savings', '100'], { cwd: root })).code, 2)
})

test('a used-up quota stops the batch with exit code 3; JSON output reports it', async t => {
  const api = await startMockApi({ quota: 1 })
  t.after(api.close)
  const root = await site()
  const { code, stdout } = await run(['compress', 'images', '--json', '--concurrency', '1', '--base-url', api.url, '--api-key', KEY], { cwd: root })
  assert.equal(code, 3)
  const report = JSON.parse(stdout)
  assert.equal(report.stopped.code, 'quota_exceeded')
  assert.deepEqual(report.files.map(f => f.status), ['compressed', 'failed', 'skipped'])
})

test('usage errors exit 2; a key saved by login is used, and logout forgets it', async t => {
  const api = await startMockApi()
  t.after(api.close)
  const root = await site(), config = join(root, 'config')
  const env = { XDG_CONFIG_HOME: config, HOME: root }
  assert.equal((await run(['compress'], { cwd: root, env })).code, 2)
  assert.equal((await run(['compress', 'images', '--level', 'max'], { cwd: root, env })).code, 2)
  assert.equal((await run(['compress', 'images', '--in-place', '-o', 'x'], { cwd: root, env })).code, 2)
  const nokey = await run(['compress', 'images', '--base-url', api.url], { cwd: root, env })
  assert.equal(nokey.code, 2)
  assert.match(nokey.stderr, /No API key\. Run "bitinz login"/)
  assert.equal((await run(['login'], { cwd: root, env, input: 'not-a-key\n' })).code, 2)
  const login = await run(['login'], { cwd: root, env, input: KEY + '\n' })
  assert.equal(login.code, 0, login.stderr)
  const file = join(config, 'bitinz/config.json')
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).apiKey, KEY)
  assert.equal((await run(['compress', 'images/hero.jpg', '--base-url', api.url], { cwd: root, env })).code, 0)
  assert.match((await run(['logout'], { cwd: root, env })).stdout, /removed/)
  assert.equal((await run(['compress', 'images', '--base-url', api.url], { cwd: root, env })).code, 2)
  assert.equal((await run(['--version'])).stdout.trim(), JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
})
