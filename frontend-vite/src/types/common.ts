/** Normalized bounding box [x0, y0, x1, y1] in 0-1 range */
export type BoundingBox = [number, number, number, number]

export interface PaginationParams {
  page?: number
  pageSize?: number
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}
