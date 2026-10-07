/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 七张表分表存储
 * - 每行带 revision / reviewState / createdAt / updatedAt：
 *   revision 是乐观锁修订号，每次保存 +1；保存前比对打开时记下的修订号，
 *   落后即抛 RevisionConflictError，由页面提示「这条已被人改过」并保留未提交内容
 * - 入罐 / 排程的罐位唯一占用与容量校验全部放在读写事务内完成，
 *   多个窗口同时排同一个罐时，后提交的一方会在事务内被当场拒绝
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table, type Transaction } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch } from '../types/batch'
import type { Reading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import { REVIEW_NORMAL, REVIEW_PENDING, UNREVIEWED_REVISION } from '../types/revision'
import { nowIso } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbwinetank-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 新建行的起始修订号 */
export const ROW_REVISION = 1

/** 带时间戳、乐观锁修订号与复核状态的持久化实体 */
export interface Revisioned {
  revision: number
  /** 升级时无法按创建时间回填修订号的旧数据标为待复核 */
  reviewState: import('../types/revision').ReviewState
  createdAt: number
  updatedAt: number
}

export type ParcelRow = Parcel & Revisioned
export type TankRow = Tank & Revisioned
export type BatchRow = Batch & Revisioned
export type ReadingRow = Reading & Revisioned
export type OperationRow = Operation & Revisioned
export type MlfRow = Mlf & Revisioned
export type TastingRow = Tasting & Revisioned

/** 乐观锁冲突：打开时的修订号已落后于库里的最新修订号 */
export class RevisionConflictError extends Error {
  /** 库里的最新修订号 */
  readonly currentRevision: number
  /** 该记录最后一次被修改的时间（ms），用于提示是谁先改的 */
  readonly latestUpdatedAt: number
  /** 冲突后库里的最新整行（拿得到时附带，便于页面直接回填） */
  readonly latest?: unknown

  constructor(currentRevision: number, latestUpdatedAt: number, latest?: unknown, message = '这条记录已被其他人改过，请先载入最新内容再决定是否保留你的修改') {
    super(message)
    this.name = 'RevisionConflictError'
    this.currentRevision = currentRevision
    this.latestUpdatedAt = latestUpdatedAt
    this.latest = latest
  }
}

type VersionedTable = Table<Record<string, unknown>, string>
const TABLE_NAMES = ['parcels', 'tanks', 'batches', 'readings', 'operations', 'mlfs', 'tastings'] as const

class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留以让旧库逐版本升级）
    this.version(1).stores({
      parcels: 'id, name, variety, aspect, updatedAt',
      tanks: 'id, code, material, tempControl, state, updatedAt',
      batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
      readings: 'id, batchId, date, updatedAt',
      operations: 'id, batchId, type, state, date, seq, updatedAt',
      mlfs: 'id, batchId, state, updatedAt',
      tastings: 'id, batchId, date, verdict, updatedAt'
    })

    // v2：引入 reviewState；revision 升级为单调递增的乐观锁修订号。
    // 索引结构不变，只需在 upgrade 里回填历史行。
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
      .upgrade((tx) => backfillRevisions(tx))
  }
}

/**
 * 历史行修订号回填：
 * - 已有正整数修订号的行（v1 应用写出的行恒为 1）保持不动，只补 reviewState；
 * - 缺修订号但有创建时间的行，在每张表内按创建时间从早到晚回填 1..n（同时间按 id 兜底）；
 * - 连创建时间都没有、无法定位先后的行，revision 置 0 并标成「待复核」，
 *   等人工打开保存一次后再纳入正常递增序列。
 */
