/**
 * 作业 store：维护作业顺序、完成态与作业类型筛选。
 * 新建 / 编辑保存统一走 db.saveOperation：乐观锁 + 事务内复核目标罐容量。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Operation } from '@/types/operation'
import type { FilterModel } from '@/types/filter'
import {
  completeOperation,
  removeOperation,
  reorderOperations,
  saveOperation as saveOperationRow,
  type OperationDraft
} from '@/utils/db'
import { queryToFilters } from '@/utils/query'

export const OPERATION_FILTER_KEYS = ['types', 'states']

export const useOperationStore = defineStore('operation', () => {
  const filters = ref<FilterModel>({ keyword: '', types: [], states: [] })
  const currentBatchId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', types: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, OPERATION_FILTER_KEYS)
    if (typeof query.batchId === 'string' && query.batchId.length > 0) {
      currentBatchId.value = query.batchId
    }
  }

  function select(id: string | null): void {
    currentBatchId.value = id
  }

  /** 排入作业：事务内按最新罐容量 / 入罐量复核，容量不够当场拒绝 */
  async function createOperation(payload: Omit<Operation, 'id' | 'seq'>): Promise<string> {
    return saveOperationRow(payload, null, undefined)
  }

  /** 保存编辑：expectedRevision 为打开编辑时记下的修订号，落后时抛 RevisionConflictError */
  async function saveExistingOperation(
    id: string,
    draft: OperationDraft,
    expectedRevision: number,
    force = false
  ): Promise<string> {
    return saveOperationRow(draft, id, expectedRevision, force)
  }

  async function deleteOperation(id: string): Promise<void> {
    await removeOperation(id)
  }

  /** 标记完成：回写批次最近作业时间 */
  async function finish(id: string): Promise<void> {
    await completeOperation(id)
  }

  /** 拖拽调序后按新顺序批量写回 seq */
  async function move(list: Operation[], from: number, to: number): Promise<void> {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    await reorderOperations(next.map((item) => item.id))
  }

  return {
    filters,
    currentBatchId,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    createOperation,
    saveExistingOperation,
    deleteOperation,
    finish,
    move
  }
})
