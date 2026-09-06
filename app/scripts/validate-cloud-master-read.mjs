/**
 * 用 esbuild 打包并执行 scripts/check-cloud-master-read.ts（云端基础资料：门店/技能等级/设备 只读查询校验）。
 * 中间产物写入系统临时目录，执行后自动删除，不污染项目。
 * 用法：node scripts/validate-cloud-master-read.mjs  （或 npm run validate:cloud-master-read）
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'snowpeak-cloud-master-read-check-'))
const outfile = path.join(dir, 'check-cloud-master-read.mjs')

await build({
  entryPoints: ['scripts/check-cloud-master-read.ts'],
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
