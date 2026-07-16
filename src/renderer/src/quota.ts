export interface QuotaSlices {
  blue: number
  pale: number
  deep: number
  blank: number
}

export function quotaSectorPath(startPercent: number, valuePercent: number, center = 21, radius = 19.5): string {
  const start = Math.max(0, Math.min(100, startPercent))
  const value = Math.max(0, Math.min(100 - start, valuePercent))
  if (value <= 0 || value >= 100) return ''
  const point = (percent: number): [number, number] => {
    const angle = percent / 100 * Math.PI * 2 - Math.PI / 2
    return [center + radius * Math.cos(angle), center + radius * Math.sin(angle)]
  }
  const [startX, startY] = point(start)
  const [endX, endY] = point(start + value)
  return `M ${center} ${center} L ${startX} ${startY} A ${radius} ${radius} 0 ${value > 50 ? 1 : 0} 1 ${endX} ${endY} Z`
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
