import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

// 单表补丁：更新若干行，或向表尾追加若干行（如跨模块台账新增）。
export type TablePatch = {
  key: string
  updates?: { id: number; fields: Record<string, string | number | boolean> }[]
  inserts?: Record<string, string | number | boolean>[]
}

// 乐观锁条件：只有当前版本号与期望一致时才允许提交，用来挡住两个班组并发确认。
export type VersionGuard = { key: string; id: number; version: number }

type TransactionOptions = {
  guards?: VersionGuard[]
}

type CommitFailure = {
  ok: false
  message: string
}

type CommitSuccess = {
  ok: true
  tables: Record<string, EntryRow[]>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function findRow(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

// 老数据（本功能上线前已落库的记录）没有版本号，按 0 处理，保证已维护过的隔离带不用迁移。
export function rowVersion(row: EntryRow | undefined): number {
  if (!row) {
    return -1
  }
  const version = Number(row.version)
  return Number.isInteger(version) && version >= 0 ? version : 0
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 一次性原子落库多张表：先在内存快照上完成全部校验与修改，最后只写一次 localStorage。
// 任何一张表的乐观锁不通过，或补丁找不到目标行，都整体抛错，调用方（列表/抽屉/台账/待办）一处都不会变。
export function commitTables(patches: TablePatch[], options: TransactionOptions = {}): CommitSuccess | CommitFailure {
  const snapshot = clone(allRows())

  for (const guard of options.guards ?? []) {
    const rows = snapshot[guard.key]
    const row = rows?.find((item) => Number(item.id) === guard.id)
    if (!rows || !row) {
      return { ok: false, message: `编号 ${guard.id} 的记录已不存在，请刷新后重试` }
    }
    if (rowVersion(row) !== guard.version) {
      return { ok: false, message: `编号 ${guard.id} 的记录刚被其他班组处理过，请刷新后再确认` }
    }
  }

  for (const patch of patches) {
    const rows = snapshot[patch.key]
    if (!rows) {
      return { ok: false, message: `数据中不存在「${patch.key}」台账，事务整体回退` }
    }
    for (const change of patch.updates ?? []) {
      const index = rows.findIndex((row) => Number(row.id) === change.id)
      if (index < 0) {
        return { ok: false, message: `编号 ${change.id} 的记录已不存在，请刷新后重试` }
      }
      rows[index] = {
        ...rows[index],
        ...clone(change.fields),
        version: rowVersion(rows[index]) + 1,
      }
    }
    for (const insert of patch.inserts ?? []) {
      const newRow: EntryRow = {
        id: nextId(rows),
        status: '',
        pending: false,
        abnormal: false,
        version: 1,
        ...clone(insert),
      }
      rows.push(newRow)
    }
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    }
  } catch (error) {
    // 落库失败：内存缓存保持旧值不动，列表、抽屉、台账、待办一起回退。
    return { ok: false, message: error instanceof Error ? error.message : '数据落库失败，事务已整体回退' }
  }

  cache = snapshot
  return { ok: true, tables: snapshot }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 仅供验证脚本使用：模拟页面刷新，丢弃内存缓存后下次读取只认 localStorage。
export function __resetCacheForTest(): void {
  cache = null
}
