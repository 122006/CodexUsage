import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Check, Clipboard, Copy, Download, ExternalLink, FileText, LogOut, MoreHorizontal, Plus, RefreshCw, Settings, Upload, X } from 'lucide-react'
import { API_REASONING_EFFORTS, DEFAULT_API_MODEL, DEFAULT_API_WIRE_API, DEFAULT_MODEL_REASONING_EFFORT, normalizeModelReasoningEffort } from '../../shared/types'
import type { AccountInput, AppSnapshot, ModelReasoningEffort, PublicAccount, ResetCreditDetail, UsageResult, UsageWindow } from '../../shared/types'
import { calculateQuotaSlices, quotaSectorPath } from './quota'

const empty: AppSnapshot = { accounts: [], results: {}, settings: { autoQuerySeconds: 900, showStatusWidget: true }, refreshingIds: [], logPath: '', codexHome: '' }
const effortLabels: Record<ModelReasoningEffort, string> = { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' }

function useSnapshot(): AppSnapshot {
  const [value, setValue] = useState(empty)
  useEffect(() => { void window.codexUsage.getSnapshot().then(setValue); return window.codexUsage.onSnapshot(setValue) }, [])
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
  const account = snapshot.accounts.find((item) => item.current && item.accountMode === 'codex')
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
      const models = await window.codexUsage.queryApiModels({
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
      fiveHourWeekPercent: Number(value('ratio') || 16)
    }
    try { await window.codexUsage.saveAccount(input); onClose() } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <Modal title={account ? '编辑账号' : '添加账号'} onClose={onClose}><form ref={form} className="form" onSubmit={(event) => void submit(event)}>
    <div className="segmented"><button type="button" className={mode === 'codex' ? 'active' : ''} onClick={() => setMode('codex')}>Codex 账号</button><button type="button" className={mode === 'api' ? 'active' : ''} onClick={() => setMode('api')}>API 模式</button></div>
    <label><span>备注</span><input name="label" defaultValue={account?.label ?? ''} /></label>
    {mode === 'codex' ? <><label><span>邮箱</span><input name="email" defaultValue={account?.email ?? ''} /></label><label><span>账户 ID</span><input name="accountId" defaultValue={account?.accountId ?? ''} /></label><label><span>Access Token</span><textarea name="accessToken" placeholder={account?.hasAccessToken ? '留空则保留现有 Token' : ''} required={!account?.hasAccessToken} /></label><label><span>5小时占周限</span><div className="suffix"><input name="ratio" type="number" min="0" max="100" step="0.1" defaultValue={account?.fiveHourWeekPercent ?? 16} /><i>%</i></div></label></> : <><label><span>API 端点</span><input name="apiEndpoint" value={apiEndpoint} onChange={(event) => { setApiEndpoint(event.target.value); setModelOptions([]); setModelMessage('') }} required /></label><label><span>API 密钥</span><textarea name="apiKey" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setModelOptions([]); setModelMessage('') }} placeholder={account?.hasApiKey ? '留空则保留现有密钥' : ''} required={!account?.hasApiKey} /></label><label><span>模型</span><div className="model-picker"><input name="apiModel" list="api-model-options" value={apiModel} onChange={(event) => setApiModel(event.target.value)} required /><button type="button" className="icon-button model-refresh" onClick={() => void lookupModels()} disabled={modelsBusy || !apiEndpoint.trim() || (!apiKey.trim() && !(account?.accountMode === 'api' && account.hasApiKey))} title="读取模型列表" aria-label="读取模型列表"><RefreshCw size={16} className={modelsBusy ? 'spin-inline' : ''} /></button><datalist id="api-model-options">{modelOptions.map((model) => <option key={model} value={model} />)}</datalist>{modelMessage && <small className={modelMessage.startsWith('读取失败') ? 'lookup-error' : ''}>{modelMessage}</small>}</div></label><label><span>接口协议</span><input name="apiWireApi" defaultValue={account?.apiWireApi ?? DEFAULT_API_WIRE_API} required /></label><label><span>推理强度</span><select name="modelReasoningEffort" defaultValue={account?.modelReasoningEffort ?? DEFAULT_MODEL_REASONING_EFFORT}>{API_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effortLabels[effort]}（{effort}）</option>)}</select></label></>}
    {error && <p className="error">{error}</p>}<footer><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '保存中' : '保存'}</button></footer>
  </form></Modal>
}

