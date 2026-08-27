/**
 * 用 esbuild 打包并执行 scripts/check-workforce.ts（承包商/费率 + 员工/排班服务层测试）。
 * 中间产物写入系统临时目录，执行后自动删除，不污染项目。
 * 用法：node scripts/validate-workforce.mjs  （或 npm run validate:workforce）
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'snowpeak-workforce-check-'))
const outfile = path.join(dir, 'check-workforce.mjs')

await build({
  entryPoints: ['scripts/check-workforce.ts'],
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
