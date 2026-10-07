<script setup lang="ts">
/** /tanks 发酵罐容量配置与罐位状态看板：按材质与温控方式筛选并校验占用冲突 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, RevisionConflictError, type BatchRow, type ParcelRow, type TankDraft, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTankStore } from '@/stores/tankStore'
import {
  TANK_MATERIALS,
  TANK_STATES,
  TANK_TEMP_CONTROLS,
  createEmptyTank,
  type TankState
} from '@/types/tank'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { REVIEW_PENDING } from '@/types/revision'
import { filtersToQuery } from '@/utils/query'
import { ROUTES } from '@/router'

const route = useRoute()
const router = useRouter()
const store = useTankStore()

const { rows: tanks, ready } = useIdbTable<TankRow>(() => db.tanks, {
  compare: (a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)

const selects: FilterSelectConfig[] = [
  { key: 'materials', label: '材质', options: TANK_MATERIALS.map((item) => ({ label: item, value: item })) },
  { key: 'tempControls', label: '温控', options: TANK_TEMP_CONTROLS.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '罐位', options: TANK_STATES.map((item) => ({ label: item, value: item })) }
]

/** 占用该罐的在罐批次 */
function occupancyOf(tankId: string): BatchRow | null {
  return store.occupancyOf(tankId, batches.value)
}

function batchLabel(batch: BatchRow | null): string {
  if (!batch) return '—'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${batch.volumeL}L`
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const materials = Array.isArray(store.filters.materials) ? store.filters.materials : []
  const tempControls = Array.isArray(store.filters.tempControls) ? store.filters.tempControls : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  return tanks.value.filter((tank) => {
    const label = `${tank.code} ${tank.material} ${tank.tempControl} ${tank.state}`
    if (keyword && !label.toLowerCase().includes(keyword)) return false
    if (materials.length > 0 && !materials.includes(tank.material)) return false
    if (tempControls.length > 0 && !tempControls.includes(tank.tempControl)) return false
    if (states.length > 0 && !states.includes(tank.state)) return false
    return true
  })
})

const totals = computed(() => {
  const totalCapacity = tanks.value.reduce((sum, tank) => sum + tank.capacityL, 0)
  const usedCapacity = tanks.value
    .filter((tank) => occupancyOf(tank.id) !== null)
    .reduce((sum, tank) => sum + tank.capacityL, 0)
  return {
    tankCount: tanks.value.length,
    totalCapacity,
    usedCapacity,
    usageRatio: totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 100) : 0,
    freeCount: tanks.value.filter((tank) => tank.state === '空闲').length
  }
})

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
/** 打开罐编辑时记下的修订号，保存前比对一次 */
const baseRevision = ref<number | undefined>(undefined)
/** 已被其他窗口改动时留住表单内容 */
const conflict = ref<RevisionConflictError | null>(null)
const formRef = ref<FormInstance>()
const form = reactive(createEmptyTank())

const rules: FormRules = {
  code: [{ required: true, message: '请填写罐号', trigger: 'blur' }],
  capacityL: [{ required: true, message: '请填写容量', trigger: 'blur' }]
}

/** 编辑时该罐正在占用的在罐批次：容量改到小于其入罐量会被底层拒绝，这里先做界面提示 */
const editingTank = computed<TankRow | null>(() =>
  editingId.value ? tanks.value.find((item) => item.id === editingId.value) ?? null : null
)
const capacityBlocked = computed(() => {
  if (!editingTank.value) return null
  const overflow = batches.value.find(
    (batch) => batch.tankId === editingTank.value?.id && batch.state !== '已出罐' && batch.volumeL > form.capacityL
  )
  return overflow ? overflow : null
})

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

function openCreate(): void {
  editingId.value = null
  baseRevision.value = undefined
  conflict.value = null
  Object.assign(form, createEmptyTank())
  dialogVisible.value = true
}

function openEdit(tank: TankRow): void {
  editingId.value = tank.id
  // 记打开时的修订号
  baseRevision.value = tank.revision
  conflict.value = null
  Object.assign(form, {
    code: tank.code,
    material: tank.material,
    capacityL: tank.capacityL,
    tempControl: tank.tempControl,
    state: tank.state
  })
  dialogVisible.value = true
}

async function submit(force = false): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    const draft: TankDraft = { ...form }
    if (editingId.value && baseRevision.value !== undefined) {
      await store.saveExistingTank(editingId.value, draft, baseRevision.value, force)
    } else {
      await store.createTank(draft)
    }
    ElMessage.success(editingId.value ? '罐位配置已更新，罐位占用已按新容量重算' : '发酵罐已建档')
    conflict.value = null
    dialogVisible.value = false
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      conflict.value = error
    } else {
      ElMessage.error(error instanceof Error ? error.message : '罐位保存失败')
    }
  }
}

/** 冲突后载入对方保存的最新罐配置 */
function adoptLatest(): void {
  const latest = conflict.value?.latest as TankRow | undefined
  if (!latest) return
  Object.assign(form, {
    code: latest.code,
    material: latest.material,
    capacityL: latest.capacityL,
    tempControl: latest.tempControl,
    state: latest.state
  })
  baseRevision.value = conflict.value?.currentRevision
  conflict.value = null
}

async function remove(tank: TankRow): Promise<void> {
  const occupied = occupancyOf(tank.id)
  if (occupied) {
    ElMessage.warning(`罐 ${tank.code} 正被批次占用，请先出罐或改绑其它罐位`)
    return
  }
  try {
    await ElMessageBox.confirm(`确认删除发酵罐「${tank.code}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '确认删除'
    })
  } catch {
    return
  }
  await store.deleteTank(tank.id)
  ElMessage.success('发酵罐已删除')
}

