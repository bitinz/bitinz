import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.avif']
const CONVERTIBLE = ['.png', '.jpg', '.jpeg']
export const OUTPUT_DIR = 'bitinz-compressed'
// Never walked into: dependencies, version control and earlier results.
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', OUTPUT_DIR])

export interface ImageFile {
  /** Absolute path of the image. */
  path: string
  /** The argument it was found under; outputs keep their place relative to it. */
  root: string
}

export interface Collected {
  files: ImageFile[]
  /** Paths given explicitly that do not exist or are not images. */
  skipped: { path: string; reason: string }[]
}

export const isImage = (path: string) => IMAGE_EXTENSIONS.includes(extname(path).toLowerCase())

/** Finds the images among files and directories, in a stable order and without duplicates. */
export async function collectImages(paths: string[], { recursive = true } = {}): Promise<Collected> {
  const files: ImageFile[] = [], skipped: Collected['skipped'] = [], seen = new Set<string>()
  const add = (path: string, root: string) => {
    if (!seen.has(path)) { seen.add(path); files.push({ path, root }) }
  }
  const walk = async (dir: string, root: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive && !SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(path, root)
      } else if (entry.isFile() && isImage(entry.name)) add(path, root)
    }
  }
  for (const given of paths) {
    const path = resolve(given)
    const info = await stat(path).catch(() => undefined)
    if (!info) skipped.push({ path, reason: 'not found' })
    else if (info.isDirectory()) await walk(path, path)
    else if (!isImage(path)) skipped.push({ path, reason: 'not a PNG, JPG, WebP or AVIF file' })
    else add(path, dirname(path))
  }
  return { files, skipped }
}

export interface PlanOptions {
  /** Write results here, keeping each file's place relative to its argument. */
  outDir?: string
  /** Replace the originals. WebP results are written next to them instead. */
  inPlace?: boolean
  webp?: boolean
}

/**
 * Decides where each result goes. Converting photo.jpg and photo.png in one
 * folder would give two photo.webp files; those keep their extension instead
 * (photo.jpg.webp, photo.png.webp).
 */
export function planOutputs(files: ImageFile[], { outDir = OUTPUT_DIR, inPlace = false, webp = false }: PlanOptions = {}): Map<string, string> {
  const target = (file: ImageFile, stem: (name: string) => string) => {
    const name = stem(basename(file.path))
    return inPlace ? join(dirname(file.path), name) : join(resolve(outDir), relative(file.root, dirname(file.path)), name)
  }
  // Only JPG and PNG become WebP; WebP is recompressed and AVIF stays AVIF.
  const plain = (name: string) => webp && CONVERTIBLE.includes(extname(name).toLowerCase()) ? name.slice(0, -extname(name).length) + '.webp' : name
  const first = files.map(file => target(file, plain))
  const counts = new Map<string, number>()
  for (const path of first) counts.set(path, (counts.get(path) ?? 0) + 1)
  return new Map(files.map((file, i) => [file.path, counts.get(first[i])! > 1 ? target(file, name => `${name}.webp`) : first[i]]))
}
