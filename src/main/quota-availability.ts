function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function rateHasQuota(value: unknown): boolean {
  const rate = record(value)
  if (rate?.allowed !== true || rate.limit_reached !== false) return false
  const windows = [rate.primary_window, rate.secondary_window].filter((window) => window != null)
  return windows.length > 0 && windows.every((value) => {
    const window = record(value)
    return typeof window?.used_percent === 'number' && window.used_percent >= 0 && window.used_percent < 100 &&
      typeof window.limit_window_seconds === 'number' && Number.isFinite(window.limit_window_seconds) && window.limit_window_seconds > 0
  })
}

// Clearing CPA credential cooldowns also clears model cooldowns, so fail closed on any reported limit.
export function quotaAllowsRecovery(payload: Record<string, unknown>): boolean {
  if (!rateHasQuota(payload.rate_limit) || payload.rate_limit_reached_type != null) return false
  for (const key of ['additional_rate_limits', 'rate_limits']) {
    const limits = payload[key]
    if (limits == null) continue
    if (!Array.isArray(limits) || !limits.every((limit) => rateHasQuota(record(limit)?.rate_limit ?? limit))) return false
  }
  if (payload.model_usage != null) {
    const models = record(payload.model_usage)
    if (!models || !Object.values(models).every((model) => record(model)?.available === true)) return false
  }
  return true
}
