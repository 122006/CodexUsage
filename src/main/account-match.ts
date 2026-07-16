import type { Account, AccountMode } from '../shared/types'

export interface CurrentAuthState {
  accountId?: string
  email?: string
  mode?: AccountMode
  apiKey?: string
  apiEndpoint?: string
}

function endpoint(value?: string): string { return (value ?? '').trim().replace(/\/+$/, '').toLowerCase() }

export function findCurrentAccountId(accounts: Account[], current: CurrentAuthState): string | undefined {
  if (current.mode === 'api') {
    const normalizedEndpoint = endpoint(current.apiEndpoint)
    const matches = accounts.filter((account) => account.accountMode === 'api' &&
      (!current.apiKey || account.apiKey === current.apiKey) &&
      (!normalizedEndpoint || endpoint(account.apiEndpoint) === normalizedEndpoint))
    return matches.length === 1 ? matches[0].id : undefined
  }
  if (current.mode !== 'codex') return undefined
  return accounts.find((account) => account.accountMode === 'codex' && (
    (current.accountId && current.accountId === account.accountId) ||
    (current.email && account.email && current.email.toLowerCase() === account.email.toLowerCase())
  ))?.id
}
