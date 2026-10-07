/**
 * Dexie 单表增删改查 + liveQuery 响应式订阅封装。
 * 页面统一通过它读写 IndexedDB，避免组件内部直接触碰 Dexie 实例。
 */
import { liveQuery } from 'dexie'
import { onScopeDispose, ref, shallowRef, type Ref } from 'vue'
import { db, ROW_REVISION } from '@/utils/db'
import { REVIEW_NORMAL } from '@/types/revision'
import { createId } from '@/utils/uuid'

export type IdbRecord = {
  id: string
  revision?: number
  reviewState?: import('@/types/revision').ReviewState
  createdAt?: number
  updatedAt?: number
}

export interface UseIdbTableOptions<T extends IdbRecord> {
  /** 结果排序器，默认按 updatedAt 倒序 */
  compare?: (a: T, b: T) => number
  /** 是否立即开始订阅，默认 true */
  immediate?: boolean
}

export type NewRecord<T extends IdbRecord> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
}

export interface UseIdbTableResult<T extends IdbRecord> {
  rows: Ref<T[]>
  ready: Ref<boolean>
  error: Ref<string | null>
  refresh: () => Promise<void>
  stop: () => void
  getById: (id: string) => Promise<T | undefined>
  create: (payload: NewRecord<T>, idPrefix?: string) => Promise<T>
  update: (id: string, patch: Partial<T>) => Promise<void>
  upsert: (row: T) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkPut: (list: T[]) => Promise<void>
  clear: () => Promise<void>
}

/** 默认排序：最近更新的排前面 */
function defaultCompare<T extends IdbRecord>(a: T, b: T): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
}

export function useIdbTable<T extends IdbRecord>(
  tableSelector: (database: typeof db) => import('dexie').Table<T, string>,
  options: UseIdbTableOptions<T> = {}
): UseIdbTableResult<T> {
  const compare = options.compare ?? defaultCompare
  const table = tableSelector(db)

  const rows = ref([]) as Ref<T[]>
  const ready = ref(false)
  const error = ref<string | null>(null)
  const subscription = shallowRef<{ unsubscribe: () => void } | null>(null)

  const sort = (list: T[]): T[] => [...list].sort(compare)

  const refresh = async (): Promise<void> => {
    try {
      rows.value = sort(await table.toArray())
      error.value = null
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '读取本地数据失败'
    }
  }

  const stop = (): void => {
    subscription.value?.unsubscribe()
    subscription.value = null
  }

  const create = async (payload: NewRecord<T>, idPrefix = 'row'): Promise<T> => {
    const now = Date.now()
    const record = {
      ...(payload as object),
      id: payload.id ?? createId(idPrefix),
      revision: ROW_REVISION,
      reviewState: REVIEW_NORMAL,
      createdAt: now,
      updatedAt: now
    } as unknown as T
    await table.put(record)
    return record
  }

  const update = async (id: string, patch: Partial<T>): Promise<void> => {
    // 修订号 +1：与 db.ts 的乐观锁写保持同一语义，避免旧窗口用 useIdbTable 覆盖新内容
    const current = await table.get(id)
    if (!current) throw new Error('记录不存在或已被删除')
    const baseRevision = typeof current.revision === 'number' ? current.revision : ROW_REVISION
    const next: Record<string, unknown> = {
      ...(patch as object),
      revision: baseRevision + 1,
      reviewState: REVIEW_NORMAL,
      updatedAt: Date.now()
    }
    await table.update(id, next as never)
  }

  const upsert = async (row: T): Promise<void> => {
    const current = await table.get(row.id)
    const previousRevision = current?.revision ?? row.revision ?? ROW_REVISION
    await table.put({
      ...row,
      revision: previousRevision + 1,
      reviewState: REVIEW_NORMAL,
      updatedAt: Date.now()
    } as T)
  }

  if (options.immediate !== false) {
    const observable = liveQuery(async () => sort(await table.toArray()))
    subscription.value = observable.subscribe({
      next: (list) => {
        rows.value = list as T[]
        error.value = null
        ready.value = true
      },
      error: (err: unknown) => {
        error.value = err instanceof Error ? err.message : '订阅本地数据失败'
      }
    })
    void refresh()
  }

  onScopeDispose(stop)

  return {
    rows,
    ready,
    error,
    refresh,
    stop,
    getById: (id: string) => table.get(id),
    create,
    update,
    upsert,
    remove: async (id: string) => {
      await table.delete(id)
    },
    bulkPut: async (list: T[]) => {
      await table.bulkPut(list)
    },
    clear: async () => {
      await table.clear()
    }
  }
}