function TransferDialog({ onClose }: { onClose(): void }): JSX.Element {
  const [text, setText] = useState(''); const [status, setStatus] = useState(''); const [selected, setSelected] = useState<string[]>([]); const snapshot = useSnapshot()
  const exportData = async (): Promise<void> => { const value = await window.codexUsage.exportAccounts(selected.length ? selected : undefined); setText(value); setStatus('已生成导出内容') }
  const importData = async (): Promise<void> => { const result = await window.codexUsage.importText(text); setStatus(`已导入 ${result.imported} 个账号${result.errors.length ? `；${result.errors.join('；')}` : ''}`) }
  return <Modal title="导入与导出" onClose={onClose} width={650}><div className="transfer-list">{snapshot.accounts.map((account) => <label key={account.id}><input type="checkbox" checked={selected.includes(account.id)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, account.id] : old.filter((id) => id !== account.id))} />{account.email ?? account.apiEndpoint ?? account.accountId ?? '未命名账号'}</label>)}</div><textarea className="transfer-text" value={text} onChange={(event) => setText(event.target.value)} placeholder="导出内容或待导入的多个账号 JSON" />{status && <p className="status-line">{status}</p>}<footer className="dialog-actions"><button onClick={() => void navigator.clipboard.readText().then(setText)}><Clipboard size={15} />读取剪贴板</button><button onClick={() => void exportData()}><Download size={15} />生成导出</button><button onClick={() => void navigator.clipboard.writeText(text)}><Copy size={15} />复制</button><button className="primary" onClick={() => void importData()}><Upload size={15} />导入</button></footer></Modal>
}

function ResetTooltip({ account }: { account: PublicAccount }): JSX.Element {
  const [detail, setDetail] = useState<ResetCreditDetail>(); const [error, setError] = useState('')
  useEffect(() => { void window.codexUsage.getResetCreditDetail(account.id).then(setDetail).catch((reason) => setError(String(reason))) }, [account.id])
  if (error) return <div className="reset-tooltip">读取失败：{error}</div>
  if (!detail) return <div className="reset-tooltip">读取中...</div>
  return <div className="reset-tooltip"><div>可用次数：{detail.availableCount ?? '--'}</div><div>总计已成功邀请次数：{detail.totalSuccessfulReferrals ?? '--'}</div>{detail.grants.length ? detail.grants.map((item, index) => <div key={index}>获取于：{displayDate(item.grantedAt)}　过期于：{displayDate(item.expiresAt)}</div>) : <div>没有可显示的重置记录</div>}</div>
}

function AccountRow({ account, result, refreshing, onEdit }: { account: PublicAccount; result?: UsageResult; refreshing: boolean; onEdit(): void }): JSX.Element {
  const [menu, setMenu] = useState(false); const [tooltip, setTooltip] = useState(false); const five = limit(result, '5h'); const week = limit(result, '7d')
  const remove = async (): Promise<void> => { if (confirm(`确定删除 ${account.email ?? account.label} 吗？`)) await window.codexUsage.removeAccount(account.id) }
  const switchTo = async (): Promise<void> => { if (!confirm(`确定切换到 ${account.email ?? account.apiEndpoint ?? account.label} 并重启 Codex 吗？`)) return; try { const value = await window.codexUsage.switchAccount(account.id); const warning = value.encryptedRiskFiles ? `\n${value.encryptedRiskFiles} 个会话包含加密内容。` : ''; alert(`${value.message}\n已同步 ${value.changedSessions} 个会话。${warning}`) } catch (error) { alert(`切换失败：${String(error)}`) } }
  return <article className={`account-row ${account.current ? 'current' : ''}`} onContextMenu={(event) => { event.preventDefault(); setMenu(true) }}>
    <div className="account-cell"><div className="account-label" title={account.label}>{account.label || '未命名账号'}</div><div title={account.email ?? account.apiEndpoint}>{account.email ?? (account.accountMode === 'api' ? account.apiEndpoint : '--')}</div></div>
    <div className="subscription-cell">{(result?.planType ?? (account.accountMode === 'api' ? 'api' : '--')).toLowerCase()}</div>
    <div className="quota-cell">{five.remaining !== undefined && <div><span>5小时&nbsp; {percent(five.remaining)}</span><time>{resetTime(five.resetAt)}</time></div>}{week.remaining !== undefined && <div><span>周限&nbsp; {percent(week.remaining)}</span><time>{resetTime(week.resetAt, true)}</time></div>}{result?.error && <div className="row-error" title={result.error}>{result.error}</div>}</div>
    <div className="reset-cell" onMouseEnter={() => !account.accountMode.includes('api') && setTooltip(true)} onMouseLeave={() => setTooltip(false)}>{result?.resetCredits === undefined ? '--次重置' : `${result.resetCredits}次重置`}{tooltip && <ResetTooltip account={account} />}</div>
    <div className="action-cell">{account.current ? <span className="current-label"><Check size={14} />当前账号</span> : <button className="switch-button" onClick={() => void switchTo()}>切换账号</button>}<button className="icon-button" title="更多操作" onClick={() => setMenu(!menu)}><MoreHorizontal size={18} /></button></div>
    <Spinner visible={refreshing} />
    {menu && <><div className="menu-shield" onClick={() => setMenu(false)} /><div className="row-menu"><button onClick={() => { setMenu(false); void window.codexUsage.refresh([account.id]) }}><RefreshCw size={14} />刷新</button><button onClick={() => { setMenu(false); onEdit() }}><Settings size={14} />编辑</button><button className="danger" onClick={() => { setMenu(false); void remove() }}><X size={14} />删除</button></div></>}
  </article>
}