async function backfillRevisions(tx: Transaction): Promise<void> {
  for (const name of TABLE_NAMES) {
    const table = tx.table(name) as VersionedTable
    const rows = await table.toArray()

    const missing: Array<{ row: Record<string, unknown>; tick: number }> = []
    for (const row of rows) {
      if (typeof row.reviewState !== 'string') row.reviewState = REVIEW_NORMAL
      if (typeof row.updatedAt !== 'number') row.updatedAt = typeof row.createdAt === 'number' ? row.createdAt : Date.now()

      const hasRevision = typeof row.revision === 'number' && Number.isInteger(row.revision) && row.revision > 0
      if (hasRevision) continue

      if (typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)) {
        missing.push({ row, tick: row.createdAt })
      } else {
        // 回填不了：标待复核，updatedAt 缺失时给当前时间（此时两窗口冲突只能靠人工复核兜住）
        row.revision = UNREVIEWED_REVISION
        row.reviewState = REVIEW_PENDING
        if (typeof row.createdAt !== 'number') row.createdAt = row.updatedAt
      }
    }

    missing.sort((a, b) => a.tick - b.tick || String(a.row.id).localeCompare(String(b.row.id)))
    missing.forEach((item, index) => {
      item.row.revision = index + 1
      item.row.reviewState = REVIEW_NORMAL
    })

    // Dexie 的 upgrade 回调要求显式 put 才会持久化对对象的修改
    for (const row of rows) {
      await table.put(row)
    }
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

/* --------------------------- 修订号 / 乐观锁工具 --------------------------- */

/** 读一行并规整乐观锁必需字段（兼容历史漏写 reviewState 的行） */
async function requireRow<T extends Revisioned>(table: Table<T, string>, id: string, label: string): Promise<T> {
  const row = await table.get(id)
  if (!row) throw new Error(`${label}不存在或已被删除`)
  if (row.reviewState !== REVIEW_PENDING) row.reviewState = REVIEW_NORMAL
  return row
}

/**
 * 在事务内做乐观锁校验。
 * - expectedRevision 缺省时视为新建场景（调用方另行保证 id 不存在）；
 * - 待复核行（revision=0）允许任何人保存，保存即转正；
 * - 库内修订号比打开时新，则抛 RevisionConflictError。
 */
function assertNotStale<T extends Revisioned>(current: T, expectedRevision: number | undefined): void {
  if (expectedRevision === undefined) return
  if (current.reviewState === REVIEW_PENDING) return
  if (current.revision > expectedRevision) {
    throw new RevisionConflictError(current.revision, current.updatedAt, current)
  }
}

/** 保存后的下一个修订号；待复核行转正时回到正常序列 */
function nextRevisionOf<T extends Revisioned>(current: T | undefined, expectedRevision?: number): number {
  if (current) {
    if (current.reviewState === REVIEW_PENDING) return Math.max(ROW_REVISION, expectedRevision ?? 0) + 1
    if (expectedRevision !== undefined && expectedRevision > current.revision) return expectedRevision + 1
    return current.revision + 1
  }
  return ROW_REVISION
}

/**
 * 通用「碰一下」更新：写入补丁、修订号 +1、刷新 updatedAt。
 * 供出罐、完成作业、状态流转等不需要页面侧乐观锁的联动写使用；
 * 页面表单的保存走各自的 save* 事务函数，那里要先比对修订号。
 */
async function bumpRow<T extends Revisioned>(
  table: Table<T, string>,
  id: string,
  patch: Partial<T>,
  label: string
): Promise<void> {
  await db.transaction('rw', table, async () => {
    const current = await requireRow(table, id, label)
    const next: Record<string, unknown> = {
      ...patch,
      revision: nextRevisionOf(current),
      updatedAt: Date.now()
    }
    if (current.reviewState === REVIEW_PENDING) next.reviewState = REVIEW_NORMAL
    await table.update(id, next as never)
  })
}

/* ------------------------------ 地块 ------------------------------ */

export async function listParcels(): Promise<ParcelRow[]> {
  const rows = await db.parcels.toArray()
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putParcel(row: ParcelRow): Promise<void> {
  await db.parcels.put(row)
}

export async function updateParcel(id: string, patch: Partial<Parcel>): Promise<void> {
  await bumpRow(db.parcels, id, patch as Partial<ParcelRow>, '地块')
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
  await db.tanks.put(row)
}

export async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
  await bumpRow(db.tanks, id, patch as Partial<TankRow>, '发酵罐')
}

export async function removeTank(id: string): Promise<void> {
  const active = await db.batches.where('tankId').equals(id).filter((b) => b.state !== '已出罐').count()
  if (active > 0) {
    throw new Error('该罐仍有在罐批次，请先出罐或改绑其它罐位')
  }
  await db.transaction('rw', db.tanks, db.batches, async () => {
    await db.batches.where('tankId').equals(id).modify({ tankId: '', updatedAt: Date.now() })
    await db.tanks.delete(id)
  })
}

/* ------------------------------ 入罐批次 ------------------------------ */

export async function listBatches(): Promise<BatchRow[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.harvestDate.localeCompare(a.harvestDate))
}

