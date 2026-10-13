import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { BarChart3, Check, Clipboard, Copy, Download, ExternalLink, FileText, GripVertical, KeyRound, LogOut, MoreHorizontal, Plus, RefreshCw, Server, Settings, Upload, Wrench, X } from 'lucide-react'
import { API_REASONING_EFFORTS, DEFAULT_API_MODEL, DEFAULT_API_WIRE_API, DEFAULT_MODEL_REASONING_EFFORT, normalizeModelReasoningEffort } from '../../shared/types'
import type { AccountInput, AccountVisibility, AppSnapshot, CpaSettingsInput, DailyTokenUsage, DailyTokenUsageResult, ModelReasoningEffort, OperationMode, PublicAccount, ResetCreditDetail, SubscriptionDetail, UsageResult, UsageWindow } from '../../shared/types'
import { codexUsage } from './bridge'
import { tokenCount } from './token-format'
import { calculateQuotaSlices, quotaSectorPath } from './quota'
import { CpaTrafficBar, useCpaTraffic } from './cpa-traffic'
import type { CpaAccountTraffic } from '../../shared/types'

const empty: AppSnapshot = {
  accounts: [], results: {},
  settings: {
    autoQuerySeconds: 900, showStatusWidget: true, showCpaTraffic: true, operationMode: 'native', cpaBaseUrl: 'http://127.0.0.1:18516',
    cpaModel: DEFAULT_API_MODEL, cpaWireApi: DEFAULT_API_WIRE_API, cpaModelReasoningEffort: DEFAULT_MODEL_REASONING_EFFORT, accountOrder: []
  },
  refreshingIds: [], cpa: { hasManagementSecret: false, hasClientApiKey: false }, logPath: '', codexHome: ''
}
const effortLabels: Record<ModelReasoningEffort, string> = { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' }
const visibilityLabels: Record<AccountVisibility, string> = { both: '两种模式', native: '仅原生', cpa: '仅 CPA' }

function useSnapshot(): AppSnapshot {
  const [value, setValue] = useState(empty)
  useEffect(() => { void codexUsage.getSnapshot().then(setValue); return codexUsage.onSnapshot(setValue) }, [])
  return value
}

function limit(result: UsageResult | undefined, key: '5h' | '7d'): { remaining?: number; resetAt?: number } {
  const items = result?.windows.filter((item) => item.name === key || item.name.endsWith(`:${key}`)) ?? []
  if (!items.length) return {}
  const remaining = Math.min(...items.map((item) => item.remaining))
  return { remaining, resetAt: items.find((item) => item.remaining === remaining)?.resetAt }
}

function percent(value?: number): string { return value === undefined ? '--' : `${value.toFixed(1)}%` }
function resetTime(value?: number, date = false): string {
  if (!value) return '--'
  const current = new Date(value * 1000)
  const time = current.toLocaleTimeString('zh-CN', { hour12: false })
  return date ? `${current.getMonth() + 1}/${current.getDate()} ${time}` : time
}
function shortId(value?: string): string { return value ? (value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value) : '--' }
function displayDate(value?: string): string { return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '--' }
function displaySubscriptionDate(value?: string): string { return value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--' }
function todayKey(): string {
  const now = new Date(); const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
function recentTokenTotal(days: DailyTokenUsage[], count: number): number {
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - count + 1)
  return days.reduce((sum, day) => {
    const date = new Date(`${day.date}T00:00:00`)
    return Number.isFinite(date.getTime()) && date >= start ? sum + day.totalTokens : sum
  }, 0)
}

function QuotaPie({ five, week, ratio, size = 50 }: { five?: number; week?: number; ratio: number; size?: number }): JSX.Element {
  const { blue, pale, deep } = calculateQuotaSlices(five, week, ratio)
  const segments = [{ value: blue, color: '#5aa9ee' }, { value: pale, color: 'rgba(38,197,106,.20)' }, { value: deep, color: '#25bd67' }]
  let offset = 0
  return <svg className="quota-pie" width={size} height={size} viewBox="0 0 42 42" shapeRendering="geometricPrecision" aria-label="额度分布">
    <circle cx="21" cy="21" r="19.5" fill="#eef2f4" />
    {segments.map((item, index) => {
      const start = offset; offset += item.value
      if (item.value <= 0) return null
      return item.value >= 100
        ? <circle key={index} cx="21" cy="21" r="19.5" fill={item.color} />
        : <path key={index} d={quotaSectorPath(start, item.value)} fill={item.color} />
    })}
    <circle cx="21" cy="21" r="19.5" fill="none" stroke="#dce4e7" strokeWidth=".65" />
  </svg>
}

function Spinner({ visible }: { visible: boolean }): JSX.Element | null { return visible ? <RefreshCw className="spinner" size={12} aria-label="刷新中" /> : null }

function Widget({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const account = snapshot.accounts.find((item) => (item.current || item.preferred) && item.accountMode === 'codex')
  if (!account) return <main className="widget-shell widget-empty" aria-hidden="true" />
  const result = account ? snapshot.results[account.id] : undefined
  const five = limit(result, '5h'); const week = limit(result, '7d')
  const loading = Boolean(account && snapshot.refreshingIds.includes(account.id))
  const visibleLimits = [five.remaining !== undefined, week.remaining !== undefined].filter(Boolean).length
  return <main className={`widget-shell limits-${visibleLimits}`}>
    <Spinner visible={loading} />
    <QuotaPie five={five.remaining} week={week.remaining} ratio={account?.fiveHourWeekPercent ?? 16} size={55} />
    <div className="widget-values">
      {five.remaining !== undefined && <div><span>5小时&nbsp; {percent(five.remaining)}</span><time>{resetTime(five.resetAt)}</time></div>}
      {week.remaining !== undefined && <div><span>周限&nbsp; {percent(week.remaining)}</span><time>{resetTime(week.resetAt, true)}</time></div>}
    </div>
  </main>
}

function Modal({ title, children, onClose, width = 520 }: { title: string; children: React.ReactNode; onClose(): void; width?: number }): JSX.Element {
  return <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal" style={{ width }}><header><span>{title}</span><button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button></header>{children}</section></div>
}

function AccountEditor({ account, onClose }: { account?: PublicAccount; onClose(): void }): JSX.Element {
  const [mode, setMode] = useState<'codex' | 'api'>(account?.accountMode ?? 'codex')
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [apiEndpoint, setApiEndpoint] = useState(account?.apiEndpoint ?? '')
  const [apiKey, setApiKey] = useState('')
  const [apiModel, setApiModel] = useState(account?.apiModel ?? DEFAULT_API_MODEL)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [modelsBusy, setModelsBusy] = useState(false); const [modelMessage, setModelMessage] = useState('')
  const autoModelLookup = useRef(false)
  const form = useRef<HTMLFormElement>(null)
  const lookupModels = async (): Promise<void> => {
    if (modelsBusy) return
    setModelsBusy(true); setModelMessage('')
    try {
      const models = await codexUsage.queryApiModels({
        storedAccountId: account?.accountMode === 'api' ? account.id : undefined,
        apiEndpoint,
        apiKey: apiKey || undefined
      })
      setModelOptions(models); setModelMessage(`已读取 ${models.length} 个模型`)
    } catch (reason) {
      const message = String(reason).replace(/^Error: Error invoking remote method '[^']+': Error: /, '')
      setModelOptions([]); setModelMessage(`读取失败：${message}`)
    } finally { setModelsBusy(false) }
  }
  useEffect(() => {
    if (mode !== 'api' || account?.accountMode !== 'api' || !account.hasApiKey || !apiEndpoint || autoModelLookup.current) return
    autoModelLookup.current = true
    void lookupModels()
  }, [mode, account?.id])
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('')
    const data = new FormData(form.current!); const value = (key: string): string => String(data.get(key) ?? '').trim()
    const input: AccountInput = {
      id: account?.id, accountMode: mode, label: value('label'), email: value('email'), accountId: value('accountId'), accessToken: value('accessToken') || undefined,
      apiEndpoint: value('apiEndpoint'), apiKey: value('apiKey') || undefined, apiModel: value('apiModel') || undefined,
      apiWireApi: value('apiWireApi') || undefined,
      modelReasoningEffort: normalizeModelReasoningEffort(value('modelReasoningEffort')),
      modeVisibility: value('modeVisibility') as AccountVisibility,
      fiveHourWeekPercent: Number(value('ratio') || 16)
    }
    try { await codexUsage.saveAccount(input); onClose() } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <Modal title={account ? '编辑账号' : '添加账号'} onClose={onClose}><form ref={form} className="form" onSubmit={(event) => void submit(event)}>
    <div className="segmented"><button type="button" className={mode === 'codex' ? 'active' : ''} onClick={() => setMode('codex')}>Codex 账号</button><button type="button" className={mode === 'api' ? 'active' : ''} onClick={() => setMode('api')}>API 模式</button></div>
    <label><span>备注</span><input name="label" defaultValue={account?.label ?? ''} /></label>
    {mode === 'codex' ? <><label><span>邮箱</span><input name="email" defaultValue={account?.email ?? ''} /></label><label><span>账户 ID</span><input name="accountId" defaultValue={account?.accountId ?? ''} /></label><label><span>Access Token</span><textarea name="accessToken" placeholder={account?.hasAccessToken ? '留空则保留现有 Token' : ''} required={!account?.hasAccessToken} /></label><label><span>5小时占周限</span><div className="suffix"><input name="ratio" type="number" min="0" max="100" step="0.1" defaultValue={account?.fiveHourWeekPercent ?? 16} /><i>%</i></div></label></> : <><label><span>API 端点</span><input name="apiEndpoint" value={apiEndpoint} onChange={(event) => { setApiEndpoint(event.target.value); setModelOptions([]); setModelMessage('') }} required /></label><label><span>API 密钥</span><textarea name="apiKey" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setModelOptions([]); setModelMessage('') }} placeholder={account?.hasApiKey ? '留空则保留现有密钥' : ''} required={!account?.hasApiKey} /></label><label><span>默认模型</span><div className="model-picker"><input name="apiModel" list="api-model-options" value={apiModel} onChange={(event) => setApiModel(event.target.value)} required /><button type="button" className="icon-button model-refresh" onClick={() => void lookupModels()} disabled={modelsBusy || !apiEndpoint.trim() || (!apiKey.trim() && !(account?.accountMode === 'api' && account.hasApiKey))} title="读取模型列表" aria-label="读取模型列表"><RefreshCw size={16} className={modelsBusy ? 'spin-inline' : ''} /></button><datalist id="api-model-options">{modelOptions.map((model) => <option key={model} value={model} />)}</datalist>{modelMessage && <small className={modelMessage.startsWith('读取失败') ? 'lookup-error' : ''}>{modelMessage}</small>}</div></label><label><span>接口协议</span><input name="apiWireApi" defaultValue={account?.apiWireApi ?? DEFAULT_API_WIRE_API} required /></label><label><span>推理强度</span><select name="modelReasoningEffort" defaultValue={account?.modelReasoningEffort ?? DEFAULT_MODEL_REASONING_EFFORT}>{API_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effortLabels[effort]}（{effort}）</option>)}</select></label></>}
    <label><span>使用范围</span><select name="modeVisibility" defaultValue={account?.modeVisibility ?? 'both'}>{(['both', 'native', 'cpa'] as AccountVisibility[]).map((visibility) => <option key={visibility} value={visibility}>{visibilityLabels[visibility]}</option>)}</select></label>
    {error && <p className="error">{error}</p>}<footer><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '保存中' : '保存'}</button></footer>
  </form></Modal>
}

