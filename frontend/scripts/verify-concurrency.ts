/**
 * 运行时验证（node 直接执行，内存里的真实 IndexedDB 事务）：
 * 1) 乐观锁：后保存的一方用旧修订号保存被拒，强制覆盖可成功；
 * 2) 容量硬校验：入罐超容量 / 改小罐容 / 超容量排作业 都被事务拒绝；
 * 3) 同罐双占：两次入罐同一罐，后到者被拒；
 * 4) 旧数据升级回填：有创建时间按时间回填 1..n，没有的标待复核；
 * 5) 待复核行保存一次后转正、修订号进入正常序列。
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import Dexie from 'dexie'
import {
  db,
  RevisionConflictError,
  saveTank,
  saveBatch,
  saveOperation,
  saveReading,
  shipBatch
} from '../src/utils/db'
import { REVIEW_NORMAL, REVIEW_PENDING } from '../src/types/revision'

let passed = 0
function ok(name: string): void {
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function makeTank(code: string, capacityL: number): Promise<string> {
  return saveTank(
    { code, material: '不锈钢', capacityL, tempControl: '夹套', state: '空闲' },
    null,
    undefined
  )
}

const batchDraft = (tankId: string, volumeL: number) => ({
  parcelId: 'p-x',
  tankId,
  harvestDate: '2026-10-01',
  volumeL,
  brix: 23,
  state: '酒精发酵' as const
})

/* -------------------------------- 1. 乐观锁 -------------------------------- */
{
  const tankA = await makeTank('T-A', 3000)
  const id = await saveBatch(batchDraft(tankA, 2600), null, undefined)
  const created = (await db.batches.get(id))!
  assert.equal(created.revision, 1)
  ok('新建批次修订号为 1')

  await saveBatch({ ...created }, id, 1)
  assert.equal((await db.batches.get(id))!.revision, 2)
  ok('先保存的一方修订号 +1')

  await assert.rejects(
    () => saveBatch({ ...created, brix: 99 }, id, 1),
    (err: unknown) => err instanceof RevisionConflictError
  )
  ok('后保存的一方用旧修订号保存被拒绝（RevisionConflictError）')

  await saveBatch({ ...created, brix: 99 }, id, 1, true)
  const afterB = (await db.batches.get(id))!
  assert.equal(afterB.revision, 3)
  assert.equal(afterB.brix, 99)
  ok('强制覆盖成功，未提交内容保留，修订号继续递增')

  await saveBatch({ ...afterB, brix: 24 }, id, 3)
  assert.equal((await db.batches.get(id))!.revision, 4)
  ok('载入最新修订号后保存成功')
}

/* --------------------------- 2. 入罐容量硬校验 ---------------------------- */
{
  const tankB = await makeTank('T-B', 2000)
  await assert.rejects(() => saveBatch(batchDraft(tankB, 2500), null, undefined), /容量/)
  assert.equal(await db.batches.where('tankId').equals(tankB).count(), 0)
  ok('入罐量超过罐容量时入罐被当场拒绝，目标罐无残留批次')
}

/* ----------------------------- 3. 同罐双占 -------------------------------- */
{
  const tankA = await makeTank('T-C', 3000)
  await saveBatch(batchDraft(tankA, 1000), null, undefined)
  await assert.rejects(() => saveBatch(batchDraft(tankA, 1200), null, undefined), /占用/)
  ok('两个窗口把不同批次排进同一个罐时，后到者被拒绝')
}

/* --------------------------- 4. 改小罐容量拒绝 ---------------------------- */
{
  const tankA = await makeTank('T-D', 3000)
  await saveBatch(batchDraft(tankA, 2600), null, undefined)
  const tank = (await db.tanks.get(tankA))!
  await assert.rejects(
    () => saveTank({ ...tank, capacityL: 2000 }, tankA, tank.revision),
    /装不下/
  )
  ok('罐容量改到小于在罐批次入罐量时拒绝')
  await saveTank({ ...tank, capacityL: 4000 }, tankA, tank.revision)
  const grown = (await db.tanks.get(tankA))!
  assert.equal(grown.capacityL, 4000)
  assert.equal(grown.state, '在用')
  ok('罐容量改大成功，罐位占用仍为在用')
}

