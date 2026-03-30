export function getTailWindowOffset(totalLines: number, limit: number): number {
  if (!Number.isFinite(totalLines) || totalLines <= 0) {
    return 0;
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(totalLines) - Math.floor(limit));
}
