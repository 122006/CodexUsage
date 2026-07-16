export interface QuotaSlices {
  blue: number
  pale: number
  deep: number
  blank: number
}

function percent(value: number): number { return Math.max(0, Math.min(100, value)) }

export function calculateQuotaSlices(five: number | undefined, week: number | undefined, ratio: number): QuotaSlices {
  const weekRemaining = percent(week ?? 0)
  if (five === undefined) return { blue: weekRemaining, pale: 0, deep: 0, blank: 100 - weekRemaining }

  const fiveRemaining = percent(five)
  const share = percent(ratio) / 100
  const deep = share * fiveRemaining
  const blue = Math.max(0, weekRemaining - deep)
  const paleRequested = share * (100 - fiveRemaining)
  const pale = Math.min(paleRequested, Math.max(0, 100 - blue - deep))
  const blank = Math.max(0, 100 - blue - deep - pale)
  return { blue, pale, deep, blank }
}
