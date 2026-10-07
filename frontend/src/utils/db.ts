/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 七张表分表存储
 * - 行级修订号（revision）：每次保存自增；读数 / 作业保存前做乐观锁比对，
 *   打开窗口时记录修订号，落后的一方保存会被拒绝（RevisionConflictError）
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch, BatchState } from '../types/batch'
import type { Reading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import { nowIso } from './uuid'
import { createId } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbwinetank-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 新建行的初始修订号；此后每保存成功一次 +1 */
export const ROW_REVISION = 1

/** 数据复核状态：旧数据升级时修订号无法按创建时间回填的，一律「待复核」 */
export type ReviewStatus = '正常' | '待复核'

/** 带时间戳、修订号与复核标记的持久化实体 */
export interface Revisioned {
  /** 行级修订号：打开编辑窗口时记下它，保存前比对，落后即拒绝 */
  revision: number
  createdAt: number
  updatedAt: number
  /** 旧数据升级回填状态 */
  reviewStatus: ReviewStatus
}

export type ParcelRow = Parcel & Revisioned
export type TankRow = Tank & Revisioned
export type BatchRow = Batch & Revisioned
export type ReadingRow = Reading & Revisioned
export type OperationRow = Operation & Revisioned
export type MlfRow = Mlf & Revisioned
export type TastingRow = Tasting & Revisioned

type AnyRow = Revisioned & { id: string }

const TABLE_NAMES = ['parcels', 'tanks', 'batches', 'readings', 'operations', 'mlfs', 'tastings'] as const

/**
 * 乐观锁冲突：保存时发现库里行修订号已大于窗口打开时记下的修订号，
 * 说明这条记录已经被另一个窗口改过。落后一方的提交内容不写库，由页面保留在表单里。
 */
export class RevisionConflictError extends Error {
  /** 库里当前（更新的）修订号 */
  readonly currentRevision: number

  constructor(entityName: string, currentRevision: number) {
    super(`这条${entityName}已经被人改过（当前修订号 #${currentRevision}），您的改动未提交，已保留在表单中`)
    this.name = 'RevisionConflictError'
    this.currentRevision = currentRevision
  }
}

export class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>

  constructor(name: string = DB_NAME) {
    super(name)

    this.version(1)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        readings: 'id, batchId, date, updatedAt',
        operations: 'id, batchId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        for (const name of TABLE_NAMES) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.revision !== 'number') row.revision = ROW_REVISION
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
      })

    this.version(2)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        readings: 'id, batchId, date, updatedAt',
        operations: 'id, batchId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt'
      })
      .upgrade(async (tx) => {
        // v2 结构迁移：
        // 1) 缺修订号的旧数据按创建时间从早到晚回填 1..n；
        // 2) 连创建时间都缺失、无法判断先后的行，revision 置 0 并标「待复核」；
        // 3) 已有合法修订号的行只补复核标记。
        for (const name of TABLE_NAMES) {
          const table = tx.table<AnyRow, string>(name)
          const rows = await table.toCollection().toArray()
          if (rows.length === 0) continue

          const legacy: AnyRow[] = []
          for (const row of rows) {
            if (typeof row.revision === 'number' && Number.isFinite(row.revision) && row.revision > 0) {
              if (row.reviewStatus !== '待复核') row.reviewStatus = '正常'
            } else {
              legacy.push(row)
            }
          }

          legacy.sort((a, b) => {
            const ta = typeof a.createdAt === 'number' && Number.isFinite(a.createdAt) ? a.createdAt : Number.POSITIVE_INFINITY
            const tb = typeof b.createdAt === 'number' && Number.isFinite(b.createdAt) ? b.createdAt : Number.POSITIVE_INFINITY
            return ta - tb
          })

          const migratedAt = Date.now()
          let seq = 1
          for (const row of legacy) {
            if (typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)) {
              row.revision = seq++
              if (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) row.updatedAt = row.createdAt
              row.reviewStatus = '正常'
            } else {
              // 创建时间缺失：无法按创建时间定位先后，交车间人工复核
              row.revision = 0
              row.createdAt = migratedAt
              row.updatedAt = migratedAt
              row.reviewStatus = '待复核'
            }
          }

          await table.clear()
          await table.bulkPut(rows)
        }
      })
  }
}

export const db = new GbWineTankDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.parcels.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------- 修订号与乐观锁基础能力 ------------------------- */

