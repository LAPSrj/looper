// Builds the Tailscale helper (src/tsnet) into out/tsnet/ for Windows and Linux.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src', 'tsnet')
const outDir = join(root, 'out', 'tsnet')
const targets = [
  { goos: 'windows', file: 'looper-tsnet.exe' },
  { goos: 'linux', file: 'looper-tsnet' }
]

function findGo() {
  const candidates = [process.env.GO, 'go', '/home/leandro/.local/sdk/go/bin/go'].filter(Boolean)
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['version'], { stdio: 'ignore' })
    if (r.status === 0) return cmd
  }
  return null
}

const go = findGo()
if (!go) {
  if (targets.every((t) => existsSync(join(outDir, t.file)))) {
    console.log('Go not found; using the existing binaries in out/tsnet.')
    process.exit(0)
  }
  console.error('Go is needed to build the Tailscale helper (set GO, or put go on PATH).')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
for (const { goos, file } of targets) {
  const r = spawnSync(
    go,
    ['build', '-trimpath', '-ldflags', '-s -w', '-o', join(outDir, file), '.'],
    {
      cwd: srcDir,
      stdio: 'inherit',
      env: { ...process.env, GOOS: goos, GOARCH: 'amd64', CGO_ENABLED: '0' }
    }
  )
  if (r.status !== 0) {
    console.error(`Building ${file} failed.`)
    process.exit(r.status ?? 1)
  }
  console.log(`built out/tsnet/${file}`)
}
