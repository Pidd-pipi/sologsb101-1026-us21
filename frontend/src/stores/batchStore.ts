/**
 * 入罐批次 store：维护在罐批次、当前选中批次与地块/罐绑定校验。
 * 保存统一走 db.saveBatch：事务内做乐观锁比对、目标罐唯一占用与容量校验。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Batch } from '@/types/batch'
import type { FilterModel } from '@/types/filter'
import {
  removeBatch,
  saveBatch as saveBatchRow,
  shipBatch as shipBatchRow,
  type BatchDraft
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

  /** 入罐登记：事务内校验罐位未被占用且容量足够，随后罐位自动置为「在用」 */
  async function createBatch(payload: Omit<Batch, 'id' | 'lastOperationAt'>): Promise<string> {
    error.value = null
    const id = await saveBatchRow(payload, null, undefined)
    currentBatchId.value = id
    return id
  }

  /**
   * 保存对批次的编辑（含改罐 / 改入罐量）。
   * expectedRevision 是编辑窗口打开时记下的修订号；落后时底层抛 RevisionConflictError。
   * force=true 表示用户已确认用自己的内容强制覆盖。
   */
  async function saveExistingBatch(
    id: string,
    draft: BatchDraft,
    expectedRevision: number,
    force = false
  ): Promise<string> {
    error.value = null
    return saveBatchRow(draft, id, expectedRevision, force)
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
    saveExistingBatch,
    deleteBatch,
    ship
  }
})
