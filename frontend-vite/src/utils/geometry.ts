import type { BoundingBox } from '../types'

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(text: unknown): string {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Extract season code and year from an exam filename.
 * Example: "9709_s25_qp_15.pdf" -> { season: 's', year: '25' }
 */
export function extractYearSeason(text: string): { season: string | null; year: string | null } {
  const m = String(text || '').match(/_(m|s|w)(\d{2})_/i)
  if (!m) return { season: null, year: null }
  return { season: m[1].toLowerCase(), year: m[2] }
}

/**
 * Clamp a number to the [0, 1] range.
 */
export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/**
 * Normalize a bounding box so that x0 <= x1 and y0 <= y1,
 * then clamp all values to [0, 1].
 */
export function normalizeBox(box: BoundingBox): BoundingBox {
  const [x0, y0, x1, y1] = box
  const nx0 = Math.min(x0, x1)
  const nx1 = Math.max(x0, x1)
  const ny0 = Math.min(y0, y1)
  const ny1 = Math.max(y0, y1)
  return [clamp01(nx0), clamp01(ny0), clamp01(nx1), clamp01(ny1)]
}

/**
 * Test whether a point (x, y) lies inside a bounding box.
 */
export function pointInBox(x: number, y: number, bbox: BoundingBox): boolean {
  const [x0, y0, x1, y1] = bbox
  return x >= x0 && x <= x1 && y >= y0 && y <= y1
}

/**
 * Parse a value as an integer, clamped to [min, max].
 * Returns `min` if parsing fails.
 */
export function clampInt(v: unknown, min: number, max: number): number {
  const i = parseInt(String(v), 10)
  if (isNaN(i)) return min
  return Math.max(min, Math.min(max, i))
}
