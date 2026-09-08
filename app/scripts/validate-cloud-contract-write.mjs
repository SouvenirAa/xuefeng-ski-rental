/**
 * 用 esbuild 打包并执行 scripts/check-cloud-contract-write.ts（云端合同 写操作校验，仅 RPC）。
 * 中间产物写入系统临时目录，执行后自动删除，不污染项目。
 * 用法：node scripts/validate-cloud-contract-write.mjs  （或 npm run validate:cloud-contract-write）
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'snowpeak-cloud-contract-write-check-'))
const outfile = path.join(dir, 'check-cloud-contract-write.mjs')

await build({
  entryPoints: ['scripts/check-cloud-contract-write.ts'],
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
