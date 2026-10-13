export function tokenCount(value: number): string {
  if (!Number.isFinite(value)) return '--'
  const magnitude = Math.abs(value)
  if (magnitude >= 1_000_000_000) return `${(value / 100_000_000).toFixed(2)}E`
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(0)}M`
  return String(Number(value.toFixed(2)))
}
