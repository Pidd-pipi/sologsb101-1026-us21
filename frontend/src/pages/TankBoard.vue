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
import { db, updateBatch, type BatchRow, type ParcelRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTankStore } from '@/stores/tankStore'
import {
  TANK_MATERIALS,
  TANK_STATES,
  TANK_TEMP_CONTROLS,
  createEmptyTank,
  type Tank,
  type TankState
} from '@/types/tank'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
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

/** 该罐当前在罐量（按批次入罐量实时计算，罐容量或入罐量一改立即重算） */
function occupiedVolumeOf(tankId: string): number {
  return batches.value
    .filter((batch) => batch.tankId === tankId && batch.state !== '已出罐')
    .reduce((sum, batch) => sum + batch.volumeL, 0)
}

/** 在罐量是否超过罐容量（容量被改小后的超载重算结果） */
function isOverloaded(tank: TankRow): boolean {
  return occupiedVolumeOf(tank.id) > tank.capacityL
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
  // 罐位占用按批次入罐量实时重算，而不是按罐容量累加
  const usedCapacity = tanks.value.reduce((sum, tank) => sum + occupiedVolumeOf(tank.id), 0)
  return {
    tankCount: tanks.value.length,
    totalCapacity,
    usedCapacity,
    usageRatio: totalCapacity > 0 ? Math.min(100, Math.round((usedCapacity / totalCapacity) * 100)) : 0,
    freeCount: tanks.value.filter((tank) => tank.state === '空闲').length,
    overloadedCount: tanks.value.filter((tank) => isOverloaded(tank)).length
  }
})

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Tank, 'id'>>(createEmptyTank())

const rules: FormRules = {
  code: [{ required: true, message: '请填写罐号', trigger: 'blur' }],
  capacityL: [{ required: true, message: '请填写容量', trigger: 'blur' }]
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyTank())
  dialogVisible.value = true
}

function openEdit(tank: TankRow): void {
  editingId.value = tank.id
  Object.assign(form, {
    code: tank.code,
    material: tank.material,
    capacityL: tank.capacityL,
    tempControl: tank.tempControl,
    state: tank.state
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    if (editingId.value) {
      // 容量改动：底层立即按最新入罐量重算占用，装不下当场抛错拒绝
      await store.updateTank(editingId.value, { ...form })
      ElMessage.success('罐位配置已更新，罐位占用已重算')
    } else {
      await store.createTank({ ...form })
      ElMessage.success('发酵罐已建档')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
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

/** 为该罐分配一个在罐批次（原子占用互斥 + 容量校验，两个窗口同时分配只有一个成功） */
async function assignBatch(tank: TankRow): Promise<void> {
  const candidates = batches.value.filter((batch) => batch.state !== '已出罐' && batch.tankId !== tank.id)
  if (candidates.length === 0) {
    ElMessage.info('暂无待分配的在罐批次')
    return
  }
  if (tank.state === '清洗中') {
    ElMessage.warning(`罐 ${tank.code} 正在清洗中，暂不可分配`)
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
    // 单事务内完成占用互斥校验、容量校验、批次改绑与罐位置「在用」
    await updateBatch(picked.id, { tankId: tank.id })
    ElMessage.success('罐位已分配')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.warning(error.message)
  }
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

/** 超载罐整行标红 */
function tankRowClass({ row }: { row: TankRow }): string {
  return isOverloaded(row) ? 'tank-row-overload' : ''
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

    <el-alert
      v-if="totals.overloadedCount > 0"
      class="mb"
      type="error"
      show-icon
      :closable="false"
      :title="`${totals.overloadedCount} 个罐当前在罐量超过容量（罐容量被改小后已按最新入罐量重算）`"
      description="请调大罐容量、减少入罐量或安排相关批次出罐；在罐量超载的罐不能再承接新排程。"
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

      <el-table v-else :data="filtered" stripe border :row-class-name="tankRowClass">
        <el-table-column prop="code" label="罐号" width="110" />
        <el-table-column prop="material" label="材质" width="110" />
        <el-table-column label="容量(L)" width="110" align="right">
          <template #default="{ row }">{{ row.capacityL }}</template>
        </el-table-column>
        <el-table-column label="在罐量(L)" width="140" align="right">
          <template #default="{ row }">
            <el-tag v-if="isOverloaded(row)" type="danger" effect="dark" size="small">
              {{ occupiedVolumeOf(row.id) }} / {{ row.capacityL }} 超载
            </el-tag>
            <span v-else-if="occupiedVolumeOf(row.id) > 0" class="occupied-ok">
              {{ occupiedVolumeOf(row.id) }} / {{ row.capacityL }}
            </span>
            <span v-else class="muted">0 / {{ row.capacityL }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="tempControl" label="温控方式" width="110" />
        <el-table-column label="罐位状态" width="130">
          <template #default="{ row }">
            <StageTag :value="row.state" />
          </template>
        </el-table-column>
        <el-table-column label="占用批次" min-width="200">
          <template #default="{ row }">
            <span v-if="occupancyOf(row.id)">
              {{ batchLabel(occupancyOf(row.id)) }}
              <el-tag v-if="isOverloaded(row)" type="danger" size="small" effect="plain" class="over-tag">容量不足</el-tag>
            </span>
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
          <span v-if="editingId && occupiedVolumeOf(editingId) > 0" class="capacity-hint">
            当前在罐量 {{ occupiedVolumeOf(editingId) }}L
            <span v-if="form.capacityL < occupiedVolumeOf(editingId)" class="capacity-warn">
              ，改小后将装不下、保存会被拒绝
            </span>
          </span>
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
        <el-button type="primary" @click="submit">保存</el-button>
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

.capacity-hint {
  margin-left: 12px;
  font-size: 12px;
  color: #8c8479;
}

.capacity-warn,
.over-tag {
  color: #c45656;
}

.occupied-ok {
  font-variant-numeric: tabular-nums;
}

:deep(.tank-row-overload) {
  background-color: #fef0f0;
}
</style>
