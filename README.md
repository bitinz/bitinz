# Bitinz

Compress JPG, PNG, WebP and AVIF images, or convert JPG and PNG to WebP, with the [Bitinz](https://bitinz.com) image compression API. This package gives you three ways to use it:

- a **command line tool**: `npx bitinz compress images/`
- an **MCP server**, so AI agents such as Claude Code, Cursor and Codex can compress images in your project
- a **Node.js library**: `import { Bitinz } from 'bitinz'`

For GitHub workflows, see [bitinz/compress-action](https://github.com/bitinz/compress-action).

[简体中文](README.zh-CN.md)

## Get an API key

Create a free account at [bitinz.com](https://bitinz.com/register) and add a key under [Dashboard → API keys](https://bitinz.com/dashboard?tab=keys). Every account has a free monthly quota; each image you send uses one compression of it.

Save the key once for the command line:

```sh
npx bitinz login
```

or set `BITINZ_API_KEY` in the environment. Node.js 22 or later is required.

## Command line

```sh
npx bitinz compress images/                 # results go to ./bitinz-compressed
npx bitinz compress images/ --in-place      # replace the originals
npx bitinz compress photo.jpg logo.png --level best
npx bitinz compress public/ --webp          # convert JPG and PNG to WebP
npx bitinz compress assets/ --dry-run       # list what would be sent
```

```
✓ images/hero.jpg  2.2 MB → 969 KB  −56%
✓ images/icons/logo.png  69.2 KB → 17.9 KB  −74%
= images/icons/done.png  12.0 KB  already optimized

3 of 3 done: 2.3 MB → 999 KB, saved 1.3 MB (57%)
```

| Option | |
|---|---|
| `-l, --level <level>` | `fast`, `default` or `best` (smallest files, a little slower). Defaults to your account's setting. |
| `--webp` | Convert JPG and PNG to WebP, written as new `.webp` files. WebP images are recompressed; AVIF stays AVIF. |
| `-o, --out-dir <dir>` | Where results go. Default: `./bitinz-compressed`, keeping the folder structure. |
| `--in-place` | Replace the originals. Images that cannot get smaller are left untouched. |
| `--no-recursive` | Do not look inside subfolders. |
| `-c, --concurrency <n>` | Parallel uploads, 1 to 8. Default: 3. |
| `--dry-run` | List the images without uploading them. Uses no quota. |
| `--keep-larger` | Also write WebP files that turned out larger than the original (skipped by default). |
| `--min-savings <n>` | Keep the original when a result saves less than `n` percent, e.g. to avoid churn in a repository. |
| `--json` | Print a JSON report. |
| `--api-key <key>` | Use this key instead of `BITINZ_API_KEY` or the saved one. |

Folders are searched for `.png`, `.jpg`, `.jpeg`, `.webp` and `.avif` files; `node_modules`, `.git`, hidden folders and earlier `bitinz-compressed` results are skipped. Keeping the format never gives you a larger file. A WebP conversion can be larger than its source, so such files are reported and not written unless you ask.

Exit codes: `0` success, `1` some images failed, `2` wrong usage or no key, `3` stopped because the key is invalid or the monthly quota is used up.

## AI agents (MCP)

`npx -y bitinz mcp` runs an MCP server over standard input and output. It offers one tool, `compress_images`, which takes absolute paths of images or folders and writes the results to a `bitinz-compressed` folder, or replaces the originals when the agent passes `in_place: true`. It refuses batches of more than 100 images unless the agent raises `max_files`, so a broad path cannot use up your quota by accident.

**Claude Code**

```sh
claude mcp add --env BITINZ_API_KEY=bz_your_key --transport stdio --scope user bitinz -- npx -y bitinz mcp
```

**Cursor** (`~/.cursor/mcp.json`), **Windsurf** and other clients that use `mcpServers`:

```json
{
  "mcpServers": {
    "bitinz": {
      "command": "npx",
      "args": ["-y", "bitinz", "mcp"],
      "env": { "BITINZ_API_KEY": "bz_your_key" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.bitinz]
command = "npx"
args = ["-y", "bitinz", "mcp"]
env = { BITINZ_API_KEY = "bz_your_key" }
tool_timeout_sec = 300
```

**VS Code** (`.vscode/mcp.json`), asking for the key once:

```json
{
  "inputs": [{ "type": "promptString", "id": "bitinz-key", "description": "Bitinz API key", "password": true }],
  "servers": {
    "bitinz": { "type": "stdio", "command": "npx", "args": ["-y", "bitinz", "mcp"], "env": { "BITINZ_API_KEY": "${input:bitinz-key}" } }
  }
}
```

If you already ran `npx bitinz login`, the server finds the saved key and the `env` entry can be left out. On Windows outside WSL, some clients cannot start `npx` directly; use `"command": "cmd", "args": ["/c", "npx", "-y", "bitinz", "mcp"]` there. Then ask your agent something like *"compress the images in public/ in place"*.

## Node.js

```js
import { Bitinz } from 'bitinz'

const bitinz = new Bitinz({ apiKey: process.env.BITINZ_API_KEY })
const result = await bitinz.compress('photo.jpg', { level: 'best' })
// result.data: the compressed bytes; result.inputSize, result.outputSize, result.notes …
```

`compress()` accepts a file path, a `Uint8Array` or a `Blob`, and options `level`, `format` (`'same'` or `'webp'`), `filename` and `signal`. It follows queued jobs and retries a busy server by itself, and throws a `BitinzError` with the API's `code` (`quota_exceeded`, `too_large`, `unsupported_image`, `invalid_key` …) when an image cannot be compressed. For whole folders, `collectImages()` and `compressFiles()` do what the command line does.

## Privacy

Images are sent only to `bitinz.com`, over HTTPS, and processed on Bitinz's own servers, never by third parties. Results are deleted automatically after a few hours. See the [privacy policy](https://bitinz.com/privacy).

## License

MIT. This package is the open-source client; the Bitinz compression service itself is not open source.