function TransferDialog({ onClose }: { onClose(): void }): JSX.Element {
  const [text, setText] = useState(''); const [status, setStatus] = useState(''); const [selected, setSelected] = useState<string[]>([]); const snapshot = useSnapshot()
  const exportData = async (): Promise<void> => { const value = await codexUsage.exportAccounts(selected.length ? selected : undefined); setText(value); setStatus('已生成导出内容') }
  const importData = async (): Promise<void> => { const result = await codexUsage.importText(text); setStatus(`已导入 ${result.imported} 个账号${result.errors.length ? `；${result.errors.join('；')}` : ''}`) }
  return <Modal title="导入与导出" onClose={onClose} width={650}><div className="transfer-list">{snapshot.accounts.map((account) => <label key={account.id}><input type="checkbox" checked={selected.includes(account.id)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, account.id] : old.filter((id) => id !== account.id))} />{account.email ?? account.apiEndpoint ?? account.accountId ?? '未命名账号'}</label>)}</div><textarea className="transfer-text" value={text} onChange={(event) => setText(event.target.value)} placeholder="导出内容或待导入的多个账号 JSON" />{status && <p className="status-line">{status}</p>}<footer className="dialog-actions"><button onClick={() => void navigator.clipboard.readText().then(setText)}><Clipboard size={15} />读取剪贴板</button><button onClick={() => void exportData()}><Download size={15} />生成导出</button><button onClick={() => void navigator.clipboard.writeText(text)}><Copy size={15} />复制</button><button className="primary" onClick={() => void importData()}><Upload size={15} />导入</button></footer></Modal>
}