function Panel({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [editor, setEditor] = useState<PublicAccount | 'new'>(); const [transfer, setTransfer] = useState(false); const [appMenu, setAppMenu] = useState(false); const [notice, setNotice] = useState('')
  const allRefreshing = snapshot.refreshingIds.length > 0
  const installHook = async (): Promise<void> => { try { const path = await window.codexUsage.installHook(); setNotice(`Hook 已写入：${path}`) } catch (error) { setNotice(`Hook 安装失败：${String(error)}`) } }
  const launchCodex = async (): Promise<void> => { try { await window.codexUsage.openCodex(); setNotice('已发送打开 Codex 请求') } catch (error) { setNotice(`打开 Codex 失败：${String(error)}`) } }
  return <main className="panel-shell">
    <header className="topbar"><div><h1>Codex 额度</h1><span>{snapshot.accounts.length} 个账号</span></div><nav><button title="打开 Codex" onClick={() => void launchCodex()}><ExternalLink size={16} />打开 Codex</button><button title="导入当前 Codex" onClick={() => void window.codexUsage.importCurrent()}><Download size={16} />导入当前 Codex</button><button title="导入与导出" onClick={() => setTransfer(true)}><Upload size={16} />导入与导出</button><button className="primary" onClick={() => setEditor('new')}><Plus size={16} />添加账号</button><button className="icon-button" title="菜单" onClick={() => setAppMenu(!appMenu)}><MoreHorizontal size={20} /></button>{appMenu && <><div className="menu-shield" onClick={() => setAppMenu(false)} /><div className="app-menu"><button onClick={() => { setAppMenu(false); void installHook() }}>安装完成刷新 Hook</button><button onClick={() => { setAppMenu(false); void window.codexUsage.openLog() }}><FileText size={14} />打开错误日志</button><button onClick={() => { setAppMenu(false); void window.codexUsage.openLogDirectory() }}>打开日志目录</button><button className="danger" onClick={() => void window.codexUsage.quit()}><LogOut size={14} />退出程序</button></div></>}</nav></header>
    <section className="controls"><button className="refresh-button" disabled={allRefreshing} onClick={() => void window.codexUsage.refresh()}><RefreshCw size={16} className={allRefreshing ? 'spin-inline' : ''} />{allRefreshing ? '刷新中' : '刷新全部'}</button><label>自动查询间隔<input type="number" min="0" max="86400" value={snapshot.settings.autoQuerySeconds} onChange={(event) => void window.codexUsage.updateSettings({ autoQuerySeconds: Number(event.target.value) })} /><span>秒</span></label><label className="toggle"><input type="checkbox" checked={snapshot.settings.showStatusWidget} onChange={(event) => void window.codexUsage.updateSettings({ showStatusWidget: event.target.checked })} /><i />显示状态小工具</label></section>
    <section className="account-list"><div className="list-header"><span>备注 / 邮箱</span><span>订阅</span><span>5小时 / 周限</span><span>重置</span><span>操作</span></div>{snapshot.accounts.length ? snapshot.accounts.map((account) => <AccountRow key={account.id} account={account} result={snapshot.results[account.id]} refreshing={snapshot.refreshingIds.includes(account.id)} onEdit={() => setEditor(account)} />) : <div className="empty-state">暂无账号</div>}</section>
    <footer className="statusbar"><span>总计：Plus 周限剩余平均值 {percent(snapshot.plusWeekAverage)}</span>{notice && <span className="notice" title={notice}>{notice}</span>}<span>数据存储于本机</span></footer>
    {editor && <AccountEditor account={editor === 'new' ? undefined : editor} onClose={() => setEditor(undefined)} />}{transfer && <TransferDialog onClose={() => setTransfer(false)} />}
  </main>
}

export function App(): JSX.Element { const snapshot = useSnapshot(); return new URLSearchParams(location.search).get('window') === 'widget' ? <Widget snapshot={snapshot} /> : <Panel snapshot={snapshot} /> }
