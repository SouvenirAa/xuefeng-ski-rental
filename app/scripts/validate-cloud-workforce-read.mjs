/**
 * 用 esbuild 打包并执行 scripts/check-cloud-workforce-read.ts（云端承包商/费率 + 员工/排班/门店 只读查询校验）。
 * 中间产物写入系统临时目录，执行后自动删除，不污染项目。
 * 用法：node scripts/validate-cloud-workforce-read.mjs  （或 npm run validate:cloud-workforce-read）
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'snowpeak-cloud-workforce-read-check-'))
const outfile = path.join(dir, 'check-cloud-workforce-read.mjs')

await build({
  entryPoints: ['scripts/check-cloud-workforce-read.ts'],
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