export async function putBatch(row: BatchRow): Promise<void> {
  await db.batches.put(row)
}

export async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
  await bumpRow(db.batches, id, patch as Partial<BatchRow>, '批次')
}

/** 内部级联删除：清掉批次下属全部子表数据 */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  const batch = await db.batches.get(batchId)
  const tankId = batch?.tankId ?? ''
  await db.batches.delete(batchId)
  // 先删批次再重算，罐位才会按「已无占用」释放
  if (tankId) await recomputeTankState(tankId)
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

/** 出罐：批次置为已出罐，随后按最新占用释放罐位 */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, async () => {
    const batch = await requireRow(db.batches, id, '批次')
    const tankId = batch.tankId
    await db.batches.update(id, {
      state: '已出罐',
      revision: nextRevisionOf(batch),
      updatedAt: Date.now()
    } as Partial<BatchRow>)
    // 先置为已出罐再重算，罐位才会释放
    if (tankId) await recomputeTankState(tankId)
  })
}

/**
 * 罐位可分配校验（事务内调用，读到的都是本次提交点的最新数据）：
 * - 罐存在且不是清洗中；
 * - 该罐没有被其它在罐批次占用（两个窗口同时排同一个罐时，
 *   由于读写事务按作用域串行，后到的一方在这里会看到先到的占用并被拒绝）；
 * - 入罐量不超过罐容量（容量不够当场拒绝排程）。
 */
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
    throw new Error(`罐 ${tank.code} 已被批次 ${occupants[0].id} 占用，禁止把不同批次同时排进同一个罐`)
  }
  if (typeof volumeL === 'number' && Number.isFinite(volumeL) && volumeL > tank.capacityL) {
    throw new Error(`入罐量 ${volumeL}L 超过罐 ${tank.code} 的容量 ${tank.capacityL}L，无法排入，请更换罐位或调整入罐量`)
  }
  return tank
}

/**
 * 依据当前在罐批次重算单个罐的状态：
 * 有在罐批次 → 在用；无占用且原本不是清洗中 → 空闲（清洗中的罐保持清洗中）。
 * 罐容量 / 批次入罐量改动后都通过它让罐位占用立即回到最新数字。
 */
async function recomputeTankState(tankId: string): Promise<void> {
  const tank = await db.tanks.get(tankId)
  if (!tank) return
  const occupantCount = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((b) => b.state !== '已出罐')
    .count()
  const nextState = occupantCount > 0 ? '在用' : tank.state === '清洗中' ? '清洗中' : '空闲'
  if (nextState === tank.state) return
  await db.tanks.update(tankId, {
    state: nextState,
    revision: nextRevisionOf(tank),
    updatedAt: Date.now()
  } as Partial<TankRow>)
}

/** 入罐登记 / 批次编辑保存的表单数据 */
export interface BatchDraft {
  parcelId: string
  tankId: string
  harvestDate: string
  volumeL: number
  brix: number
  state: Batch['state']
}

/**
 * 新建或保存一个入罐批次（含乐观锁与事务内罐位/容量校验）。
 * @param id 传已有批次 id 为编辑；不传为新建
 * @param expectedRevision 编辑窗口打开时记下的修订号；新建传 undefined
 * @param force true 时跳过修订号比对（用户确认以自己的内容强制覆盖），容量等硬校验仍执行
 */
