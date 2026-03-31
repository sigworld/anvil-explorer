import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { route } from 'preact-router'
import { getResolvedAddressLabel } from '../lib/db.ts'
import { formatNumber, formatTimestamp, shortenHex } from '../lib/format.ts'
import { resolveSearchTarget } from '../lib/search.ts'
import {
  applyThemePreference,
  getStoredThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from '../lib/theme.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import type { AddressKind, DecodedEvent } from '../lib/types.ts'

const LOCATION_CHANGE_EVENT = 'codex-location-change'

function notifyLocationChange() {
  window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT))
}

function navigate(event: MouseEvent, path: string) {
  event.preventDefault()
  route(path)
  notifyLocationChange()
}

export function AppLink(props: {
  active?: boolean
  className?: string
  path: string
  title?: string
  children: ComponentChildren
}) {
  return (
    <a
      href={props.path}
      class={`${props.className ?? ''} ${props.active ? 'is-active' : ''}`.trim()}
      title={props.title}
      onClick={(event) => navigate(event, props.path)}
    >
      {props.children}
    </a>
  )
}

function NavIcon(props: { name: 'overview' | 'blocks' | 'transactions' | 'accounts' | 'contracts' | 'logs' | 'abis' | 'controls' }) {
  const iconProps = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    viewBox: '0 0 20 20',
  }

  switch (props.name) {
    case 'overview':
      return (
        <svg aria-hidden="true" {...iconProps}>
          <path d="M3 11.5 10 4l7 7.5" />
          <path d="M5.5 9.5V16h9V9.5" />
        </svg>
      )
    case 'blocks':
      return (
        <svg aria-hidden="true" {...iconProps}>
          <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.2" />
          <rect x="11" y="3.5" width="5.5" height="5.5" rx="1.2" />
          <rect x="3.5" y="11" width="5.5" height="5.5" rx="1.2" />
          <rect x="11" y="11" width="5.5" height="5.5" rx="1.2" />
        </svg>
      )
    case 'transactions':
      return (
        <svg aria-hidden="true" {...iconProps}>
          <path d="M4 6h10" />
          <path d="M11 3l3 3-3 3" />
          <path d="M16 14H6" />
          <path d="M9 11l-3 3 3 3" />
        </svg>
      )
    case 'accounts':
      return (
        <svg aria-hidden="true" {...iconProps}>
          <circle cx="10" cy="6.5" r="2.6" />
          <path d="M4.2 16a5.8 5.8 0 0 1 11.6 0" />
        </svg>
      )
    case 'contracts':
      return (
        <svg aria-hidden="true" {...iconProps}>
          <path d="M10 2.8 4 6.2v7.6l6 3.4 6-3.4V6.2l-6-3.4Z" />
          <path d="M10 2.8v7.1" />
          <path d="m4 6.2 6 3.7 6-3.7" />
        </svg>
      )
    case 'logs':
      return (
        <svg aria-hidden="true" {...iconProps}>
          <path d="M5 4h10" />
          <path d="M5 8h10" />
          <path d="M5 12h10" />
          <path d="M5 16h7" />
        </svg>
      )
    case 'abis':
      return (
        <svg aria-hidden="true" {...iconProps}>
          <path d="M6 4h8l3 3v9.5A1.5 1.5 0 0 1 15.5 18h-9A1.5 1.5 0 0 1 5 16.5v-11A1.5 1.5 0 0 1 6.5 4Z" />
          <path d="M14 4v4h4" />
          <path d="M8 11h4" />
          <path d="M8 14h6" />
        </svg>
      )
    case 'controls':
      return (
        <svg aria-hidden="true" {...iconProps}>
          <circle cx="10" cy="10" r="2.6" />
          <path d="M10 3.2v2.1" />
          <path d="M10 14.7v2.1" />
          <path d="m5.2 5.2 1.5 1.5" />
          <path d="m13.3 13.3 1.5 1.5" />
          <path d="M3.2 10h2.1" />
          <path d="M14.7 10h2.1" />
          <path d="m5.2 14.8 1.5-1.5" />
          <path d="m13.3 6.7 1.5-1.5" />
        </svg>
      )
  }
}

