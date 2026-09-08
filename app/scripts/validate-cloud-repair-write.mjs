/**
 * 用 esbuild 打包并执行 scripts/check-cloud-repair-write.ts（云端维修单 写操作校验，仅 RPC）。
 * 中间产物写入系统临时目录，执行后自动删除，不污染项目。
 * 用法：node scripts/validate-cloud-repair-write.mjs  （或 npm run validate:cloud-repair-write）
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'snowpeak-cloud-repair-write-check-'))
const outfile = path.join(dir, 'check-cloud-repair-write.mjs')

await build({
  entryPoints: ['scripts/check-cloud-repair-write.ts'],
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