export async function saveBatch(
  draft: BatchDraft,
  id: string | null,
  expectedRevision: number | undefined,
  force = false
): Promise<string> {
  return db.transaction('rw', [db.batches, db.tanks], async () => {
    let current: BatchRow | undefined
    if (id) current = await db.batches.get(id)
    if (id && !current) throw new Error('批次不存在或已被删除')
    if (current && !force) assertNotStale(current, expectedRevision)

    if (!draft.parcelId) throw new Error('请选择地块')
    if (!draft.tankId) throw new Error('请选择发酵罐')

    const previousTankId = current?.tankId ?? ''
    await assertTankReady(draft.tankId, draft.volumeL, id)

    const now = Date.now()
    const batchId = id ?? createBatchId()
    const row: BatchRow = {
      id: batchId,
      parcelId: draft.parcelId,
      tankId: draft.tankId,
      harvestDate: draft.harvestDate,
      volumeL: draft.volumeL,
      brix: draft.brix,
      state: draft.state,
      lastOperationAt: current?.lastOperationAt ?? null,
      revision: nextRevisionOf(current, force ? expectedRevision : undefined),
      reviewState: REVIEW_NORMAL,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    }
    await db.batches.put(row)

    // 罐位占用按最新数据重算：新罐置在用；改罐时旧罐释放
    await recomputeTankState(draft.tankId)
    if (previousTankId && previousTankId !== draft.tankId) {
      await recomputeTankState(previousTankId)
    }
    return batchId
  })
}

let batchSeq = 0
function createBatchId(): string {
  batchSeq += 1
  return `batch-${Date.now().toString(36)}-${batchSeq}-${Math.random().toString(36).slice(2, 8)}`
}

/** 罐配置编辑保存的表单数据（容量改小到装不下在罐批次时当场拒绝） */
export interface TankDraft {
  code: string
  material: Tank['material']
  capacityL: number
  tempControl: Tank['tempControl']
  state: Tank['state']
}

/**
 * 新建或保存发酵罐配置（含乐观锁）。
 * 容量被改小时，若该罐当前在罐批次的入罐量超过新容量，拒绝这次修改，
 * 提示先出罐或先调整批次入罐量——避免罐位占用还照着老容量走。
 */
export async function saveTank(
  draft: TankDraft,
  id: string | null,
  expectedRevision: number | undefined,
  force = false
): Promise<string> {
  return db.transaction('rw', [db.tanks, db.batches], async () => {
    let current: TankRow | undefined
    if (id) current = await db.tanks.get(id)
    if (id && !current) throw new Error('发酵罐不存在或已被删除')
    if (current && !force) assertNotStale(current, expectedRevision)

    if (current && draft.capacityL < current.capacityL) {
      const overflow = await db.batches
        .where('tankId')
        .equals(id as string)
        .filter((b) => b.state !== '已出罐' && b.volumeL > draft.capacityL)
        .toArray()
      if (overflow.length > 0) {
        throw new Error(
          `新容量 ${draft.capacityL}L 装不下在罐批次 ${overflow[0].id}（入罐量 ${overflow[0].volumeL}L），请先调整入罐量或安排出罐`
        )
      }
    }

    const now = Date.now()
    const tankId = id ?? createTankId()
    const row: TankRow = {
      id: tankId,
      code: draft.code,
      material: draft.material,
      capacityL: draft.capacityL,
      tempControl: draft.tempControl,
      state: draft.state,
      revision: nextRevisionOf(current, force ? expectedRevision : undefined),
      reviewState: REVIEW_NORMAL,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    }
    await db.tanks.put(row)

    // 罐容量一改，罐位占用立即按新数字重算
    await recomputeTankState(tankId)
    return tankId
  })
}

let tankSeq = 0
function createTankId(): string {
  tankSeq += 1
  return `tank-${Date.now().toString(36)}-${tankSeq}-${Math.random().toString(36).slice(2, 8)}`
}

/* ------------------------------ 发酵读数 ------------------------------ */

