// 事务验证脚本（不入构建产物）：用内存 localStorage 垫片驱动真实的数据层与服务层。
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}
;(globalThis as { window?: unknown }).window = {
  localStorage: new MemoryStorage(),
}

import { allRows, listRows, storageKey, __resetCacheForTest } from '@/data/local-store'
import { listEntries } from '@/api/local-service'
import { currentVersion, getFirebreak, runFirebreakAction } from '@/api/firebreak-service'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function persisted<T>(): T {
  // 模拟刷新：丢弃内存缓存，只从 localStorage 重新读
  const raw = (globalThis as { window: { localStorage: Storage } }).window.localStorage.getItem(storageKey())
  return JSON.parse(raw!) as T
}

function seedLegacy(): void {
  // 模拟老版本已落库的数据：无 version、无恢复确认班组字段
  const store = allRows()
  const legacy = store.firebreak.map((row, index) => {
    const { version: _version, ...rest } = row as Record<string, unknown>
    void _version
    return { ...(rest as object), status: index === 0 ? '需割草' : (rest as { status: string }).status }
  })
  const equipment = store.equipment.map((row) => {
    const { version: _version, ...rest } = row as Record<string, unknown>
    void _version
    return rest
  })
  ;(globalThis as { window: { localStorage: Storage } }).window.localStorage.setItem(
    storageKey(),
    JSON.stringify({ ...allRows(), firebreak: legacy, equipment }),
  )
  // 清缓存迫使重新读取（模拟刷新）
  __resetCacheForTest()
}

console.log('场景一：老数据兼容（无 version 字段、已维护过）')
seedLegacy()
const before = getFirebreak(1)!
check('老记录版本号按 0 处理', currentVersion(1) === 0, `got ${currentVersion(1)}`)
check('老记录仍可正常读取（已有最近维护日期保留）', String(before['最近维护日期']) === '2026-09-01')
const equipBefore = listRows('equipment').length

console.log('场景二：确认恢复 —— 多字段同一次落库 + 跨模块台账 +1')
const baseVersion = currentVersion(1)
const r1 = runFirebreakAction(1, '确认恢复', {
  crew: '一班',
  baseVersion,
  recoveryDate: '2026-10-02',
  recoveryLevel: '基本恢复',
})
check('确认恢复返回成功', r1.ok, r1.message)
const after = getFirebreak(1)!
check('状态更新为正常', String(after.status) === '正常')
check('维护状态列同步为正常', String(after['维护状态']) === '正常')
check('最近维护日期同次更新', String(after['最近维护日期']) === '2026-10-02', String(after['最近维护日期']))
check('植被恢复程度同次更新', String(after['植被恢复程度']) === '基本恢复')
check('恢复后不再待办', after.pending === false)
check('版本号递增', Number(after.version) === 1, `got ${String(after.version)}`)
check('装备待维护台账增加一条', listRows('equipment').length === equipBefore + 1)
const added = listRows('equipment')[listRows('equipment').length - 1]
check('新增台账为待检修且计入待办', String(added.status) === '待检修' && added.pending === true)
check('新增台账编号带来源隔离带', String(added['装备编号']).includes('FIRE-0001'))

console.log('场景三：刷新 / 重新进入后结果一致（只认 localStorage）')
const disk = persisted<{ firebreak: { 最近维护日期: string; 植被恢复程度: string; status: string }[] }>()
check('落库结果含最新维护日期', disk.firebreak[0]['最近维护日期'] === '2026-10-02')
check('落库结果含最新植被恢复程度', disk.firebreak[0]['植被恢复程度'] === '基本恢复')
check('列表读取与抽屉（getFirebreak）同源一致', listEntries('firebreak').items[0]['最近维护日期'] === '2026-10-02')

console.log('场景四：两个班组并发确认，只生效一次，失败方整体回退')
// 先安排维护，让记录回到可确认状态
const arrange = runFirebreakAction(1, '安排维护', { crew: '一班', baseVersion: currentVersion(1) })
check('安排维护成功', arrange.ok, arrange.message)
const v = currentVersion(1)
const equipMid = listRows('equipment').length
const crewA = runFirebreakAction(1, '确认恢复', { crew: '一班', baseVersion: v, recoveryDate: '2026-10-03', recoveryLevel: '已恢复' })
const crewB = runFirebreakAction(1, '确认恢复', { crew: '二班', baseVersion: v, recoveryDate: '2026-10-04', recoveryLevel: '部分恢复' })
check('班组A确认成功', crewA.ok, crewA.message)
check('班组B并发确认被拒（只生效一次）', !crewB.ok && crewB.message.includes('其他班组'), crewB.message)
const finalRow = getFirebreak(1)!
check('最终保留班组A的结果', String(finalRow['最近维护日期']) === '2026-10-03' && String(finalRow['植被恢复程度']) === '已恢复')
check('失败方没有让台账再多一条', listRows('equipment').length === equipMid + 1)
check('失败方没有改动隔离带任何字段', String(finalRow.status) === '正常' && finalRow.pending === false)

console.log('场景五：事务失败整体回退（列表/抽屉/台账/待办）')
// 第二条种子本就是「需割草」，直接拿过期版本号并发确认，触发事务失败
const equipCount = listRows('equipment').length
const beforeRow2 = getFirebreak(2)!
const bad = runFirebreakAction(2, '确认恢复', { crew: '二班', baseVersion: currentVersion(2) + 5, recoveryDate: '2026-10-05' })
check('版本不通过时事务失败', !bad.ok && bad.message.includes('其他班组'), bad.message)
check('隔离带状态未变', String(getFirebreak(2)!.status) === String(beforeRow2.status))
check('维护日期未被污染', String(getFirebreak(2)!['最近维护日期']) === String(beforeRow2['最近维护日期']))
check('植被恢复程度未被污染', String(getFirebreak(2)!['植被恢复程度']) === String(beforeRow2['植被恢复程度']))
check('装备台账未增加', listRows('equipment').length === equipCount)

console.log('场景六：业务前置校验')
check('正常状态不能重复确认恢复', !runFirebreakAction(1, '确认恢复', { crew: '一班', baseVersion: currentVersion(1) }).ok)
check('未填班组被拒', !runFirebreakAction(2, '安排维护', { crew: '  ', baseVersion: currentVersion(2) }).ok)
const abandoned = listRows('firebreak').find((r) => String(r.status) === '已荒废')
if (abandoned) {
  check('已荒废记录不能直接确认恢复', !runFirebreakAction(Number(abandoned.id), '确认恢复', { crew: '一班', baseVersion: currentVersion(Number(abandoned.id)) }).ok)
} else {
  const mark = runFirebreakAction(3, '标记荒废', { crew: '一班', baseVersion: currentVersion(3) })
  check('标记荒废成功', mark.ok, mark.message)
  check('已荒废记录不能直接安排维护', !runFirebreakAction(3, '安排维护', { crew: '一班', baseVersion: currentVersion(3) }).ok)
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
