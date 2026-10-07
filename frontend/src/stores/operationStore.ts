/**
 * 作业 store：维护作业顺序、完成态与作业类型筛选。
 * - 新增 / 改批次前过容量闸门：目标罐装不下当前入罐量时当场拒绝排程
 * - 编辑保存带修订号乐观锁：窗口打开时记下 revision，落后一方保存被拒
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Operation } from '@/types/operation'
import type { FilterModel } from '@/types/filter'
import {
  assertBatchFitsTank,
  completeOperation,
  nextOperationSeq,
  putOperation,
  removeOperation,
  reorderOperations,
  saveOperation,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
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

  /** 新增作业：排程前校验目标罐容量装得下该批次的当前入罐量 */
  async function createOperation(payload: Omit<Operation, 'id' | 'seq'>): Promise<string> {
    if (!payload.batchId) throw new Error('请选择批次')
    if (!payload.operator.trim()) throw new Error('请填写操作人')
    await assertBatchFitsTank(payload.batchId)
    const seq = await nextOperationSeq(payload.batchId)
    const now = Date.now()
    const id = createId('operation')
    await putOperation({ ...payload, id, seq, revision: ROW_REVISION, createdAt: now, updatedAt: now, reviewStatus: '正常' })
    return id
  }

  /**
   * 编辑作业（乐观锁）：expectedRevision 为打开编辑窗口时记下的修订号。
   * 改了批次则重新过容量闸门；修订号落后时抛 RevisionConflictError，内容留在表单。
   */
  async function updateOperation(
    id: string,
    patch: Partial<Operation>,
    expectedRevision: number
  ): Promise<void> {
    const batchId = patch.batchId
    if (batchId) await assertBatchFitsTank(batchId)
    await saveOperation(id, patch, expectedRevision)
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
    updateOperation,
    deleteOperation,
    finish,
    move
  }
})