function ResetTooltip({ account }: { account: PublicAccount }): JSX.Element {
  const [detail, setDetail] = useState<ResetCreditDetail>(); const [error, setError] = useState('')
  useEffect(() => { void codexUsage.getResetCreditDetail(account.id).then(setDetail).catch((reason) => setError(String(reason))) }, [account.id])
  if (error) return <div className="reset-tooltip">读取失败：{error}</div>
  if (!detail) return <div className="reset-tooltip">读取中...</div>
  return <div className="reset-tooltip"><div>可用次数：{detail.availableCount ?? '--'}</div><div>总计已成功邀请次数：{detail.totalSuccessfulReferrals ?? '--'}</div>{detail.grants.length ? detail.grants.map((item, index) => <div key={index}>获取于：{displayDate(item.grantedAt)}　过期于：{displayDate(item.expiresAt)}</div>) : <div>没有可显示的重置记录</div>}</div>
}

function TokenValue({ value }: { value: number }): JSX.Element {
  return <span title={value.toLocaleString('zh-CN')}>{tokenCount(value)}</span>
}

function TokenUsageDialog({ onClose }: { onClose(): void }): JSX.Element {
  const [result, setResult] = useState<DailyTokenUsageResult>(); const [busy, setBusy] = useState(true); const [error, setError] = useState('')
  const load = async (): Promise<void> => {
    setBusy(true); setError('')
    try { setResult(await codexUsage.getDailyTokenUsage()) } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])
  const today = result?.days.find((day) => day.date === todayKey())?.totalTokens ?? 0
  const recent = result ? recentTokenTotal(result.days, 7) : 0
  return <Modal title="Token 日统计" onClose={onClose} width={900}><div className="token-usage-dialog">
    <div className="token-summary"><div><span>今日</span><strong>{result ? <TokenValue value={today} /> : '--'}</strong></div><div><span>近 7 日</span><strong>{result ? <TokenValue value={recent} /> : '--'}</strong></div><div><span>累计</span><strong>{result ? <TokenValue value={result.totalTokens} /> : '--'}</strong></div></div>
    <div className="token-usage-meta"><span>{busy ? (result ? '正在更新统计...' : '正在建立历史索引，首次扫描可能需要一些时间...') : result ? `已索引 ${result.indexedFiles} 个会话，本次更新 ${result.changedFiles} 个文件，耗时 ${(result.elapsedMs / 1000).toFixed(1)} 秒` : ''}</span><button onClick={() => void load()} disabled={busy}><RefreshCw size={15} className={busy ? 'spin-inline' : ''} />刷新统计</button></div>
    {error && <p className="error token-usage-error">统计失败：{error}</p>}
    {result?.errors.length ? <p className="token-usage-warning">有 {result.errors.length} 项统计校验提示，详情已写入错误日志。</p> : null}
    <div className="token-usage-table-wrap"><table className="token-usage-table"><thead><tr><th>日期</th><th>总 Token</th><th>输入</th><th>缓存输入</th><th>缓存写入</th><th>输出</th><th>推理输出</th><th>调用次数</th></tr></thead><tbody>{result?.days.length ? result.days.map((day) => <tr key={day.date}><td>{day.date}</td><td><TokenValue value={day.totalTokens} /></td><td><TokenValue value={day.inputTokens} /></td><td><TokenValue value={day.cachedInputTokens} /></td><td><TokenValue value={day.cacheWriteInputTokens} /></td><td><TokenValue value={day.outputTokens} /></td><td><TokenValue value={day.reasoningOutputTokens} /></td><td><TokenValue value={day.calls} /></td></tr>) : !busy && <tr><td colSpan={8} className="token-usage-empty">没有找到可统计的 Codex Token 记录</td></tr>}</tbody></table></div>
    <footer className="token-usage-footer"><span>按本机自然日统计；缓存输入已包含在输入 Token 中，不会重复计入总量。</span><span>{result ? `更新于 ${displaySubscriptionDate(result.updatedAt)}` : ''}</span></footer>
  </div></Modal>
}

