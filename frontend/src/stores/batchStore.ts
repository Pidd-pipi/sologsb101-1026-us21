/**
 * 入罐批次 store：维护在罐批次、当前选中批次与地块/罐绑定校验。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Batch } from '@/types/batch'
import type { FilterModel } from '@/types/filter'
import {
  createBatchAssigned,
  removeBatch,
  shipBatch as shipBatchRow,
  updateBatch as updateBatchRow
} from '@/utils/db'
import { queryToFilters } from '@/utils/query'

export const BATCH_FILTER_KEYS = ['states', 'parcelIds']

export const useBatchStore = defineStore('batch', () => {
  const filters = ref<FilterModel>({ keyword: '', states: [], parcelIds: [] })
  /** 当前选中的批次 id（读数页、作业页共用上下文） */
  const currentBatchId = ref<string | null>(null)
  const error = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', states: [], parcelIds: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, BATCH_FILTER_KEYS)
    if (typeof query.batchId === 'string' && query.batchId.length > 0) {
      currentBatchId.value = query.batchId
    }
  }

  function select(id: string | null): void {
    currentBatchId.value = id
  }

  /**
   * 入罐登记：占用互斥 + 容量校验 + 罐位置「在用」在底层同一事务内完成，
   * 两个窗口同时把不同批次排进同一个罐时，只有一个能成功。
   */
  async function createBatch(payload: Omit<Batch, 'id' | 'lastOperationAt'>): Promise<string> {
    error.value = null
    if (!payload.parcelId) throw new Error('请选择地块')
    if (!payload.tankId) throw new Error('请选择发酵罐')
    const row = await createBatchAssigned(payload)
    currentBatchId.value = row.id
    return row.id
  }

  /**
   * 改批次（入罐量 / 罐位等）：底层按最新罐容量与占用重算，
   * 目标罐装不下时当场拒绝；改绑罐位是原子互斥的。
   */
  async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
    error.value = null
    await updateBatchRow(id, patch)
  }

  async function deleteBatch(id: string): Promise<void> {
    await removeBatch(id)
    if (currentBatchId.value === id) currentBatchId.value = null
  }

  /** 出罐：释放罐位并归档批次 */
  async function ship(id: string): Promise<void> {
    await shipBatchRow(id)
  }

  return {
    filters,
    currentBatchId,
    error,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    createBatch,
    updateBatch,
    deleteBatch,
    ship
  }
})