/** 新建行补默认元数据（修订号从 1 起，复核状态正常） */
function withCreatedMeta<T extends Partial<Revisioned> & { id: string }>(row: T): T & Revisioned {
  const now = Date.now()
  return {
    reviewStatus: '正常',
    ...row,
    revision: typeof row.revision === 'number' && row.revision > 0 ? row.revision : ROW_REVISION,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : now
  } as T & Revisioned
}

/**
 * 系统侧写回（完成 / 调序 / 状态流转等非人工编辑）：
 * 读出现值后整体写回并把修订号 +1，保证任何窗口都能观察到最新修订。
 */
async function bumpRow<T extends AnyRow>(table: Table<T, string>, id: string, patch: Partial<T>): Promise<void> {
  const current = await table.get(id)
  if (!current) return
  await table.put({
    ...current,
    ...patch,
    revision: (typeof current.revision === 'number' && current.revision > 0 ? current.revision : 0) + 1,
    updatedAt: Date.now()
  })
}

/**
 * 人工编辑保存（乐观锁）：在一个事务里读出现行比对修订号。
 * - 现行修订号与窗口打开时记下的 expectedRevision 不一致：抛 RevisionConflictError，不写库；
 * - 一致：修订号 +1 后写回，待复核数据一经人工保存即转为「正常」。
 */
async function commitRow<T extends AnyRow>(
  table: Table<T, string>,
  entityName: string,
  id: string,
  patch: Partial<T>,
  expectedRevision: number
): Promise<void> {
  await db.transaction('rw', table, async () => {
    const current = await table.get(id)
    if (!current) throw new Error('记录已被删除或不存在，无法保存')
    if (current.revision !== expectedRevision) {
      throw new RevisionConflictError(entityName, current.revision)
    }
    await table.put({
      ...current,
      ...patch,
      revision: current.revision + 1,
      reviewStatus: '正常',
      updatedAt: Date.now()
    })
  })
}

/* ------------------------------ 地块 ------------------------------ */

export async function listParcels(): Promise<ParcelRow[]> {
  const rows = await db.parcels.toArray()
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putParcel(row: ParcelRow): Promise<void> {
  await db.parcels.put(withCreatedMeta(row))
}

export async function updateParcel(id: string, patch: Partial<Parcel>): Promise<void> {
  await bumpRow(db.parcels, id, patch)
}

/** 删除地块：级联删除其下批次及批次的读数/作业/苹乳/品评，并释放占用的罐位 */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks],
    async () => {
      const batches = await db.batches.where('parcelId').equals(id).toArray()
      for (const batch of batches) {
        await cascadeRemoveBatch(batch.id)
      }
      await db.parcels.delete(id)
    }
  )
}

/* ------------------------------ 发酵罐 ------------------------------ */

export async function listTanks(): Promise<TankRow[]> {
  const rows = await db.tanks.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putTank(row: TankRow): Promise<void> {
  await db.tanks.put(withCreatedMeta(row))
}

/**
 * 修改发酵罐：若改动容量，立即按最新入罐量重算占用，
 * 新容量装不下当前在罐批次时当场拒绝（罐位占用不允许出现超载）。
 */
export async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
  if (typeof patch.capacityL === 'number') {
    const tank = await db.tanks.get(id)
    if (tank) {
      const occupants = await db.batches
        .where('tankId')
        .equals(id)
        .filter((b) => b.state !== '已出罐')
        .toArray()
      const occupiedVolume = occupants.reduce((sum, batch) => sum + batch.volumeL, 0)
      if (occupiedVolume > patch.capacityL) {
        const labels = occupants.map((batch) => `${batch.id}（${batch.volumeL}L）`).join('、')
        throw new Error(
          `罐 ${tank.code} 当前在罐量 ${occupiedVolume}L（${labels}），新容量 ${patch.capacityL}L 装不下，已拒绝修改；请先调整批次入罐量或安排出罐`
        )
      }
    }
  }
  await bumpRow(db.tanks, id, patch)
}

export async function removeTank(id: string): Promise<void> {
  const active = await db.batches.where('tankId').equals(id).filter((b) => b.state !== '已出罐').count()
  if (active > 0) {
    throw new Error('该罐仍有在罐批次，请先出罐或改绑其它罐位')
  }
  await db.transaction('rw', db.tanks, db.batches, async () => {
    const historical = await db.batches.where('tankId').equals(id).toArray()
    for (const batch of historical) {
      await bumpRow(db.batches, batch.id, { tankId: '' })
    }
    await db.tanks.delete(id)
  })
}

/* ------------------------------ 入罐批次 ------------------------------ */

