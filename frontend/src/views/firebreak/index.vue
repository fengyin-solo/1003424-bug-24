<template>
  <section class="page" data-module="firebreak">
    <header class="page-head">
      <div>
        <h2>防火隔离带管理</h2>
        <p class="page-desc">维护防火隔离带，围绕隔离带编号、所属林区、起止坐标、带宽米数做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火隔离带</button>
        <button class="btn" type="button" @click="exportRows">导出防火隔离带清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="openDrawer(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火隔离带数据，可先登记防火隔离带</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火隔离带记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="drawer.open" class="drawer-mask" @click.self="closeDrawer">
      <aside class="drawer" role="dialog" aria-modal="true" :aria-label="`${drawer.action}处理抽屉`">
        <header class="drawer-head">
          <strong>{{ drawer.action }} · 防火隔离带</strong>
          <button class="link" type="button" @click="closeDrawer">关闭</button>
        </header>

        <!-- 抽屉数据每次打开都从持久化层重新读取，刷新或重新进入都显示最新值 -->
        <dl v-if="drawer.row" class="drawer-detail">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ drawer.row[column] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ drawer.row.status }}</dd>
        </dl>

        <form class="drawer-form" @submit.prevent="submitDrawer">
          <label class="filter-item">
            <span>执行班组</span>
            <input v-model="drawer.crew" placeholder="如：一分场扑火一班" />
          </label>
          <template v-if="drawer.action === '确认恢复'">
            <label class="filter-item">
              <span>恢复完成日期</span>
              <input v-model="drawer.recoveryDate" type="date" />
            </label>
            <label class="filter-item">
              <span>植被恢复程度</span>
              <select v-model="drawer.recoveryLevel">
                <option value="已恢复">已恢复</option>
                <option value="基本恢复">基本恢复</option>
                <option value="部分恢复">部分恢复</option>
              </select>
            </label>
          </template>
          <p v-if="drawer.action === '确认恢复'" class="page-desc">
            确认后状态、最近维护日期、植被恢复程度将同一次落库，并为消防装备台账新增一条待检修记录。
          </p>
          <p v-if="drawer.message" class="error-text">{{ drawer.message }}</p>
          <div class="drawer-actions">
            <button class="btn primary" type="submit">提交</button>
            <button class="btn ghost" type="button" @click="closeDrawer">取消</button>
          </div>
        </form>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import { getFirebreak, runFirebreakAction } from '@/api/firebreak-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firebreak')
const columns = ["隔离带编号", "所属林区", "起止坐标", "带宽米数", "建成日期", "最近维护日期", "植被恢复程度", "维护状态"]
const actions = ["安排维护", "确认恢复", "标记荒废"]
const statuses = ["正常", "需割草", "需补植", "已荒废"]
const stats = [{"label": "隔离带总长", "value": 0}, {"label": "需维护条数", "value": 0}, {"label": "荒废条数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const drawer = reactive({
  open: false,
  action: '',
  rowId: 0,
  row: undefined as EntryRow | undefined,
  baseVersion: 0,
  crew: '',
  recoveryDate: '',
  recoveryLevel: '已恢复',
  message: '',
})

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火隔离带登记入口尚未接入审批流'
}

function openDrawer(action: string, row: EntryRow) {
  // 不直接用列表里的行对象：重新读持久化层，保证抽屉看到的就是库里最新状态。
  const latest = getFirebreak(Number(row.id))
  if (!latest) {
    errorMessage.value = `没有找到编号为 ${row.id} 的防火隔离带，请刷新列表`
    reload()
    return
  }
  drawer.open = true
  drawer.action = action
  drawer.rowId = Number(latest.id)
  drawer.row = latest
  drawer.baseVersion = Number(latest.version) || 0
  drawer.crew = ''
  drawer.recoveryDate = today()
  drawer.recoveryLevel = '已恢复'
  drawer.message = ''
  errorMessage.value = ''
}

function closeDrawer() {
  drawer.open = false
  drawer.row = undefined
  drawer.message = ''
}

function submitDrawer() {
  drawer.message = ''
  const result = runFirebreakAction(drawer.rowId, drawer.action, {
    crew: drawer.crew,
    baseVersion: drawer.baseVersion,
    recoveryDate: drawer.recoveryDate,
    recoveryLevel: drawer.recoveryLevel,
  })
  if (!result.ok) {
    // 事务失败：列表、抽屉、台账、待办全部未变更。重新读取，把被其他班组抢先更新的版本刷出来。
    drawer.message = result.message
    const latest = getFirebreak(drawer.rowId)
    if (latest) {
      drawer.row = latest
      drawer.baseVersion = Number(latest.version) || 0
    }
    reload()
    return
  }
  closeDrawer()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 抽屉保持打开时也要同步最新持久化结果，避免抽屉残留旧值。
    if (drawer.open) {
      drawer.row = getFirebreak(drawer.rowId)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火隔离带列表读取失败'
  }
}

onMounted(reload)
</script>
