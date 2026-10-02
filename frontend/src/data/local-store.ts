import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

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

function persist(snapshot: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  }
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  // 先落库再换缓存：写不进去时缓存保持旧值，列表、台账、待办一起留在旧状态。
  persist(next)
  cache = next
}

// 事务式改写：绕开缓存直接读持久层最新快照，校验、改字段、一次性写回。
// 别的标签页（另一个班组）刚写入的状态这里能看到，不会基于过期缓存重复生效。
// mutate 返回 rows 为 null 表示放弃本次写入，什么都不落库；persist 抛错时缓存也不动，整体回退。
export function transactRows<T>(
  key: string,
  mutate: (rows: EntryRow[]) => { rows: EntryRow[] | null; result: T },
): T {
  const snapshot = readStorage()
  const { rows, result } = mutate(snapshot[key] ?? [])
  if (rows === null) {
    return result
  }
  persist({ ...snapshot, [key]: rows })
  cache = { ...snapshot, [key]: rows }
  return result
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