export async function listReadings(): Promise<ReadingRow[]> {
  const rows = await db.readings.toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReading(row: ReadingRow): Promise<void> {
  await db.readings.put(row)
}

export async function updateReading(id: string, patch: Partial<Reading>): Promise<void> {
  await bumpRow(db.readings, id, patch as Partial<ReadingRow>, '读数')
}

export async function removeReading(id: string): Promise<void> {
  await db.readings.delete(id)
}

/** 读数编辑保存的表单数据 */
export interface ReadingDraft {
  batchId: string
  date: string
  gravity: number
  tempC: number
  brix: number
}

/**
 * 新建或保存一条发酵读数（乐观锁）。
 * 同批次同一天只允许一条；重复校验放在事务内，两个窗口同时录同一天时后者被拒。
 */
export async function saveReading(
  draft: ReadingDraft,
  id: string | null,
  expectedRevision: number | undefined,
  force = false
): Promise<string> {
  return db.transaction('rw', [db.readings, db.batches], async () => {
    const batch = await db.batches.get(draft.batchId)
    if (!batch) throw new Error('所属批次不存在或已被删除')

    let current: ReadingRow | undefined
    if (id) current = await db.readings.get(id)
    if (id && !current) throw new Error('读数不存在或已被删除')
    if (current && !force) assertNotStale(current, expectedRevision)

    const duplicate = await db.readings
      .where('batchId')
      .equals(draft.batchId)
      .filter((row) => row.date === draft.date && row.id !== id)
      .first()
    if (duplicate) throw new Error(`该批次 ${draft.date} 已由其他窗口录入读数，请直接编辑已有记录`)

    const now = Date.now()
    const readingId = id ?? createReadingId()
    const row: ReadingRow = {
      id: readingId,
      ...draft,
      revision: nextRevisionOf(current, force ? expectedRevision : undefined),
      reviewState: REVIEW_NORMAL,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    }
    await db.readings.put(row)
    return readingId
  })
}

let readingSeq = 0
function createReadingId(): string {
  readingSeq += 1
  return `reading-${Date.now().toString(36)}-${readingSeq}-${Math.random().toString(36).slice(2, 8)}`
}

/* -------------------------------- 作业 -------------------------------- */

export async function listOperations(): Promise<OperationRow[]> {
  const rows = await db.operations.toArray()
  return rows.sort((a, b) => a.seq - b.seq || a.date.localeCompare(b.date))
}

export async function putOperation(row: OperationRow): Promise<void> {
  await db.operations.put(row)
}

export async function updateOperation(id: string, patch: Partial<Operation>): Promise<void> {
  await bumpRow(db.operations, id, patch as Partial<OperationRow>, '作业')
}

export async function removeOperation(id: string): Promise<void> {
  await db.operations.delete(id)
}

/** 作业编辑保存的表单数据 */
export interface OperationDraft {
  batchId: string
  type: Operation['type']
  date: string
  durationMin: number
  operator: string
  state: Operation['state']
}

/**
 * 新建或保存一条作业排程（乐观锁 + 目标罐容量硬校验）。
 * 排程前按最新的批次入罐量 / 罐容量复核：目标罐容量不够当场拒绝，
 * 这样改过罐容量或批次入罐量以后，排程不会再照老数字排进去。
 */
export async function saveOperation(
  draft: OperationDraft,
  id: string | null,
  expectedRevision: number | undefined,
  force = false
): Promise<string> {
  return db.transaction('rw', [db.operations, db.batches, db.tanks], async () => {
    if (!draft.operator.trim()) throw new Error('请填写操作人')
    const batch = await db.batches.get(draft.batchId)
    if (!batch) throw new Error('所属批次不存在或已被删除')
    if (batch.state === '已出罐') throw new Error('批次已出罐，不能再为其排作业')
    if (batch.tankId) await assertTankReady(batch.tankId, batch.volumeL, batch.id)

    let current: OperationRow | undefined
    if (id) current = await db.operations.get(id)
    if (id && !current) throw new Error('作业不存在或已被删除')
    if (current && !force) assertNotStale(current, expectedRevision)

    const now = Date.now()
    const operationId = id ?? createOperationId()
    let seq = 0
    if (current) {
      seq = current.seq
    } else {
      const siblings = await db.operations.where('batchId').equals(draft.batchId).toArray()
      seq = siblings.reduce((max, row) => Math.max(max, row.seq), 0) + 1
    }
    const row: OperationRow = {
      id: operationId,
      ...draft,
      seq: current?.seq ?? seq,
      revision: nextRevisionOf(current, force ? expectedRevision : undefined),
      reviewState: REVIEW_NORMAL,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    }
    await db.operations.put(row)
    return operationId
  })
}

let operationSeq = 0
function createOperationId(): string {
  operationSeq += 1
  return `operation-${Date.now().toString(36)}-${operationSeq}-${Math.random().toString(36).slice(2, 8)}`
}

/** 批量写回拖拽后的作业顺序（每条修订号 +1，避免旧窗口基于老顺序覆盖） */
export async function reorderOperations(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.operations, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      const current = await db.operations.get(orderedIds[index])
      if (!current) continue
      const patch: Record<string, unknown> = {
        seq: index + 1,
        revision: nextRevisionOf(current),
        updatedAt: Date.now()
      }
      if (current.reviewState === REVIEW_PENDING) patch.reviewState = REVIEW_NORMAL
      await db.operations.update(orderedIds[index], patch as Partial<OperationRow>)
    }
  })
}

