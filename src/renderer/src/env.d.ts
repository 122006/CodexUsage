import type { LocalBridge } from '../../shared/types'

declare global { interface Window { codexUsage: LocalBridge } }
export {}