export interface NewBatchInput {
  id?: string
  parcelId: string
  tankId: string
  harvestDate: string
  volumeL: number
  brix: number
  state: BatchState
}

/** 罐位占用/容量校验：清洗中、已被其它在罐批次占用、入罐量超容量，一律拒绝 */
async function assertTankReady(tankId: string, volumeL: number, excludeBatchId: string | null): Promise<TankRow> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  if (tank.state === '清洗中') throw new Error(`罐 ${tank.code} 正在清洗中，暂不可分配`)
  const occupants = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((b) => b.state !== '已出罐' && b.id !== excludeBatchId)
    .toArray()
  if (occupants.length > 0) {
    throw new Error(`罐 ${tank.code} 已被批次 ${occupants[0].id} 占用，禁止重复分配`)
  }
  if (volumeL > tank.capacityL) {
    throw new Error(`目标罐 ${tank.code} 容量仅 ${tank.capacityL}L，批次入罐量 ${volumeL}L，容量不足，已拒绝本次排程`)
  }
  return tank
}

/**
 * 入罐登记：占用校验 + 建批次 + 罐位置「在用」在同一个事务内完成，
 * 两个窗口同时把不同批次排进同一个罐时，只有一个事务能成功。
 */
export async function createBatchAssigned(input: NewBatchInput): Promise<BatchRow> {
  return db.transaction('rw', db.tanks, db.batches, async () => {
    await assertTankReady(input.tankId, input.volumeL, null)
    const now = Date.now()
    const row: BatchRow = {
      id: input.id ?? createId('batch'),
      parcelId: input.parcelId,
      tankId: input.tankId,
      harvestDate: input.harvestDate,
      volumeL: input.volumeL,
      brix: input.brix,
      state: input.state,
      lastOperationAt: null,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now,
      reviewStatus: '正常'
    }
    await db.batches.put(row)
    const tank = (await db.tanks.get(input.tankId)) as TankRow
    await db.tanks.put({ ...tank, state: '在用', revision: tank.revision + 1, updatedAt: now })
    return row
  })
}

export async function listBatches(): Promise<BatchRow[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.harvestDate.localeCompare(a.harvestDate))
}

export async function putBatch(row: BatchRow): Promise<void> {
  await db.batches.put(withCreatedMeta(row))
}

/**
 * 改批次（罐位 / 入罐量等）：凡涉及罐位或入罐量，都在同一事务内按最新数据
 * 重算占用与容量——改绑罐位做原子互斥校验，改入罐量超容量当场拒绝。
 */
export async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
  const affectsTank = 'tankId' in patch || 'volumeL' in patch
  if (!affectsTank) {
    await bumpRow(db.batches, id, patch)
    return
  }
  await db.transaction('rw', db.batches, db.tanks, async () => {
    const current = await db.batches.get(id)
    if (!current) throw new Error('批次不存在')
    const nextTankId = typeof patch.tankId === 'string' ? patch.tankId : current.tankId
    const nextVolume = typeof patch.volumeL === 'number' ? patch.volumeL : current.volumeL

    const now = Date.now()
    if (nextTankId && nextTankId !== current.tankId) {
      const target = await assertTankReady(nextTankId, nextVolume, id)
      await db.batches.put({
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: now
      })
      await db.tanks.put({ ...target, state: '在用', revision: target.revision + 1, updatedAt: now })
      if (current.tankId) await releaseTankIfEmpty(current.tankId, now)
    } else if (nextVolume > 0 && current.tankId) {
      // 只改入罐量：对现罐做容量复核
      const tank = await db.tanks.get(current.tankId)
      if (tank && nextVolume > tank.capacityL) {
        throw new Error(
          `罐 ${tank.code} 容量仅 ${tank.capacityL}L，入罐量改为 ${nextVolume}L 后超载，已拒绝；请先调大罐容量或安排出罐`
        )
      }
      await db.batches.put({
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: now
      })
    } else {
      await db.batches.put({
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: now
      })
    }
  })
}

/** 若该罐已无在罐批次，回到「空闲」（修订号 +1） */
async function releaseTankIfEmpty(tankId: string, now: number): Promise<void> {
  const tank = await db.tanks.get(tankId)
  if (!tank) return
  const remaining = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((b) => b.state !== '已出罐')
    .count()
  if (remaining === 0) {
    await db.tanks.put({ ...tank, state: '空闲', revision: tank.revision + 1, updatedAt: now })
  }
}

