import { moduleMeta } from './local-service'
import { commitTables, findRow, rowVersion } from '@/data/local-store'
import type { TablePatch } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 防火隔离带维护专属业务：动作不只流转状态，还要同一次落库维护日期、植被恢复程度，
// 并在确认恢复时给别的模块的待维护台账补一条记录。走多表事务，失败整体回退。

const FIREBREAK_KEY = 'firebreak'
// 割灌、割草作业要损耗割灌机锯片等机具，恢复确认后给「消防装备」待检修（待维护）台账增加一条。
const EQUIPMENT_KEY = 'equipment'
const EQUIPMENT_PENDING_STATUS = '待检修'

const META = moduleMeta(FIREBREAK_KEY)
const NORMAL_STATUS = '正常'
const ABANDONED_STATUS = '已荒废'
const MOW_STATUS = META.actionTargets['安排维护']
const REPLANT_STATUS = '需补植'

export type FirebreakActionPayload = {
  // 班组名称：并发确认时用来判断是不是同一批人重复点，也会留痕在台账来源里。
  crew: string
  // 抽屉打开时读到的数据版本；落库前必须仍与库内一致，否则说明被另一个班组抢先处理了。
  baseVersion: number
  // 「确认恢复」时两个班组各自填写的验收结果，同一次事务一起写进隔离带记录。
  recoveryDate?: string
  recoveryLevel?: string
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

export function runFirebreakAction(id: number, action: string, payload: FirebreakActionPayload): ActionResult {
  const target = META.actionTargets[action]
  if (!target) {
    return fail(`${META.entity}没有登记「${action}」这个动作`)
  }
  const crew = payload.crew.trim()
  if (!crew) {
    return fail('请先填写执行班组名称')
  }

  const row = findRow(FIREBREAK_KEY, id)
  if (!row) {
    return fail(`没有找到编号为 ${id} 的${META.entity}`)
  }
  // 乐观锁先于业务判断：另一个班组已提交过时，直接报冲突，提示抽屉刷新到最新版本。
  if (rowVersion(row) !== payload.baseVersion) {
    return fail('该隔离带刚被其他班组处理过，当前结果已更新，请刷新后再操作')
  }
  const current = String(row.status)
  if (current === target) {
    return fail(`${META.entity}已经是「${target}」，不用重复操作`)
  }
  // 已荒废的隔离带必须先重建，不允许直接确认恢复或安排割草。
  if (current === ABANDONED_STATUS) {
    return fail(`${META.entity}已荒废，不能执行「${action}」，请先重建后再安排维护`)
  }
  if (action === '确认恢复' && current !== MOW_STATUS && current !== REPLANT_STATUS) {
    return fail(`当前状态为「${current}」，请先安排维护再确认恢复`)
  }

  const recoveryDate = payload.recoveryDate?.trim() || today()
  const recoveryLevel = payload.recoveryLevel?.trim() || '已恢复'

  const commonFields: Record<string, string | number | boolean> = {
    status: target,
    pending: target !== NORMAL_STATUS,
    abnormal: false,
    // 列表用「维护状态」列，通用页面用 status，两处同步，避免列表与抽屉对不上。
    维护状态: target,
  }

  if (action === '确认恢复') {
    // 关键修复：状态、最近维护日期、植被恢复程度必须同一次落库，不能只改状态。
    commonFields['最近维护日期'] = recoveryDate
    commonFields['植被恢复程度'] = recoveryLevel
    commonFields['恢复确认班组'] = crew
  } else {
    commonFields['安排维护班组'] = crew
  }

  const patches: TablePatch[] = [
    {
      key: FIREBREAK_KEY,
      updates: [{ id, fields: commonFields }],
    },
  ]

  if (action === '确认恢复') {
    // 别的模块跟着增加一条「待维护」台账：割灌作业后机具需要检修。
    const code = String(row['隔离带编号'] ?? `FIREBREAK-${id}`)
    patches.push({
      key: EQUIPMENT_KEY,
      inserts: [
        {
          装备编号: `MAINT-${code}-${recoveryDate.split('-').join('')}`,
          装备名称: '割灌机具（隔离带维护回收）',
          装备类型: '防护装备',
          规格型号: `随 ${code} 维护回收`,
          保管林场: String(row['所属林区'] ?? ''),
          购入日期: recoveryDate,
          最近检修日: '',
          装备状态: EQUIPMENT_PENDING_STATUS,
          status: EQUIPMENT_PENDING_STATUS,
          pending: true,
          abnormal: false,
        },
      ],
    })
  }

  const result = commitTables(patches, {
    guards: [{ key: FIREBREAK_KEY, id, version: payload.baseVersion }],
  })
  if (!result.ok) {
    return fail(result.message)
  }
  return { ok: true, message: `${META.entity}已${action}，当前状态「${target}」` }
}

// 抽屉与列表共用同一份持久化数据，每次打开都重新读取，不保留本地副本。
export function getFirebreak(id: number): EntryRow | undefined {
  return findRow(FIREBREAK_KEY, id)
}

export function currentVersion(id: number): number {
  return rowVersion(findRow(FIREBREAK_KEY, id))
}
