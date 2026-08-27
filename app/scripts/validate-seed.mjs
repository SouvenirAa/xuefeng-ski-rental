/**
 * 用 esbuild 打包并执行 scripts/check-seed.ts（种子数据校验）。
 * 中间产物写入系统临时目录，执行后自动删除，不污染项目。
 * 用法：node scripts/validate-seed.mjs  （或 npm run validate:seed）
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'snowpeak-seed-check-'))
const outfile = path.join(dir, 'check-seed.mjs')

await build({
  entryPoints: ['scripts/check-seed.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})

try {
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