export function CopyButton(props: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  async function handleClick() {
    if (!navigator.clipboard) {
      return
    }

    await navigator.clipboard.writeText(props.value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <button
      type="button"
      class={`copy-button ${copied ? 'copy-button-copied' : ''}`.trim()}
      onClick={handleClick}
      title={copied ? `${props.label} copied` : `Copy ${props.label}`}
      aria-label={copied ? `${props.label} copied` : `Copy ${props.label}`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <rect x="5" y="3" width="8" height="10" rx="1.5" />
        <path d="M3 10.5V5.5A1.5 1.5 0 0 1 4.5 4H9" />
      </svg>
    </button>
  )
}

export function AppShell(props: { children: ComponentChildren }) {
  const { actions, chainMeta, error, rpcUrl, setRpcUrl, stats, status, statusMessage } = useExplorer()
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const [rpcDraft, setRpcDraft] = useState(rpcUrl)
  const [searchValue, setSearchValue] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => getStoredThemePreference())
  const [isStatusExpanded, setIsStatusExpanded] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    () => window.localStorage.getItem('sidebar-collapsed') === '1',
  )

  useEffect(() => {
    setRpcDraft(rpcUrl)
  }, [rpcUrl])

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference)
    applyThemePreference(themePreference)
  }, [themePreference])

  useEffect(() => {
    function syncPath() {
      setPathname(window.location.pathname)
    }

    window.addEventListener('popstate', syncPath)
    window.addEventListener(LOCATION_CHANGE_EVENT, syncPath)

    return () => {
      window.removeEventListener('popstate', syncPath)
      window.removeEventListener(LOCATION_CHANGE_EVENT, syncPath)
    }
  }, [])

  function isActive(path: string) {
    return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`)
  }

  async function handleSearchSubmit(event: Event) {
    event.preventDefault()
    setSearchError(null)

    const target = await resolveSearchTarget(searchValue)

    if (!target) {
      setSearchError('No matching block, tx, or address in IndexedDB')
      return
    }

    if (target.type === 'block') {
      route(`/blocks/${target.number}`)
      notifyLocationChange()
      return
    }

    if (target.type === 'transaction') {
      route(`/tx/${target.hash}`)
      notifyLocationChange()
      return
    }

    route(`/address/${target.address}`)
    notifyLocationChange()
  }

  function handleRpcSubmit(event: Event) {
    event.preventDefault()
    setRpcUrl(rpcDraft.trim())
    actions.reconnect()
  }

  const navItems: Array<{
    icon: Parameters<typeof NavIcon>[0]['name']
    label: string
    path: string
    summary: string
  }> = [
    { icon: 'overview', label: 'Overview', path: '/', summary: 'Failures, leaders, recent activity' },
    { icon: 'blocks', label: 'Blocks', path: '/blocks', summary: 'Recent indexed block data' },
    { icon: 'transactions', label: 'Transactions', path: '/transactions', summary: 'Hash, method, status, sender' },
    { icon: 'accounts', label: 'Accounts', path: '/accounts', summary: 'Discovered wallet activity' },
    { icon: 'contracts', label: 'Contracts', path: '/contracts', summary: 'Discovered contracts and ABI state' },
    { icon: 'logs', label: 'Logs', path: '/logs', summary: 'Indexed events and topics' },
    { icon: 'abis', label: 'ABIs', path: '/abis', summary: 'Decoder storage and sync' },
    { icon: 'controls', label: 'Config', path: '/controls', summary: 'Mine, snapshot, reset' },
  ]

  const live = status === 'ready' || status === 'syncing'
  const themeOptions: Array<{ value: ThemePreference; icon: string; label: string }> = [
    { value: 'light', icon: '☼', label: 'Day' },
    { value: 'dark', icon: '☾', label: 'Night' },
  ]
  const statusTableId = 'sidebar-status-table'

  return (
    <div class={`app-shell ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`.trim()}>
      <aside class="shell-sidebar">
        <section class="sidebar-card sidebar-summary">
          <div class="sidebar-card-header">
            <p class="eyebrow">Chain State</p>
            <div class="theme-switch" role="group" aria-label="Color theme">
              {themeOptions.map((option) => (
                <button
                  type="button"
                  class={`theme-switch-option ${themePreference === option.value ? 'is-active' : ''}`.trim()}
                  onClick={() => setThemePreference(option.value)}
                  aria-pressed={themePreference === option.value}
                  title={`${option.label} theme`}
                  aria-label={`${option.label} theme`}
                >
                  <span aria-hidden="true">{option.icon}</span>
                </button>
              ))}
            </div>
          </div>
          <div class="sidebar-status">
            <div class="sidebar-status-header">
              <p class="eyebrow">Status</p>
              <div class="sidebar-status-actions">
                <div class="status-cluster">
                  {live && (
                    <span class="live-badge">
                      <span class="live-dot" />
                      Live
                    </span>
                  )}
                  <StatusPill status={status} />
                </div>
                <button
                  type="button"
                  class={`sidebar-status-toggle ${isStatusExpanded ? 'is-expanded' : ''}`.trim()}
                  onClick={() => setIsStatusExpanded((current) => !current)}
                  aria-expanded={isStatusExpanded}
                  aria-controls={statusTableId}
                  aria-label={isStatusExpanded ? 'Collapse status details' : 'Expand status details'}
                  title={isStatusExpanded ? 'Collapse status details' : 'Expand status details'}
                >
                  <svg aria-hidden="true" viewBox="0 0 16 16">
                    <path d="m4.5 6.5 3.5 3 3.5-3" />
                  </svg>
                </button>
              </div>
            </div>
            <div id={statusTableId} class="sidebar-status-details" hidden={!isStatusExpanded}>
              <div class="sidebar-status-table" role="table" aria-label="Chain and indexed state">
                <div class="sidebar-status-row" role="row">
                  <span class="sidebar-status-label" role="rowheader">Network</span>
                  <strong role="cell">{chainMeta ? 'Anvil' : 'Unavailable'}</strong>
                </div>
                <div class="sidebar-status-row" role="row">
                  <span class="sidebar-status-label" role="rowheader">Chain ID</span>
                  <strong role="cell">{chainMeta ? String(chainMeta.chainId) : 'n/a'}</strong>
                </div>
                <div class="sidebar-status-row" role="row">
                  <span class="sidebar-status-label" role="rowheader">Head</span>
                  <strong role="cell">{chainMeta ? formatNumber(chainMeta.latestBlockNumber) : 'n/a'}</strong>
                </div>
                <div class="sidebar-status-row" role="row">
                  <span class="sidebar-status-label" role="rowheader">Indexed</span>
                  <strong role="cell">{chainMeta ? formatNumber(chainMeta.latestIndexedBlock) : 'n/a'}</strong>
                </div>
                <div class="sidebar-status-row" role="row">
                  <span class="sidebar-status-label" role="rowheader">Blocks</span>
                  <strong role="cell">{formatNumber(stats.blockCount)}</strong>
                </div>
                <div class="sidebar-status-row" role="row">
                  <span class="sidebar-status-label" role="rowheader">Txs</span>
                  <strong role="cell">{formatNumber(stats.transactionCount)}</strong>
                </div>
                <div class="sidebar-status-row" role="row">
                  <span class="sidebar-status-label" role="rowheader">Logs</span>
                  <strong role="cell">{formatNumber(stats.logCount)}</strong>
                </div>
              </div>
            </div>
            <p class="status-copy">{statusMessage}</p>
          </div>
        </section>

        <nav class="nav-tabs" aria-label="Primary">
          {navItems.map((item) => (
            <AppLink active={isActive(item.path)} className="nav-link" path={item.path}>
              <span class="nav-link-icon">
                <NavIcon name={item.icon} />
              </span>
              <span class="nav-link-copy">
                <span class="nav-link-label">{item.label}</span>
                <span class="nav-link-summary">{item.summary}</span>
              </span>
            </AppLink>
          ))}
        </nav>

        <section class="sidebar-card sidebar-summary">
          <p class="eyebrow">Endpoint</p>
          <form class="sidebar-endpoint-form" onSubmit={handleRpcSubmit}>
            <label>
              <span class="field-label">RPC URL</span>
              <input
                value={rpcDraft}
                onInput={(event) => setRpcDraft(event.currentTarget.value)}
                placeholder="http://127.0.0.1:8545"
              />
            </label>
            <button type="submit">Reconnect</button>
          </form>
        </section>
      </aside>

      <div class="app-main">
        <header class="topbar">
          <button
            type="button"
            class="sidebar-collapse-toggle"
            onClick={() => {
              setIsSidebarCollapsed((c) => {
                window.localStorage.setItem('sidebar-collapsed', c ? '0' : '1')
                return !c
              })
            }}
            aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <rect x="2" y="1" width="2.5" height="14" rx="1" fill="currentColor" stroke="none" />
              <path d="M13 4 8.5 8l4.5 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <form class="toolbar-form toolbar-form-search" onSubmit={handleSearchSubmit}>
            <label>
              <input
                aria-label="Search explorer"
                value={searchValue}
                onInput={(event) => setSearchValue(event.currentTarget.value)}
                placeholder="Block, tx hash, block hash, address"
              />
            </label>
            <button type="submit">Search</button>
          </form>
        </header>

        {(error || searchError) && <section class="banner error-banner">{error ?? searchError}</section>}

        <main class="page-grid">{props.children}</main>
      </div>
    </div>
  )
}

export function PageSection(props: {
  className?: string
  title: string
  description?: ComponentChildren
  actions?: ComponentChildren
  children: ComponentChildren
}) {
  return (
    <section class={props.className ? `panel ${props.className}` : 'panel'}>
      <div class="panel-header">
        <div class="section-header-copy">
          <h2 class="section-title">{props.title}</h2>
          {props.description && <p class="section-description">{props.description}</p>}
        </div>
        {props.actions}
      </div>
      {props.children}
    </section>
  )
}

export function StatCard(props: { label: string; value: string; note?: string }) {
  return (
    <article class="stat-card">
      <p class="eyebrow">{props.label}</p>
      <strong>{props.value}</strong>
      {props.note && <span class="muted">{props.note}</span>}
    </article>
  )
}

export function StatusPill(props: { status: string }) {
  return <span class={`status-pill status-${props.status}`}>{props.status}</span>
}

export function AddressKindBadge(props: { kind: AddressKind | null | undefined }) {
  if (!props.kind) {
    return <span class="address-kind address-kind-unknown">unknown</span>
  }

  return <span class={`address-kind address-kind-${props.kind}`}>{props.kind}</span>
}

export function TransactionKindBadge(props: { kind: string }) {
  return <span class="meta-badge meta-kind">{props.kind}</span>
}

export function TransactionStatusBadge(props: { status: 'success' | 'failed' | 'pending' | 'unknown' }) {
  return <span class={`meta-badge meta-status meta-status-${props.status}`}>{props.status}</span>
}

export function TransactionEnvelopeBadge(props: { envelope: string }) {
  return <span class="meta-badge meta-envelope">{props.envelope}</span>
}

export function MethodLabel(props: {
  method: string
  selector?: string | null
  className?: string
  methodClassName?: string
  methodStyle?: Record<string, string>
}) {
  return (
    <span class={`tx-method-inline ${props.className ?? ''}`.trim()}>
      <span class={props.methodClassName} style={props.methodStyle}>
        {props.method}
      </span>
      <span class="muted mono">({props.selector ?? '0x'})</span>
    </span>
  )
}

export function EmptyState(props: { title: string; body: string }) {
  return (
    <div class="empty-state">
      <strong class="empty-state-title">{props.title}</strong>
      <p class="empty-state-body">{props.body}</p>
    </div>
  )
}

export function LoadingState(props: { label?: string }) {
  return (
    <div class="loading-state" aria-busy="true" aria-live="polite">
      <div class="loading-skeleton loading-skeleton-title" />
      <div class="loading-skeleton" />
      <div class="loading-skeleton loading-skeleton-short" />
      <p class="muted">{props.label ?? 'Loading…'}</p>
    </div>
  )
}

export function ErrorState(props: { message: string }) {
  return <p class="error-copy">{props.message}</p>
}

export function AddressLink(props: { address: string | null }) {
  const { refreshKey } = useExplorer()
  const label = useAsyncResource(
    async () => (props.address ? getResolvedAddressLabel(props.address) : null),
    [props.address, refreshKey],
    null,
  )

  if (!props.address) {
    return <span class="mono">n/a</span>
  }

  const labelText = label.data

  return (
    <span class="address-link-stack">
      {labelText ? (
        <>
          <AppLink className="address-link-primary" path={`/address/${props.address}`} title={props.address}>
            {labelText}
          </AppLink>
          <span class="address-link-row">
            <span class="address-link-secondary muted mono" title={props.address}>
              {shortenHex(props.address)}
            </span>
            <span class="address-link-copy">
              <CopyButton value={props.address} label="address" />
            </span>
          </span>
        </>
      ) : (
        <span class="address-link-row">
          <AppLink className="address-link-primary" path={`/address/${props.address}`} title={props.address}>
            {shortenHex(props.address)}
          </AppLink>
          <span class="address-link-copy">
            <CopyButton value={props.address} label="address" />
          </span>
        </span>
      )}
    </span>
  )
}

export function TxLink(props: { hash: string }) {
  return (
    <AppLink className="mono" path={`/tx/${props.hash}`} title={props.hash}>
      {shortenHex(props.hash)}
    </AppLink>
  )
}

export function BlockLink(props: { number: number | null }) {
  if (props.number === null) {
    return <span class="mono">n/a</span>
  }

  return (
    <AppLink className="mono" path={`/blocks/${props.number}`}>
      #{formatNumber(props.number)}
    </AppLink>
  )
}

export function KeyValueGrid(props: { items: Array<{ label: string; value: ComponentChildren }> }) {
  return (
    <dl class="kv-grid">
      {props.items.map((item) => (
        <>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </>
      ))}
    </dl>
  )
}

export function JsonView(props: { value: unknown }) {
  return (
    <pre class="json-view">
      {JSON.stringify(
        props.value,
        (_, current) => (typeof current === 'bigint' ? current.toString() : current),
        2,
      )}
    </pre>
  )
}

export function LogDataValue(props: { decoded?: DecodedEvent | null; raw: string; dataOnly?: boolean }) {
  const visibleArgs = props.dataOnly
    ? props.decoded?.args.filter((arg) => !arg.indexed) ?? []
    : props.decoded?.args ?? []

  return (
    <div class="log-data-cell">
      {visibleArgs.length > 0 ? (
        <ul class="decoded-list log-decoded-list">
          {visibleArgs.map((arg) => (
            <li key={`${arg.name}-${arg.value}`}>
              <span class="decoded-arg-name">{arg.name}</span>
              <code class="decoded-arg-value">{arg.value}</code>
            </li>
          ))}
        </ul>
      ) : (
        <span class="mono">{props.raw}</span>
      )}
    </div>
  )
}

export function LogDecodePopup(props: { decoded?: DecodedEvent | null; trigger: ComponentChildren }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const [popupStyle, setPopupStyle] = useState<Record<string, string> | null>(null)
  const hasDecodedArgs = Boolean(props.decoded && props.decoded.args.length > 0)

  useEffect(() => {
    if (!open) {
      setPopupStyle(null)
      return
    }

    function updatePosition() {
      if (!rootRef.current || !popupRef.current) {
        return
      }

      const gap = 8
      const margin = 12
      const triggerRect = rootRef.current.getBoundingClientRect()
      const popupRect = popupRef.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - triggerRect.bottom - margin
      const spaceAbove = triggerRect.top - margin
      const showAbove = spaceBelow < popupRect.height + gap && spaceAbove > spaceBelow

      const left = Math.min(
        Math.max(margin, triggerRect.left),
        window.innerWidth - popupRect.width - margin,
      )
      const top = showAbove
        ? Math.max(margin, triggerRect.top - popupRect.height - gap)
        : Math.min(window.innerHeight - popupRect.height - margin, triggerRect.bottom + gap)

      setPopupStyle({
        left: `${left}px`,
        top: `${top}px`,
      })
    }

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    updatePosition()
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  if (!hasDecodedArgs) {
    return <div>{props.trigger}</div>
  }

  return (
    <div ref={rootRef} class={`log-data-popup-wrap ${open ? 'is-open' : ''}`.trim()}>
      <button
        type="button"
        class="log-data-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={open ? 'Hide decoded log fields' : 'Show decoded log fields'}
        title={open ? 'Hide decoded fields' : 'Click to decode'}
      >
        {props.trigger}
      </button>
      {open && props.decoded && (
        <div
          ref={popupRef}
          class="log-data-popup log-data-popup-floating"
          role="dialog"
          aria-label="Decoded log data"
          style={popupStyle ?? { visibility: 'hidden' }}
        >
          <p class="log-data-popup-title">{props.decoded.signature}</p>
          <ul class="decoded-list log-decoded-list">
            <li>
              <span class="decoded-arg-name">event</span>
              <code class="decoded-arg-value">{props.decoded.eventName}</code>
            </li>
            {props.decoded.args.map((arg) => (
              <li key={`${arg.name}-${arg.value}`}>
                <span class="decoded-arg-name">
                  {arg.name}
                  {!arg.indexed && <span class="decoded-arg-source">data</span>}
                </span>
                <code class="decoded-arg-value">{arg.value}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function SummaryTable(props: {
  headers: ComponentChildren[]
  className?: string
  children: ComponentChildren
}) {
  return (
    <div class={`table-wrap ${props.className ?? ''}`.trim()}>
      <table>
        <thead>
          <tr>
            {props.headers.map((header) => (
              <th>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  )
}

export function FoundryAbiTips() {
  return (
    <div class="info-panel">
      <p class="eyebrow">Forge ABI Tips</p>
      <p class="muted">
        Run <code>forge build</code>. Forge artifacts are typically written to{' '}
        <code>out/&lt;Contract&gt;.sol/&lt;Contract&gt;.json</code>.
      </p>
      <p class="muted">
        You can paste either the raw ABI array or the full Forge artifact JSON object from that file.
      </p>
      <p class="muted">
        If you only want the ABI array, extract it with{' '}
        <code>jq '.abi' out/MyContract.sol/MyContract.json</code>.
      </p>
      <p class="muted">
        Deployment outputs under <code>broadcast/</code> are not ABI artifacts. Use the files under <code>out/</code>.
      </p>
    </div>
  )
}

export const formatters = {
  number: formatNumber,
  timestamp: formatTimestamp,
}