async function changeState(tank: TankRow, next: TankState): Promise<void> {
  try {
    await store.changeState(tank, next)
    ElMessage.success(`罐 ${tank.code} 已置为「${next}」`)
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '操作失败')
  }
}

/** 为该罐分配一个在罐批次（真实占用冲突校验） */
async function assignBatch(tank: TankRow): Promise<void> {
  const candidates = batches.value.filter((batch) => batch.state !== '已出罐' && batch.tankId !== tank.id)
  if (candidates.length === 0) {
    ElMessage.info('暂无待分配的在罐批次')
    return
  }
  try {
    const { value } = await ElMessageBox.prompt(
      `可分配批次：\n${candidates.map((batch) => `${batch.id}（${batchLabel(batch)}）`).join('\n')}`,
      `为罐 ${tank.code} 分配批次`,
      { inputPlaceholder: '粘贴批次 id', confirmButtonText: '分配', cancelButtonText: '取消' }
    )
    const picked = candidates.find((batch) => batch.id === value.trim())
    if (!picked) {
      ElMessage.error('批次 id 不存在，请重新选择')
      return
    }
    // 占用冲突与容量校验全部在事务内：两个窗口同时分配同一罐时，后到者被当场拒绝
    await store.assignBatchToTank(picked, tank.id)
    ElMessage.success('罐位已分配，罐位占用已重算')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.warning(error.message)
  }
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">发酵罐容量配置与罐位看板</h2>
        <p class="page__subtitle">罐位「在用」由入罐批次绑定后自动置位；重复分配会被拦截并列出占用批次。</p>
      </div>
      <div>
        <el-button @click="router.push(ROUTES.batches)">去入罐登记</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增发酵罐</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="罐总数" :value="totals.tankCount" suffix="个" icon="Grid" tone="primary" />
      <StatBadge label="空闲罐位" :value="totals.freeCount" suffix="个" icon="Files" tone="success" />
      <StatBadge label="总容量" :value="totals.totalCapacity" suffix="L" icon="Histogram" tone="info" />
      <StatBadge label="已占用容量" :value="totals.usedCapacity" suffix="L" icon="DataLine" tone="warning" />
      <StatBadge label="罐容利用率" :value="totals.usageRatio" :percent="totals.usageRatio" show-percent tone="danger" icon="PieChart" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索罐号 / 材质 / 温控…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-title">
          <span>罐位清单（{{ filtered.length }} / {{ tanks.length }}）</span>
          <span class="muted">占用冲突校验：同一在罐批次不可占用两个罐位</span>
        </div>
      </template>

      <EmptyPanel
        v-if="ready && filtered.length === 0"
        title="没有匹配的发酵罐"
        description="新增一个发酵罐，或调整材质 / 温控 / 罐位筛选。"
        create-text="新增发酵罐"
        @create="openCreate"
      />

      <el-table v-else :data="filtered" stripe border>
        <el-table-column label="罐号" width="130">
          <template #default="{ row }">
            {{ row.code }}
            <el-tag v-if="row.reviewState === REVIEW_PENDING" type="danger" size="small" effect="plain">待复核</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="material" label="材质" width="110" />
        <el-table-column prop="capacityL" label="容量(L)" width="110" align="right" />
        <el-table-column prop="tempControl" label="温控方式" width="110" />
        <el-table-column label="罐位状态" width="130">
          <template #default="{ row }">
            <StageTag :value="row.state" />
          </template>
        </el-table-column>
        <el-table-column label="占用批次" min-width="200">
          <template #default="{ row }">
            <span v-if="occupancyOf(row.id)">{{ batchLabel(occupancyOf(row.id)) }}</span>
            <span v-else class="muted">未占用</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="row.state === '在用'" @click="assignBatch(row)">分配批次</el-button>
            <el-button
              v-if="row.state !== '清洗中'"
              link
              type="warning"
              :disabled="occupancyOf(row.id) !== null"
              @click="changeState(row, '清洗中')"
            >
              转清洗
            </el-button>
            <el-button v-else link type="success" @click="changeState(row, '空闲')">清洗完成</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑发酵罐' : '新增发酵罐'" width="520px">
      <el-alert
        v-if="conflict"
        type="error"
        :closable="false"
        show-icon
        class="mb"
        title="这个罐的配置已经被其他人改过"
        :description="`对方保存于 ${formatTime(conflict.latestUpdatedAt)}（最新修订号 ${conflict.currentRevision}）。你填写的内容仍保留在表单里，可载入最新内容后再改，或强制以你的内容覆盖。`"
      >
        <div class="conflict-actions">
          <el-button size="small" type="primary" @click="adoptLatest">载入最新内容</el-button>
          <el-button size="small" type="danger" plain @click="submit(true)">仍以我的内容覆盖</el-button>
        </div>
      </el-alert>
      <el-alert
        v-if="capacityBlocked"
        type="error"
        :closable="false"
        show-icon
        class="mb"
        :title="`容量 ${form.capacityL}L 装不下在罐批次（入罐量 ${capacityBlocked.volumeL}L）`"
        description="请先安排该批次出罐或调整入罐量，再把罐容量改小。"
      />
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="罐号" prop="code">
          <el-input v-model="form.code" placeholder="如：F-05" />
        </el-form-item>
        <el-form-item label="材质">
          <el-radio-group v-model="form.material">
            <el-radio-button v-for="item in TANK_MATERIALS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="容量(L)" prop="capacityL">
          <el-input-number v-model="form.capacityL" :min="50" :max="50000" :step="50" />
        </el-form-item>
        <el-form-item label="温控方式">
          <el-select v-model="form.tempControl" class="full">
            <el-option v-for="item in TANK_TEMP_CONTROLS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="罐位状态">
          <el-select v-model="form.state" class="full">
            <el-option v-for="item in TANK_STATES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="capacityBlocked !== null" @click="submit(false)">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.mb {
  margin-bottom: 12px;
}

.conflict-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
</style>