function CpaSettingsDialog({ snapshot, onClose }: { snapshot: AppSnapshot; onClose(): void }): JSX.Element {
  const [baseUrl, setBaseUrl] = useState(snapshot.settings.cpaBaseUrl)
  const [managementSecret, setManagementSecret] = useState('')
  const [clientApiKey, setClientApiKey] = useState('')
  const [model, setModel] = useState(snapshot.settings.cpaModel)
  const [wireApi, setWireApi] = useState(snapshot.settings.cpaWireApi)
  const [effort, setEffort] = useState(snapshot.settings.cpaModelReasoningEffort)
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState(''); const [error, setError] = useState('')
  const settingsInput = (): CpaSettingsInput => ({
    baseUrl, managementSecret: managementSecret || undefined, clientApiKey: clientApiKey || undefined,
    model, wireApi, modelReasoningEffort: effort
  })
  const save = async (): Promise<void> => {
    setBusy(true); setError(''); setStatus('')
    try { await codexUsage.updateCpaSettings(settingsInput()); setManagementSecret(''); setClientApiKey(''); setStatus('设置已保存，密码和客户端密钥已加密存储') } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  const test = async (): Promise<void> => {
    setBusy(true); setError(''); setStatus('')
    try {
      await codexUsage.updateCpaSettings(settingsInput())
      const result = await codexUsage.testCpaConnection()
      setManagementSecret(''); setClientApiKey('')
      setStatus(`连接成功${result.version ? `，CPA ${result.version}` : ''}；OAuth 凭据 ${result.authFileCount ?? 0} 个，API Provider ${result.apiProviderCount ?? 0} 个`)
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  const sync = async (): Promise<void> => {
    if (!confirm('确定将面板中的账号同步到 CPA 吗？只会新增或更新 CodexUsage 管理的条目。')) return
    setBusy(true); setError(''); setStatus('')
    try {
      await codexUsage.updateCpaSettings(settingsInput())
      const result = await codexUsage.syncCpaAccounts()
      setManagementSecret(''); setClientApiKey('')
      setStatus(`同步完成：OAuth 新增 ${result.oauthAdded}、更新 ${result.oauthUpdated}；API 新增 ${result.apiAdded}、更新 ${result.apiUpdated}`)
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <Modal title="CPA 设置" onClose={onClose} width={610}><div className="form cpa-form">
    <label><span>管理地址</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:18516" /></label>
    <label><span>管理密码</span><div><input type="password" value={managementSecret} onChange={(event) => setManagementSecret(event.target.value)} placeholder={snapshot.cpa.hasManagementSecret ? '已加密保存，留空则不修改' : 'CPA management key'} /><small>{snapshot.cpa.hasManagementSecret ? '已配置' : '未配置'}</small></div></label>
    <label><span>客户端 API Key</span><div><input type="password" value={clientApiKey} onChange={(event) => setClientApiKey(event.target.value)} placeholder={snapshot.cpa.hasClientApiKey ? '已加密保存，留空则不修改' : 'Codex 连接 CPA 使用的 API Key'} /><small>{snapshot.cpa.hasClientApiKey ? '已配置' : '未配置'}</small></div></label>
    <label><span>CPA 默认模型</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
    <label><span>接口协议</span><input value={wireApi} onChange={(event) => setWireApi(event.target.value)} /></label>
    <label><span>推理强度</span><select value={effort} onChange={(event) => setEffort(normalizeModelReasoningEffort(event.target.value))}>{API_REASONING_EFFORTS.map((item) => <option key={item} value={item}>{effortLabels[item]}（{item}）</option>)}</select></label>
    <div className="cpa-security-note">管理密码与客户端密钥仅保存在 Electron 主进程的系统加密存储中，不会进入页面快照或账号导出内容。</div>
    {status && <p className="status-line cpa-result">{status}</p>}{error && <p className="error">{error}</p>}
    <footer><button onClick={() => void sync()} disabled={busy || !snapshot.cpa.hasManagementSecret && !managementSecret.trim()}>同步账号</button><button onClick={() => void test()} disabled={busy}>保存并测试</button><button className="primary" onClick={() => void save()} disabled={busy}>{busy ? '处理中' : '保存'}</button></footer>
  </div></Modal>
}

function SubscriptionTooltip({ account }: { account: PublicAccount }): JSX.Element {
  const [detail, setDetail] = useState<SubscriptionDetail>(); const [error, setError] = useState('')
  useEffect(() => { void codexUsage.getSubscriptionDetail(account.id).then(setDetail).catch((reason) => setError(String(reason))) }, [account.id])
  if (error) return <div className="reset-tooltip subscription-tooltip">读取失败：{error}</div>
  if (!detail) return <div className="reset-tooltip subscription-tooltip">读取中...</div>
  return <div className="reset-tooltip subscription-tooltip">
    <div>订阅状态：{detail.hasActiveSubscription ? '有效' : detail.hasActiveSubscription === false ? '已失效' : '--'}</div>
    <div>权益到期：{displaySubscriptionDate(detail.expiresAt)}</div>
    {detail.cancelsAt && <div>取消生效：{displaySubscriptionDate(detail.cancelsAt)}</div>}
    {detail.renewsAt && <div>预计续订：{displaySubscriptionDate(detail.renewsAt)}</div>}
    <div>自动续订：{detail.willRenew ? '是' : detail.willRenew === false ? '否' : '--'}</div>
    <div>查询于：{displaySubscriptionDate(detail.fetchedAt)}</div>
  </div>
}

function AccountRow({ account, result, traffic, showTraffic, refreshing, operationMode, activeMode, preferred, dragging, onEdit, onDragStart, onDrop }: { account: PublicAccount; result?: UsageResult; traffic?: CpaAccountTraffic; showTraffic: boolean; refreshing: boolean; operationMode: OperationMode; activeMode: OperationMode; preferred: boolean; dragging: boolean; onEdit(): void; onDragStart(): void; onDrop(): void }): JSX.Element {
  const [menu, setMenu] = useState(false); const [tooltip, setTooltip] = useState(false); const [subscriptionTooltip, setSubscriptionTooltip] = useState(false); const [credentialBusy, setCredentialBusy] = useState(false); const five = limit(result, '5h'); const week = limit(result, '7d')
  const planType = (result?.planType ?? (account.accountMode === 'api' ? 'api' : '--')).toLowerCase()
  const canQuerySubscription = account.accountMode === 'codex' && (planType === 'plus' || planType === 'pro')
  const remove = async (): Promise<void> => { if (confirm(`确定删除 ${account.email ?? account.label} 吗？`)) await codexUsage.removeAccount(account.id) }
  const switchTo = async (): Promise<void> => {
    if (!confirm(`确定切换到 ${account.email ?? account.apiEndpoint ?? account.label} 并重启 Codex 吗？`)) return
    try {
      const value = await codexUsage.switchAccount(account.id)
      const details = [`Provider：${value.targetProvider}`, `已同步会话：${value.changedSessions}`, `已同步索引：${value.sqliteProviderRows ?? 0}`]
      if (value.skippedSessions) details.push(`跳过锁定会话：${value.skippedSessions}`)
      if (value.providerSyncFailures) details.push(`同步失败：${value.providerSyncFailures}（详情已写入错误日志）`)
      alert(`${value.message}\n${details.join('\n')}`)
    } catch (error) { alert(`切换失败：${String(error)}`) }
  }
  const refreshCredential = async (): Promise<void> => {
    if (account.accountMode !== 'codex') return
    if (!confirm(`确定刷新 ${account.email ?? account.label} 的 Codex OAuth 凭证吗？\n\n该操作使用 refresh_token 换取新凭证，不会重置额度，也不会消耗额度重置次数。`)) return
    setCredentialBusy(true)
    try {
      const value = await codexUsage.refreshCredential(account.id, operationMode)
      alert(value.message)
    } catch (error) { alert(`刷新凭证失败：${String(error)}`) } finally { setCredentialBusy(false) }
  }
  const importCpaAccount = async (): Promise<void> => {
    if (!confirm(`确定用 CPA 中 ${account.email ?? account.apiEndpoint ?? account.label} 的最新配置覆盖程序内保存的信息吗？\n\n该操作只导回凭据或 API 配置，不会重置额度。`)) return
    setCredentialBusy(true)
    try {
      const value = await codexUsage.importCpaAccount(account.id)
      alert(value.message)
    } catch (error) { alert(`配置导回失败：${String(error)}`) } finally { setCredentialBusy(false) }
  }
  const highlighted = operationMode === 'cpa' ? preferred : account.current
  return <article className={`account-row ${highlighted ? 'current' : ''} ${dragging ? 'dragging' : ''}`} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', account.id); onDragStart() }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }} onDrop={(event) => { event.preventDefault(); onDrop() }} onContextMenu={(event) => { event.preventDefault(); setMenu(true) }}>
    <div className="drag-cell" title="拖拽调整优先级"><GripVertical size={17} /></div>
    <div className="account-cell"><div className="account-label" title={account.label}>{account.label || '未命名账号'}</div><div title={account.email ?? account.apiEndpoint}>{account.email ?? (account.accountMode === 'api' ? account.apiEndpoint : '--')}</div>{account.modeVisibility !== 'both' && <div className="cpa-only">{visibilityLabels[account.modeVisibility]}</div>}</div>
    <div className={`subscription-cell ${canQuerySubscription ? 'queryable' : ''}`} onMouseEnter={() => canQuerySubscription && setSubscriptionTooltip(true)} onMouseLeave={() => setSubscriptionTooltip(false)}>{planType}{subscriptionTooltip && <SubscriptionTooltip account={account} />}</div>
    <div className="quota-cell">{account.accountMode === 'api' && <small className="api-model-label" title={`默认模型：${account.apiModel ?? DEFAULT_API_MODEL}`}>默认模型：{account.apiModel ?? DEFAULT_API_MODEL}</small>}{five.remaining !== undefined && <div><span>5小时&nbsp; {percent(five.remaining)}</span><time>{resetTime(five.resetAt)}</time></div>}{week.remaining !== undefined && <div><span>周限&nbsp; {percent(week.remaining)}</span><time>{resetTime(week.resetAt, true)}</time></div>}{result?.error && <div className="row-error" title={result.error}>{result.error}</div>}</div>
    <div className="reset-cell" onMouseEnter={() => !account.accountMode.includes('api') && setTooltip(true)} onMouseLeave={() => setTooltip(false)}>{result?.resetCredits === undefined ? '--次重置' : `${result.resetCredits}次重置`}{tooltip && <ResetTooltip account={account} />}</div>
    <div className="action-cell">{operationMode === 'cpa' ? (preferred ? <span className="current-label"><Check size={14} />优先使用</span> : <span className="priority-label">拖拽排序</span>) : activeMode !== 'native' ? <span className="priority-label">先切换模式</span> : account.current ? <span className="current-label"><Check size={14} />当前账号</span> : <button className="switch-button" onClick={() => void switchTo()}>切换账号</button>}<button className="icon-button" title="更多操作" onClick={() => setMenu(!menu)}><MoreHorizontal size={18} /></button></div>
    <Spinner visible={refreshing || credentialBusy} />
    {showTraffic && <CpaTrafficBar traffic={traffic} />}
    {menu && <><div className="menu-shield" onClick={() => setMenu(false)} /><div className="row-menu"><button onClick={() => { setMenu(false); void codexUsage.refresh([account.id]) }}><RefreshCw size={14} />刷新额度</button><button disabled={account.accountMode !== 'codex' || credentialBusy} title={account.accountMode === 'codex' ? '使用 refresh_token 刷新 Codex OAuth 凭证，不会重置额度' : 'API Key 账号没有 OAuth 凭证'} onClick={() => { setMenu(false); void refreshCredential() }}><KeyRound size={14} />刷新凭证</button>{operationMode === 'cpa' && <button disabled={credentialBusy} onClick={() => { setMenu(false); void importCpaAccount() }}><Download size={14} />配置导回</button>}<button onClick={() => { setMenu(false); onEdit() }}><Settings size={14} />编辑</button><button className="danger" onClick={() => { setMenu(false); void remove() }}><X size={14} />删除</button></div></>}
  </article>
}

function Panel({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [editor, setEditor] = useState<PublicAccount | 'new'>(); const [transfer, setTransfer] = useState(false); const [cpaSettings, setCpaSettings] = useState(false); const [tokenUsage, setTokenUsage] = useState(false); const [appMenu, setAppMenu] = useState(false); const [notice, setNotice] = useState(''); const [draggedId, setDraggedId] = useState<string>(); const [viewMode, setViewMode] = useState<OperationMode>('native')
  useEffect(() => { setViewMode(snapshot.settings.operationMode) }, [snapshot.settings.operationMode])
  const visibleAccounts = useMemo(() => snapshot.accounts.filter((account) => account.modeVisibility === 'both' || account.modeVisibility === viewMode), [snapshot.accounts, viewMode])
  const preferredId = viewMode === 'cpa' ? visibleAccounts[0]?.id : undefined
  const [showCpaTraffic, setShowCpaTraffic] = useState(snapshot.settings.showCpaTraffic ?? true)
  useEffect(() => { setShowCpaTraffic(snapshot.settings.showCpaTraffic ?? true) }, [snapshot.settings.showCpaTraffic])
  const showTraffic = viewMode === 'cpa' && showCpaTraffic
  const traffic = useCpaTraffic(snapshot, showTraffic)
  const [trafficSaving, setTrafficSaving] = useState(false)
  const toggleCpaTraffic = async (show: boolean): Promise<void> => {
    const previous = showCpaTraffic
    setShowCpaTraffic(show)
    setTrafficSaving(true)
    try { await codexUsage.updateSettings({ showCpaTraffic: show }) }
    catch (error) { setShowCpaTraffic(previous); setNotice(`流量图显示设置保存失败：${String(error)}`) }
    finally { setTrafficSaving(false) }
  }
  const allRefreshing = snapshot.refreshingIds.length > 0
  const installHook = async (): Promise<void> => { try { const path = await codexUsage.installHook(); setNotice(`Hook 已写入：${path}`) } catch (error) { setNotice(`Hook 安装失败：${String(error)}`) } }
  const launchCodex = async (): Promise<void> => { try { await codexUsage.openCodex(); setNotice('已发送打开 Codex 请求') } catch (error) { setNotice(`打开 Codex 失败：${String(error)}`) } }
  const repairSessions = async (): Promise<void> => { setNotice('正在检查 Codex 会话...'); try { const repaired = await codexUsage.repairCodexSessions(); setNotice(repaired ? `检查完成，已修复 ${repaired} 条异常会话路径` : '检查完成，未发现需要修复的 Codex 会话') } catch (error) { setNotice(`Codex 会话修复失败：${String(error)}`) } }
  const changeMode = async (mode: OperationMode): Promise<void> => {
    if (mode === snapshot.settings.operationMode) return
    const label = mode === 'cpa' ? 'CPA 模式会先同步账号和优先级，然后修改 Codex 配置并重启。确定继续吗？' : '原生模式会恢复上次使用的原生账号并重启 Codex。确定继续吗？'
    if (!confirm(label)) return
    setNotice(`正在切换到${mode === 'cpa' ? ' CPA' : '原生'}模式...`)
    try { const result = await codexUsage.setOperationMode(mode); setNotice(result.message) } catch (error) { setNotice(`模式切换失败：${String(error)}`) }
  }
  const dropAccount = async (targetId: string): Promise<void> => {
    const sourceId = draggedId; setDraggedId(undefined)
    if (!sourceId || sourceId === targetId) return
    const visibleIds = visibleAccounts.map((account) => account.id)
    const from = visibleIds.indexOf(sourceId); const to = visibleIds.indexOf(targetId)
    if (from < 0 || to < 0) return
    visibleIds.splice(to, 0, visibleIds.splice(from, 1)[0])
    const visibleSet = new Set(visibleIds); let visibleIndex = 0
    const ids = snapshot.accounts.map((account) => visibleSet.has(account.id) ? visibleIds[visibleIndex++] : account.id)
    const appliesNow = snapshot.settings.operationMode === 'cpa'
    setNotice(appliesNow ? '正在更新 CPA 优先级...' : '正在保存账号顺序...')
    try { await codexUsage.reorderAccounts(ids); setNotice(appliesNow ? 'CPA 优先级已更新，新任务将优先使用排在前面的账号' : viewMode === 'cpa' ? 'CPA 账号顺序已保存，切换到 CPA 模式时生效' : '账号顺序已保存') } catch (error) { setNotice(`排序失败：${String(error)}`) }
  }
  return <main className="panel-shell">
    <header className="topbar"><div><h1>Codex 额度</h1><span>{visibleAccounts.length} / {snapshot.accounts.length} 个账号</span></div><nav><button title="打开 Codex" onClick={() => void launchCodex()}><ExternalLink size={16} />打开 Codex</button><button title="导入当前 Codex" disabled={snapshot.settings.operationMode === 'cpa'} onClick={() => void codexUsage.importCurrent()}><Download size={16} />导入当前 Codex</button><button title="导入与导出" onClick={() => setTransfer(true)}><Upload size={16} />导入与导出</button><button className="primary" onClick={() => setEditor('new')}><Plus size={16} />添加账号</button><button className="icon-button" title="菜单" onClick={() => setAppMenu(!appMenu)}><MoreHorizontal size={20} /></button>{appMenu && <><div className="menu-shield" onClick={() => setAppMenu(false)} /><div className="app-menu">
      <label className="menu-checkbox"><input type="checkbox" checked={showCpaTraffic} disabled={trafficSaving} onChange={(event) => void toggleCpaTraffic(event.target.checked)} />显示流量图</label>
      <button onClick={() => { setAppMenu(false); setTokenUsage(true) }}><BarChart3 size={14} />Token 日统计</button><button onClick={() => { setAppMenu(false); setCpaSettings(true) }}><Server size={14} />CPA 设置</button><button onClick={() => { setAppMenu(false); void codexUsage.openBrowser() }}><ExternalLink size={14} />在浏览器中打开</button><button onClick={() => { setAppMenu(false); void repairSessions() }}><Wrench size={14} />修复 Codex 会话</button><button onClick={() => { setAppMenu(false); void installHook() }}>安装完成刷新 Hook</button><button onClick={() => { setAppMenu(false); void codexUsage.openLog() }}><FileText size={14} />打开错误日志</button><button onClick={() => { setAppMenu(false); void codexUsage.openLogDirectory() }}>打开日志目录</button><button className="danger" onClick={() => void codexUsage.quit()}><LogOut size={14} />退出程序</button></div></>}</nav></header>
    <section className="controls"><div className="mode-switch"><button className={viewMode === 'native' ? 'active' : ''} onClick={() => { setViewMode('native'); setDraggedId(undefined) }}>原生模式</button><button className={viewMode === 'cpa' ? 'active' : ''} onClick={() => { setViewMode('cpa'); setDraggedId(undefined) }}>CPA 模式</button></div>{viewMode !== snapshot.settings.operationMode && <button className="apply-mode-button" onClick={() => void changeMode(viewMode)}>立即切换到{viewMode === 'cpa' ? ' CPA' : '原生'}模式</button>}<button className="refresh-button" disabled={allRefreshing} onClick={() => void codexUsage.refresh()}><RefreshCw size={16} className={allRefreshing ? 'spin-inline' : ''} />{allRefreshing ? '刷新中' : '刷新全部'}</button><label>自动查询间隔<input type="number" min="0" max="86400" value={snapshot.settings.autoQuerySeconds} onChange={(event) => void codexUsage.updateSettings({ autoQuerySeconds: Number(event.target.value) })} /><span>秒</span></label><label className="toggle"><input type="checkbox" checked={snapshot.settings.showStatusWidget} onChange={(event) => void codexUsage.updateSettings({ showStatusWidget: event.target.checked })} /><i />显示状态小工具</label></section>
    <section className="account-list"><div className="list-header"><span /><span>备注 / 邮箱</span><span>订阅</span><span>5小时 / 周限</span><span>重置</span><span>操作</span></div>{visibleAccounts.length ? visibleAccounts.map((account) => <AccountRow key={account.id} account={account} result={snapshot.results[account.id]} traffic={traffic[account.id]} showTraffic={showTraffic} refreshing={snapshot.refreshingIds.includes(account.id)} operationMode={viewMode} activeMode={snapshot.settings.operationMode} preferred={account.id === preferredId} dragging={draggedId === account.id} onDragStart={() => setDraggedId(account.id)} onDrop={() => void dropAccount(account.id)} onEdit={() => setEditor(account)} />) : <div className="empty-state">该模式下暂无账号</div>}</section>
    <footer className="statusbar"><span>总计：Plus 周限剩余平均值 {percent(snapshot.plusWeekAverage)}</span>{notice && <span className="notice" title={notice}>{notice}</span>}<span>数据存储于本机</span></footer>
    {editor && <AccountEditor account={editor === 'new' ? undefined : editor} onClose={() => setEditor(undefined)} />}{transfer && <TransferDialog onClose={() => setTransfer(false)} />}{cpaSettings && <CpaSettingsDialog snapshot={snapshot} onClose={() => setCpaSettings(false)} />}{tokenUsage && <TokenUsageDialog onClose={() => setTokenUsage(false)} />}
  </main>
}

export function App(): JSX.Element { const snapshot = useSnapshot(); return new URLSearchParams(location.search).get('window') === 'widget' ? <Widget snapshot={snapshot} /> : <Panel snapshot={snapshot} /> }
