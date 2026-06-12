import { clamp01, normalizeBox } from './geometry'
import type { BoundingBox } from '../types'

/** Minimum width enforced for alignment bounds, in normalized coordinates. */
const MIN_WIDTH = 0.01

/** A box-like object used in payloads (e.g. question/answer boxes). */
interface BoxPayload {
  bbox?: BoundingBox | number[]
  [key: string]: unknown
}

/** X-axis alignment bounds: [x0, x1] in [0, 1]. */
export type AlignBounds = [number, number]

/** Map of paperId -> AlignBounds. */
export type PaperAlignRef = Record<string, AlignBounds | undefined>

// ---------------------------------------------------------------------------
// Bounds computation
// ---------------------------------------------------------------------------

/**
 * Compute the union X-axis alignment bounds from an array of box payloads.
 * Returns null if no valid boxes are found.
 */
export function computeUnionAlignBoundsFromBoxesPayload(boxesPayload: BoxPayload[] | null | undefined): AlignBounds | null {
  const arr = Array.isArray(boxesPayload) ? boxesPayload : []
  let minX0: number | null = null
  let maxX1: number | null = null
  for (const b of arr) {
    const bb = b?.bbox || (b as unknown as number[])
    const x0 = (bb as number[])?.[0]
    const x1 = (bb as number[])?.[2]
    if (typeof x0 !== 'number' || !Number.isFinite(x0) || typeof x1 !== 'number' || !Number.isFinite(x1)) continue
    minX0 = minX0 == null ? x0 : Math.min(minX0, x0)
    maxX1 = maxX1 == null ? x1 : Math.max(maxX1, x1)
  }
  if (minX0 == null || maxX1 == null) return null
  const nx0 = clamp01(minX0)
  const nx1 = clamp01(maxX1)
  if (nx1 - nx0 < MIN_WIDTH) return [nx0, clamp01(nx0 + MIN_WIDTH)]
  return [nx0, nx1]
}

// ---------------------------------------------------------------------------
// Alignment application
// ---------------------------------------------------------------------------

/**
 * Align all boxes in a payload to the given X-axis bounds.
 * Each box's x0 and x1 are replaced with the bounds; y values are preserved.
 */
export function alignBoxesPayloadToBoundsX(boxesPayload: BoxPayload[] | null | undefined, bounds: AlignBounds | null | undefined): BoxPayload[] {
  if (!bounds) return boxesPayload ?? []
  const nx0 = clamp01(bounds[0])
  const nx1 = clamp01(bounds[1])
  const x0 = nx0
  const x1 = Math.max(nx1, nx0 + MIN_WIDTH)
  return (boxesPayload ?? []).map((b) => {
    const bb = b?.bbox
    if (!Array.isArray(bb) || bb.length !== 4) return b
    return { ...b, bbox: normalizeBox([x0, bb[1], x1, bb[3]] as BoundingBox) }
  })
}

/**
 * Align answer boxes to X-axis bounds (convenience variant).
 */
export function alignAnswerBoxesPayloadToBoundsX(boxes: BoxPayload[] | null | undefined, bounds: AlignBounds | null | undefined): BoxPayload[] {
  if (!bounds) return boxes ?? []
  const x0 = clamp01(bounds[0])
  const x1 = clamp01(bounds[1])
  return (boxes ?? []).map((b) => {
    const bb = b?.bbox
    if (!Array.isArray(bb) || bb.length !== 4) return b
    return { ...b, bbox: normalizeBox([x0, bb[1], Math.max(x1, x0 + MIN_WIDTH), bb[3]] as BoundingBox) }
  })
}

/**
 * Align a single answer bounding box to X-axis bounds.
 * Returns the original bbox if bounds are invalid or bbox is not 4 elements.
 */
export function alignAnswerBBoxToBoundsX(bbox: BoundingBox | number[] | null | undefined, bounds: AlignBounds | null | undefined): BoundingBox | number[] | null | undefined {
  if (!bounds || !Array.isArray(bbox) || bbox.length !== 4) return bbox
  const x0 = clamp01(bounds[0])
  const x1 = clamp01(bounds[1])
  return normalizeBox([x0, bbox[1], Math.max(x1, x0 + MIN_WIDTH), bbox[3]] as BoundingBox)
}

