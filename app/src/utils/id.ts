import type { ID } from '../data/types'
import { today } from './format'

/** ID 与业务编号生成工具 */

/** 自增主键生成器 */
export function createIdGenerator(): () => ID {
  let next = 1
  return () => next++
}

/**
 * 基于现有记录生成下一个主键：取当前最大主键 + 1。
 * 不依赖数组长度（删除中间记录后仍保证唯一），用于 DataService 持久化场景。
 */
export function nextId<T>(rows: T[], getId: (row: T) => ID): ID {
  let max = 0
  for (const row of rows) {
    const id = getId(row)
    if (id > max) max = id
  }
  return max + 1
}

/** 业务编号：前缀 + 年月日 + 4 位序号，如 C2026-0825-0001 */
export function buildBusinessNo(prefix: string, seq: number, date: string = today()): string {
  const d = date.replace(/-/g, '')
  return `${prefix}${d.slice(0, 6)}-${String(seq).padStart(4, '0')}`
}

/** 合同编号：RC-YYYYMMDD-XXXX */
export function buildContractNo(seq: number, date: string = today()): string {
  return buildBusinessNo('RC', seq, date)
}

/** 维修单编号：RO-YYYYMMDD-XXXX */
export function buildRepairNo(seq: number, date: string = today()): string {
  return buildBusinessNo('RO', seq, date)
}