/** 内部级联删除：清掉批次下属全部子表数据 */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  const batch = await db.batches.get(batchId)
  if (batch && batch.tankId) {
    await releaseTankIfEmpty(batch.tankId, Date.now())
  }
  await db.batches.delete(batchId)
}

export async function removeBatch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks],
    async () => {
      await cascadeRemoveBatch(id)
    }
  )
}

/** 出罐：批次置为已出罐并自动释放罐位 */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, async () => {
    const batch = await db.batches.get(id)
    if (!batch) throw new Error('批次不存在')
    const now = Date.now()
    await db.batches.put({ ...batch, state: '已出罐', revision: batch.revision + 1, updatedAt: now })
    if (batch.tankId) await releaseTankIfEmpty(batch.tankId, now)
  })
}

/**
 * 排作业前的容量闸门：批次所在罐必须装得下该批次的当前入罐量。
 * 罐容量或入罐量被另一个窗口改小后，照老数字排程会在这里被当场拒绝。
 */
export async function assertBatchFitsTank(batchId: string): Promise<void> {
  const batch = await db.batches.get(batchId)
  if (!batch) throw new Error('批次不存在，无法排程')
  if (batch.state === '已出罐') throw new Error('批次已出罐，不能再排作业')
  if (!batch.tankId) throw new Error('该批次尚未分配发酵罐，无法排程')
  const tank = await db.tanks.get(batch.tankId)
  if (!tank) throw new Error('批次绑定的发酵罐不存在，无法排程')
  if (batch.volumeL > tank.capacityL) {
    throw new Error(
      `目标罐 ${tank.code} 容量仅 ${tank.capacityL}L，批次入罐量 ${batch.volumeL}L，容量不足，已拒绝本次排程`
    )
  }
}

/* ------------------------------ 发酵读数 ------------------------------ */

export async function listReadings(): Promise<ReadingRow[]> {
  const rows = await db.readings.toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReading(row: ReadingRow): Promise<void> {
  await db.readings.put(withCreatedMeta(row))
}

export async function updateReading(id: string, patch: Partial<Reading>): Promise<void> {
  await bumpRow(db.readings, id, patch)
}

/**
 * 读数保存（乐观锁）：expectedRevision 为读数窗口打开时记下的修订号。
 * 已被另一个窗口改过则抛 RevisionConflictError，提交内容留在页面表单里。
 */
export async function saveReading(id: string, patch: Partial<Reading>, expectedRevision: number): Promise<void> {
  await commitRow(db.readings, '读数', id, patch, expectedRevision)
}

export async function removeReading(id: string): Promise<void> {
  await db.readings.delete(id)
}

/* -------------------------------- 作业 -------------------------------- */

export async function listOperations(): Promise<OperationRow[]> {
  const rows = await db.operations.toArray()
  return rows.sort((a, b) => a.seq - b.seq || a.date.localeCompare(b.date))
}

export async function putOperation(row: OperationRow): Promise<void> {
  await db.operations.put(withCreatedMeta(row))
}

export async function updateOperation(id: string, patch: Partial<Operation>): Promise<void> {
  await bumpRow(db.operations, id, patch)
}

/**
 * 作业保存（乐观锁）：expectedRevision 为作业编排窗口打开时记下的修订号。
 * 已被另一个窗口改过则抛 RevisionConflictError，提交内容留在页面表单里。
 */
export async function saveOperation(
  id: string,
  patch: Partial<Operation>,
  expectedRevision: number
): Promise<void> {
  await commitRow(db.operations, '作业', id, patch, expectedRevision)
}

export async function removeOperation(id: string): Promise<void> {
  await db.operations.delete(id)
}

/** 批量写回拖拽后的作业顺序（逐条自增修订号） */
export async function reorderOperations(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.operations, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await bumpRow(db.operations, orderedIds[index], { seq: index + 1 })
    }
  })
}

/** 作业完成：置为已完成并回写批次的最近作业时间 */
export async function completeOperation(id: string): Promise<void> {
  await db.transaction('rw', db.operations, db.batches, async () => {
    const operation = await db.operations.get(id)
    if (!operation) throw new Error('作业不存在')
    const now = Date.now()
    await db.operations.put({
      ...operation,
      state: '已完成',
      revision: operation.revision + 1,
      updatedAt: now
    })
    await bumpRow(db.batches, operation.batchId, { lastOperationAt: nowIso() })
  })
}

/** 某个批次现有作业的最大序号 */
export async function nextOperationSeq(batchId: string): Promise<number> {
  const rows = await db.operations.where('batchId').equals(batchId).toArray()
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1
}