/**
 * Apply alignment to all new answer boxes at once.
 */
export function applyAnswerAlignToAllNewBoxes(answerNewBoxes: BoxPayload[] | null | undefined, bounds: AlignBounds | null | undefined): BoxPayload[] {
  if (!bounds) return answerNewBoxes ?? []
  return (answerNewBoxes ?? []).map((b) => ({
    ...b,
    bbox: alignAnswerBBoxToBoundsX(b.bbox as BoundingBox, bounds) as BoundingBox,
  }))
}

// ---------------------------------------------------------------------------
// Paper-align-ref helpers (immutable updates)
// ---------------------------------------------------------------------------

/**
 * Get the stored alignment bounds for a paper.
 * Returns null if no valid bounds are stored.
 */
export function getPaperAlignBounds(paperAlignRef: PaperAlignRef | null | undefined, paperId: number | null | undefined): AlignBounds | null {
  if (paperId == null) return null
  const key = String(paperId)
  const v = paperAlignRef?.[key]
  const x0 = v?.[0]
  const x1 = v?.[1]
  if (typeof x0 !== 'number' || !Number.isFinite(x0) || typeof x1 !== 'number' || !Number.isFinite(x1)) return null
  return [clamp01(x0), clamp01(x1)]
}

/**
 * If no alignment bounds exist for the given paper yet, derive them from a
 * single bounding box's x0/x1.  Returns a new ref object (immutable).
 */
export function ensurePaperAlignRefFromBox(
  paperAlignRef: PaperAlignRef | null | undefined,
  paperId: number | null | undefined,
  bbox: BoundingBox | number[] | null | undefined,
): PaperAlignRef {
  if (paperId == null) return paperAlignRef ?? {}
  const key = String(paperId)
  const next: PaperAlignRef = paperAlignRef && typeof paperAlignRef === 'object' ? { ...paperAlignRef } : {}
  if (next[key]) return next
  const x0 = (bbox as number[])?.[0]
  const x1 = (bbox as number[])?.[2]
  if (typeof x0 !== 'number' || !Number.isFinite(x0) || typeof x1 !== 'number' || !Number.isFinite(x1)) return next
  next[key] = [clamp01(x0), clamp01(x1)]
  return next
}

/**
 * If no alignment bounds exist for the given paper yet, derive them from
 * the union of all box payloads.  Returns a new ref object (immutable).
 */
export function ensurePaperAlignRefFromBoxes(
  paperAlignRef: PaperAlignRef | null | undefined,
  paperId: number | null | undefined,
  boxesPayload: BoxPayload[] | null | undefined,
): PaperAlignRef {
  if (paperId == null) return paperAlignRef ?? {}
  const key = String(paperId)
  const next: PaperAlignRef = paperAlignRef && typeof paperAlignRef === 'object' ? { ...paperAlignRef } : {}
  if (next[key]) return next
  const bounds = computeUnionAlignBoundsFromBoxesPayload(boxesPayload)
  if (!bounds) return next
  next[key] = [bounds[0], bounds[1]]
  return next
}

/**
 * Get temporary alignment bounds from the first box in a new-boxes array.
 * Useful when no persistent alignment ref has been established yet.
 */
export function getTempAlignBoundsFromFirstNewBox(newBoxes: BoxPayload[] | null | undefined): AlignBounds | null {
  const first = (newBoxes ?? []).find(
    (b) => b && Array.isArray(b.bbox) && b.bbox.length === 4,
  )
  if (!first) return null
  const bb = first.bbox as number[]
  return [clamp01(bb[0]), clamp01(bb[2])]
}

/**
 * Get the active alignment bounds for a paper: persistent ref first,
 * falling back to temporary bounds derived from new boxes.
 */
export function getActivePaperAlignBounds(
  paperAlignRef: PaperAlignRef | null | undefined,
  paperId: number | null | undefined,
  newBoxes: BoxPayload[] | null | undefined,
): AlignBounds | null {
  return getPaperAlignBounds(paperAlignRef, paperId) || getTempAlignBoundsFromFirstNewBox(newBoxes)
}
