/**
 * 用 esbuild 打包并执行 scripts/check-contracts.ts（租赁合同服务层测试）。
 * 中间产物写入系统临时目录，执行后自动删除，不污染项目。
 * 用法：node scripts/validate-contracts.mjs  （或 npm run validate:contracts）
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'snowpeak-contracts-check-'))
const outfile = path.join(dir, 'check-contracts.mjs')

await build({
  entryPoints: ['scripts/check-contracts.ts'],
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
