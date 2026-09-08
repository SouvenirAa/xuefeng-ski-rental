/**
 * 用 esbuild 打包并执行 scripts/check-cloud-dashboard.ts（云端驾驶舱 KPI 聚合校验）。
 * 中间产物写入系统临时目录，执行后自动删除，不污染项目。
 * 用法：node scripts/validate-cloud-dashboard.mjs  （或 npm run validate:cloud-dashboard）
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'snowpeak-cloud-dashboard-check-'))
const outfile = path.join(dir, 'check-cloud-dashboard.mjs')

await build({
  entryPoints: ['scripts/check-cloud-dashboard.ts'],
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
