/**
 * 行级复核状态。
 * 升级时若一条旧数据既缺修订号又没有可用的创建时间，无法按创建时间回填，
 * 就先标成「待复核」；该记录被人工打开并成功保存一次后自动转为「正常」。
 */
export type ReviewState = '正常' | '待复核'

export const REVIEW_NORMAL: ReviewState = '正常'
export const REVIEW_PENDING: ReviewState = '待复核'

/** 待复核行的占位修订号：与正常递增的修订号（≥1）区分开 */
export const UNREVIEWED_REVISION = 0

export function isPendingReview(row: { reviewState?: ReviewState } | undefined | null): boolean {
  return row?.reviewState === REVIEW_PENDING
}
