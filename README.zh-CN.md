# Bitinz

用 [Bitinz](https://bitinz.com) 图片压缩 API 压缩 JPG、PNG、WebP 和 AVIF 图片，或把 JPG、PNG 转成 WebP。这个包提供三种用法：

- **命令行工具**：`npx bitinz compress images/`
- **MCP 服务**：让 Claude Code、Cursor、Codex 等 AI Agent 直接压缩项目里的图片
- **Node.js 库**：`import { Bitinz } from 'bitinz'`

GitHub 工作流请使用 [bitinz/compress-action](https://github.com/bitinz/compress-action)。

[English](README.md)

## 获取 API key

在 [bitinz.com](https://bitinz.com/zh/register) 免费注册，然后在[控制台 → API 密钥](https://bitinz.com/zh/dashboard?tab=keys)里创建一个 key。每个账户每月都有免费额度，每发送一张图片计一次。

为命令行保存一次 key：

```sh
npx bitinz login
```

也可以设置环境变量 `BITINZ_API_KEY`。需要 Node.js 22 或更高版本。

## 命令行

```sh
npx bitinz compress images/                 # 结果写入 ./bitinz-compressed
npx bitinz compress images/ --in-place      # 直接替换原图
npx bitinz compress photo.jpg logo.png --level best
npx bitinz compress public/ --webp          # JPG、PNG 转成 WebP
npx bitinz compress assets/ --dry-run       # 只列出会发送哪些图片
```

| 选项 | |
|---|---|
| `-l, --level <档位>` | `fast`、`default` 或 `best`（文件最小，稍慢）。默认使用账户设置。 |
| `--webp` | 把 JPG、PNG 转成 WebP，另存为新的 `.webp` 文件。WebP 会重新压缩，AVIF 保持 AVIF。 |
| `-o, --out-dir <目录>` | 结果存放位置，默认 `./bitinz-compressed`，保留原来的目录结构。 |
| `--in-place` | 替换原图。无法变小的图片保持不动。 |
| `--no-recursive` | 不查找子目录。 |
| `-c, --concurrency <n>` | 同时上传的数量，1 到 8，默认 3。 |
| `--dry-run` | 只列出图片，不上传，不消耗额度。 |
| `--keep-larger` | 转 WebP 后比原图更大时也写入（默认跳过）。 |
| `--min-savings <n>` | 节省不足 `n`% 时保留原图，比如避免仓库里出现意义不大的改动。 |
| `--json` | 输出 JSON 报告。 |
| `--api-key <key>` | 使用这个 key，而不是 `BITINZ_API_KEY` 或已保存的 key。 |

目录里会查找 `.png`、`.jpg`、`.jpeg`、`.webp` 和 `.avif` 文件，并跳过 `node_modules`、`.git`、隐藏目录和之前生成的 `bitinz-compressed`。保持原格式时，结果绝不会比原图大；转成 WebP 可能比原图大，这种情况会提示，并且默认不写入。

退出码：`0` 成功；`1` 有图片失败；`2` 用法错误或没有 key；`3` key 无效或本月额度用完，已停止。

## AI Agent（MCP）

`npx -y bitinz mcp` 会通过标准输入输出运行一个 MCP 服务，提供 `compress_images` 工具：接收图片或目录的绝对路径，把结果写到 `bitinz-compressed` 目录；Agent 传入 `in_place: true` 时才替换原图。单次超过 100 张图片时会拒绝执行，除非 Agent 调高 `max_files`，避免一个过宽的路径意外耗尽额度。

**Claude Code**

```sh
claude mcp add --env BITINZ_API_KEY=bz_你的key --transport stdio --scope user bitinz -- npx -y bitinz mcp
```

**Cursor**（`~/.cursor/mcp.json`）、**Windsurf** 等使用 `mcpServers` 的客户端：

```json
{
  "mcpServers": {
    "bitinz": {
      "command": "npx",
      "args": ["-y", "bitinz", "mcp"],
      "env": { "BITINZ_API_KEY": "bz_你的key" }
    }
  }
}
```

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.bitinz]
command = "npx"
args = ["-y", "bitinz", "mcp"]
env = { BITINZ_API_KEY = "bz_你的key" }
tool_timeout_sec = 300
```

**VS Code**（`.vscode/mcp.json`），第一次使用时询问 key：

```json
{
  "inputs": [{ "type": "promptString", "id": "bitinz-key", "description": "Bitinz API key", "password": true }],
  "servers": {
    "bitinz": { "type": "stdio", "command": "npx", "args": ["-y", "bitinz", "mcp"], "env": { "BITINZ_API_KEY": "${input:bitinz-key}" } }
  }
}
```

如果已经运行过 `npx bitinz login`，服务会读取已保存的 key，可以省略 `env`。在 Windows（非 WSL）上，有些客户端无法直接启动 `npx`，可以改用 `"command": "cmd", "args": ["/c", "npx", "-y", "bitinz", "mcp"]`。然后对 Agent 说“把 public/ 里的图片原地压缩一下”即可。

## Node.js

```js
import { Bitinz } from 'bitinz'

const bitinz = new Bitinz({ apiKey: process.env.BITINZ_API_KEY })
const result = await bitinz.compress('photo.jpg', { level: 'best' })
// result.data 是压缩后的字节；另有 result.inputSize、result.outputSize、result.notes 等
```

`compress()` 接受文件路径、`Uint8Array` 或 `Blob`，选项有 `level`、`format`（`'same'` 或 `'webp'`）、`filename` 和 `signal`。它会自动跟进排队中的任务、在服务器繁忙时重试；无法压缩时抛出带 API 错误码（`quota_exceeded`、`too_large`、`unsupported_image`、`invalid_key` 等）的 `BitinzError`。处理整个目录可以用 `collectImages()` 和 `compressFiles()`，与命令行的行为相同。

## 隐私

图片只通过 HTTPS 发送到 `bitinz.com`，在 Bitinz 自己的服务器上处理，不交给第三方；结果几小时后自动删除。详见[隐私政策](https://bitinz.com/zh/privacy)。

## 许可证

MIT。开源的是这个客户端，Bitinz 压缩服务本身不开源。
