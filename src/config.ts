import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Keys look like bz_ followed by 48 lowercase base32 characters.
export const KEY_PATTERN = /^bz_[a-z2-7]{48}$/

/** ~/.config/bitinz/config.json, or %APPDATA%\bitinz\config.json on Windows; $XDG_CONFIG_HOME moves it anywhere. */
export function configPath(env = process.env): string {
  const base = env.XDG_CONFIG_HOME || (process.platform === 'win32' ? env.APPDATA ?? join(homedir(), 'AppData', 'Roaming') : join(homedir(), '.config'))
  return join(base, 'bitinz', 'config.json')
}

export interface Config {
  apiKey?: string
  baseUrl?: string
}

export async function readConfig(path = configPath()): Promise<Config> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Config
  } catch {
    return {}
  }
}

/** Stores the key readable by its owner only. */
export async function saveApiKey(apiKey: string, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const config = { ...await readConfig(path), apiKey }
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
}

export async function forgetApiKey(path = configPath()): Promise<boolean> {
  const config = await readConfig(path)
  if (!config.apiKey) return false
  delete config.apiKey
  if (Object.keys(config).length) await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  else await rm(path, { force: true })
  return true
}

/** The key and address to use: an explicit value, then the environment, then the saved configuration. */
export async function resolveSettings(explicit: Config = {}, env = process.env): Promise<Config> {
  const saved = await readConfig(configPath(env))
  return {
    apiKey: explicit.apiKey || env.BITINZ_API_KEY || saved.apiKey,
    baseUrl: explicit.baseUrl || env.BITINZ_BASE_URL || saved.baseUrl,
  }
}