/** 作业完成：置为已完成并回写批次的最近作业时间 */
export async function completeOperation(id: string): Promise<void> {
  await db.transaction('rw', db.operations, db.batches, async () => {
    const operation = await requireRow(db.operations, id, '作业')
    await db.operations.update(id, {
      state: '已完成',
      revision: nextRevisionOf(operation),
      updatedAt: Date.now()
    } as Partial<OperationRow>)
    const batch = await db.batches.get(operation.batchId)
    if (batch) {
      await db.batches.update(operation.batchId, {
        lastOperationAt: nowIso(),
        revision: nextRevisionOf(batch),
        updatedAt: Date.now()
      } as Partial<BatchRow>)
    }
  })
}

/* ------------------------------ 苹乳发酵 ------------------------------ */

export async function listMlfs(): Promise<MlfRow[]> {
  return db.mlfs.toArray()
}

export async function putMlf(row: MlfRow): Promise<void> {
  await db.mlfs.put(row)
}

export async function updateMlf(id: string, patch: Partial<Mlf>): Promise<void> {
  await bumpRow(db.mlfs, id, patch as Partial<MlfRow>, '苹乳记录')
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
  await db.tastings.put(row)
}

export async function updateTasting(id: string, patch: Partial<Tasting>): Promise<void> {
  await bumpRow(db.tastings, id, patch as Partial<TastingRow>, '品评记录')
}

export async function removeTasting(id: string): Promise<void> {
  await db.tastings.delete(id)
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
  delete copy.reviewState
  delete copy.createdAt
  delete copy.updatedAt
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
  return { ...row, revision: ROW_REVISION, reviewState: REVIEW_NORMAL, createdAt: Date.now(), updatedAt: Date.now() }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings],
    async () => {
      await Promise.all(TABLE_NAMES.map((name) => db.table(name).clear()))
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
      await Promise.all(TABLE_NAMES.map((name) => db.table(name).clear()))
    }
  )
  await seedDatabase()
}

/** 各表行数与待复核行数统计，供页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings] = await Promise.all([
    db.parcels.toArray(),
    db.tanks.toArray(),
    db.batches.toArray(),
    db.readings.toArray(),
    db.operations.toArray(),
    db.mlfs.toArray(),
    db.tastings.toArray()
  ])
  const all = [...parcels, ...tanks, ...batches, ...readings, ...operations, ...mlfs, ...tastings]
  return {
    parcels: parcels.length,
    tanks: tanks.length,
    batches: batches.length,
    readings: readings.length,
    operations: operations.length,
    mlfs: mlfs.length,
    tastings: tastings.length,
    pendingReview: all.filter((row) => row.reviewState === REVIEW_PENDING).length
  }
}
