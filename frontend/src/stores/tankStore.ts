/**
 * 发酵罐 store：维护罐位占用、容量筛选条件与占用冲突校验。
 * 罐配置保存走 db.saveTank：乐观锁 + 容量改小校验 + 罐位占用重算；
 * 给罐分配批次走 db.saveBatch，占用冲突 / 容量不足都在事务内拦截。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Tank, TankState } from '@/types/tank'
import type { FilterModel } from '@/types/filter'
import type { BatchRow, TankRow, TankDraft, BatchDraft } from '@/utils/db'
import {
  putTank,
  removeTank,
  saveBatch,
  saveTank as saveTankRow,
  updateTank as updateTankRow
} from '@/utils/db'
import { queryToFilters } from '@/utils/query'

export const TANK_FILTER_KEYS = ['materials', 'tempControls', 'states']

export const useTankStore = defineStore('tank', () => {
  const filters = ref<FilterModel>({ keyword: '', materials: [], tempControls: [], states: [] })
  const selectedId = ref<string | null>(null)
  const busy = ref(false)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', materials: [], tempControls: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, TANK_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedId.value = id
  }

  /** 找出占用该罐的在罐批次（无则返回 null） */
  function occupancyOf(tankId: string, batches: BatchRow[]): BatchRow | null {
    return batches.find((batch) => batch.tankId === tankId && batch.state !== '已出罐') ?? null
  }

  async function createTank(payload: Omit<Tank, 'id'>): Promise<string> {
    const id = await saveTankRow(payload, null, undefined)
    selectedId.value = id
    return id
  }

  /**
   * 保存罐配置编辑。
   * expectedRevision 为打开编辑时记下的修订号；容量改小到装不下在罐批次时底层抛错拒绝。
   */
  async function saveExistingTank(
    id: string,
    draft: TankDraft,
    expectedRevision: number,
    force = false
  ): Promise<string> {
    busy.value = true
    try {
      return await saveTankRow(draft, id, expectedRevision, force)
    } finally {
      busy.value = false
    }
  }

  /**
   * 给在罐批次改绑到指定罐（罐位看板「分配批次」）。
   * 唯一占用与容量校验在 saveBatch 的事务内完成，两个窗口同时分配时后到者被拒。
   */
  async function assignBatchToTank(batch: BatchRow, tankId: string): Promise<void> {
    busy.value = true
    try {
      const draft: BatchDraft = {
        parcelId: batch.parcelId,
        tankId,
        harvestDate: batch.harvestDate,
        volumeL: batch.volumeL,
        brix: batch.brix,
        state: batch.state
      }
      await saveBatch(draft, batch.id, batch.revision)
    } finally {
      busy.value = false
    }
  }

  async function deleteTank(id: string): Promise<void> {
    await removeTank(id)
    if (selectedId.value === id) selectedId.value = null
  }

  /** 罐位状态流转（空闲 ⇄ 清洗中）；置为「在用」需由批次绑定触发 */
  async function changeState(tank: TankRow, next: TankState): Promise<void> {
    if (next === '在用') {
      throw new Error('罐位「在用」由入罐批次绑定后自动置位，请到入罐登记页分配批次')
    }
    await updateTankRow(tank.id, { state: next })
  }

  return {
    filters,
    selectedId,
    busy,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    occupancyOf,
    createTank,
    saveExistingTank,
    assignBatchToTank,
    deleteTank,
    changeState,
    /** putTank 保留给极少数直接落库场景 */
    putTank
  }
})