/* ------------------------------ 苹乳发酵 ------------------------------ */

export async function listMlfs(): Promise<MlfRow[]> {
  return db.mlfs.toArray()
}

export async function putMlf(row: MlfRow): Promise<void> {
  await db.mlfs.put(withCreatedMeta(row))
}

export async function updateMlf(id: string, patch: Partial<Mlf>): Promise<void> {
  await bumpRow(db.mlfs, id, patch)
}

export async function removeMlf(id: string): Promise<void> {
  await db.mlfs.delete(id)
}

/* ------------------------------ 品评调配 ------------------------------ */

export async function listTastings(): Promise<TastingRow[]> {
  const rows = await db.tastings.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putTasting(row: TastingRow): Promise<void> {
  await db.tastings.put(withCreatedMeta(row))
}

export async function updateTasting(id: string, patch: Partial<Tasting>): Promise<void> {
  await bumpRow(db.tastings, id, patch)
}

export async function removeTasting(id: string): Promise<void> {
  await db.tastings.delete(id)
}

/* --------------------------- 待复核数据管理 --------------------------- */

export interface PendingReviewItem {
  table: (typeof TABLE_NAMES)[number]
  id: string
  revision: number
  createdAt: number
}

/** 汇总全库「待复核」行（旧数据升级时修订号回填不了的） */
export async function listPendingReview(): Promise<PendingReviewItem[]> {
  const items: PendingReviewItem[] = []
  for (const tableName of TABLE_NAMES) {
    const rows = await db.table<AnyRow, string>(tableName).toArray()
    for (const row of rows) {
      if (row.reviewStatus === '待复核') {
        items.push({ table: tableName, id: row.id, revision: row.revision, createdAt: row.createdAt })
      }
    }
  }
  return items.sort((a, b) => a.table.localeCompare(b.table) || a.createdAt - b.createdAt)
}

/** 人工复核通过：恢复有效修订号并转为「正常」 */
export async function resolvePendingReview(tableName: (typeof TABLE_NAMES)[number], id: string): Promise<void> {
  const tablesByKey: Record<(typeof TABLE_NAMES)[number], Table<AnyRow, string>> = {
    parcels: db.parcels as unknown as Table<AnyRow, string>,
    tanks: db.tanks as unknown as Table<AnyRow, string>,
    batches: db.batches as unknown as Table<AnyRow, string>,
    readings: db.readings as unknown as Table<AnyRow, string>,
    operations: db.operations as unknown as Table<AnyRow, string>,
    mlfs: db.mlfs as unknown as Table<AnyRow, string>,
    tastings: db.tastings as unknown as Table<AnyRow, string>
  }
  await bumpRow(tablesByKey[tableName], id, { revision: ROW_REVISION, reviewStatus: '正常' })
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  parcels: Parcel[]
  tanks: Tank[]
  batches: Batch[]
  readings: Reading[]
  operations: Operation[]
  mlfs: Mlf[]
  tastings: Tasting[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  delete copy.reviewStatus
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings] = await Promise.all([
    db.parcels.toArray(),
    db.tanks.toArray(),
    db.batches.toArray(),
    db.readings.toArray(),
    db.operations.toArray(),
    db.mlfs.toArray(),
    db.tastings.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    parcels: parcels.map(stripRow),
    tanks: tanks.map(stripRow),
    batches: batches.map(stripRow),
    readings: readings.map(stripRow),
    operations: operations.map(stripRow),
    mlfs: mlfs.map(stripRow),
    tastings: tastings.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now(), reviewStatus: '正常' }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear()
      ])
      await db.parcels.bulkPut(snapshot.parcels.map(stamp))
      await db.tanks.bulkPut(snapshot.tanks.map(stamp))
      await db.batches.bulkPut(snapshot.batches.map(stamp))
      await db.readings.bulkPut(snapshot.readings.map(stamp))
      await db.operations.bulkPut(snapshot.operations.map(stamp))
      await db.mlfs.bulkPut(snapshot.mlfs.map(stamp))
      await db.tastings.bulkPut(snapshot.tastings.map(stamp))
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计，供页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings] = await Promise.all([
    db.parcels.count(),
    db.tanks.count(),
    db.batches.count(),
    db.readings.count(),
    db.operations.count(),
    db.mlfs.count(),
    db.tastings.count()
  ])
  return { parcels, tanks, batches, readings, operations, mlfs, tastings }
}