/* ----------------------------- 4b. 出罐释放 ------------------------------- */
{
  const tankA = await makeTank('T-G', 3000)
  const batchId = await saveBatch(batchDraft(tankA, 2600), null, undefined)
  assert.equal((await db.tanks.get(tankA))!.state, '在用')
  await shipBatch(batchId)
  assert.equal((await db.tanks.get(tankA))!.state, '空闲')
  ok('出罐后罐位按最新占用自动释放为空闲')
}

/* ------------------------- 5. 容量不足排作业被拒 --------------------------- */
{
  const tankA = await makeTank('T-E', 3000)
  const batchId = await saveBatch(batchDraft(tankA, 2600), null, undefined)
  await saveOperation(
    { batchId, type: '倒罐', date: '2026-10-02', durationMin: 40, operator: '甲', state: '计划' },
    null,
    undefined
  )
  ok('容量充足时作业可排入')

  // 直接构造「另一窗口刚把罐容改小」的不一致状态
  await db.tanks.update(tankA, { capacityL: 1000 })
  await assert.rejects(
    () =>
      saveOperation(
        { batchId, type: '压帽', date: '2026-10-03', durationMin: 30, operator: '乙', state: '计划' },
        null,
        undefined
      ),
    /容量/
  )
  ok('罐容量改动后，目标罐容量不够时排程当场拒绝')
}

/* ------------------------- 6. 读数乐观锁与同日唯一 ------------------------- */
{
  const tankA = await makeTank('T-F', 3000)
  const batchId = await saveBatch(batchDraft(tankA, 2600), null, undefined)
  const rid = await saveReading(
    { batchId, date: '2026-10-02', gravity: 1.08, tempC: 24, brix: 20 },
    null,
    undefined
  )
  const r0 = (await db.readings.get(rid))!
  await saveReading({ ...r0, gravity: 1.07 }, rid, 1)
  await assert.rejects(() => saveReading({ ...r0, gravity: 1.0 }, rid, 1), RevisionConflictError)
  ok('读数旧修订号保存被拒，先保存的不被覆盖')

  await assert.rejects(
    () => saveReading({ batchId, date: '2026-10-02', gravity: 1.06, tempC: 24, brix: 19 }, null, undefined),
    /已由其他窗口录入|当日已有/
  )
  ok('两个窗口同时录同一天读数，后者被拒')
}

/* --------------------------- 7. 升级回填 / 待复核 -------------------------- */
{
  db.close()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('gbwinetank-db')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })

  const legacy = new Dexie('gbwinetank-db')
  legacy.version(1).stores({
    parcels: 'id',
    tanks: 'id',
    batches: 'id',
    readings: 'id, batchId',
    operations: 'id',
    mlfs: 'id',
    tastings: 'id'
  })
  await legacy.open()
  const base = Date.now()
  await legacy.table('batches').bulkPut([
    {
      id: 'b',
      parcelId: 'p',
      tankId: '',
      harvestDate: '2026-08-31',
      volumeL: 1000,
      brix: 23,
      state: '酒精发酵',
      lastOperationAt: null,
      createdAt: base - 3000
    }
  ])
  await legacy.table('readings').bulkPut([
    { id: 'old-1', batchId: 'b', date: '2026-09-01', gravity: 1.1, tempC: 24, brix: 24, createdAt: base - 2000 },
    { id: 'old-2', batchId: 'b', date: '2026-09-02', gravity: 1.09, tempC: 24, brix: 22, createdAt: base - 1000 },
    { id: 'old-3', batchId: 'b', date: '2026-09-03', gravity: 1.08, tempC: 24, brix: 20 }
  ])
  legacy.close()

  await db.open()
  const r1 = (await db.readings.get('old-1'))!
  const r2 = (await db.readings.get('old-2'))!
  const r3 = (await db.readings.get('old-3'))!
  assert.equal(r1.revision, 1)
  assert.equal(r2.revision, 2)
  assert.equal(r1.reviewState, REVIEW_NORMAL)
  ok('有创建时间的旧读数按创建先后回填修订号 1、2')
  assert.equal(r3.revision, 0)
  assert.equal(r3.reviewState, REVIEW_PENDING)
  ok('没有创建时间、回填不了的旧读数标记为待复核（revision=0）')

  await saveReading({ ...r3, gravity: 1.07 }, 'old-3', undefined)
  const r3b = (await db.readings.get('old-3'))!
  assert.equal(r3b.reviewState, REVIEW_NORMAL)
  assert.ok(r3b.revision >= 1)
  ok('待复核行人工保存后转正，修订号回到正常序列')
}

console.log(`\n全部通过：${passed} 项`)
db.close()
process.exit(0)
