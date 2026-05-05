import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

interface FsEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified: number
  ext: string
}

interface Listing {
  path: string
  parent: string | null
  entries: FsEntry[]
}

interface Shortcut {
  name: string
  path: string
}

interface CcResult {
  action: string
  input: string
  output: string
  stdout: string
  stderr: string
  success: boolean
}

interface HistoryEntry extends CcResult { id: number }

type SortKey = 'name' | 'size' | 'modified'
type SortDir = 'asc' | 'desc'

interface Progress { i: number; n: number; current: string }

type OverwriteChoice = 'replace' | 'skip' | 'replace_all' | 'skip_all' | 'cancel'
type StickyChoice = 'replace_all' | 'skip_all' | null

interface OutputCheck { predicted: string; exists: boolean }

type LockMode = 'none' | 'fused' | 'timed' | 'delayed'

let entryId = 0

export default function App() {
  const [listing, setListing] = useState<Listing | null>(null)
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([])
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [expandedHistory, setExpandedHistory] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [password, setPassword] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' })
  const [overwritePrompt, setOverwritePrompt] = useState<{ name: string; resolve: (c: OverwriteChoice) => void } | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)

  const askOverwrite = useCallback((name: string) =>
    new Promise<OverwriteChoice>((resolve) => setOverwritePrompt({ name, resolve })),
  [])
  const resolveOverwrite = useCallback((choice: OverwriteChoice) => {
    setOverwritePrompt((cur) => { cur?.resolve(choice); return null })
  }, [])

  const cwd = listing?.path ?? ''

  const refresh = useCallback(async (path: string, selectAfter?: string) => {
    setError(null)
    try {
      const l = await invoke<Listing>('list_dir', { path, showHidden })
      setListing(l)
      setPathInput(l.path)
      if (selectAfter && l.entries.some((e) => e.path === selectAfter)) {
        setSelection(new Set([selectAfter]))
        setAnchor(selectAfter)
      } else {
        setSelection(new Set())
        setAnchor(null)
      }
    } catch (e) {
      setError(String(e))
    }
  }, [showHidden])

  // Initial load
  useEffect(() => {
    invoke<Shortcut[]>('common_dirs').then(setShortcuts).catch(() => {})
    invoke<string>('home_dir').then((h) => void refresh(h)).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-list when showHidden toggles
  useEffect(() => {
    if (cwd) void refresh(cwd)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden])

  const navigate = useCallback((path: string) => { void refresh(path) }, [refresh])
  const goUp = useCallback(() => {
    if (listing?.parent) void refresh(listing.parent)
  }, [listing, refresh])

  // Sort transform — directories always first, then by selected key.
  const sortedListing = useMemo<Listing | null>(() => {
    if (!listing) return null
    const dirMul = sort.dir === 'asc' ? 1 : -1
    const entries = [...listing.entries].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
      let cmp = 0
      if (sort.key === 'name') cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      else if (sort.key === 'size') cmp = a.size - b.size
      else cmp = a.modified - b.modified
      return cmp * dirMul
    })
    return { ...listing, entries }
  }, [listing, sort])

  const cycleSort = useCallback((key: SortKey) => {
    setSort((s) => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  }, [])

  // Selection handling — sortedListing is what the user sees, so range-select
  // anchoring uses that order.
  const onItemClick = useCallback((entry: FsEntry, ev: React.MouseEvent) => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (ev.metaKey || ev.ctrlKey) {
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
      } else if (ev.shiftKey && anchor && sortedListing) {
        next.clear()
        const paths = sortedListing.entries.map((e) => e.path)
        const a = paths.indexOf(anchor)
        const b = paths.indexOf(entry.path)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          for (let i = lo; i <= hi; i++) next.add(paths[i])
        } else {
          next.add(entry.path)
        }
      } else {
        next.clear()
        next.add(entry.path)
      }
      return next
    })
    if (!ev.shiftKey) setAnchor(entry.path)
  }, [anchor, sortedListing])

  const onItemOpen = useCallback(async (entry: FsEntry) => {
    if (entry.is_dir) { void refresh(entry.path); return }
    setBusy(true)
    setProgress({ i: 1, n: 1, current: entry.name })
    try {
      const actionKey = entry.path.toLowerCase().endsWith('.cute') ? 'decompress' : 'compress'
      const check = await invoke<OutputCheck>('cc_check_output', { action: actionKey, input: entry.path })
      if (check.exists) {
        const choice = await askOverwrite(basename(check.predicted))
        if (choice === 'cancel' || choice === 'skip' || choice === 'skip_all') {
          setHistory((h) => [{
            id: ++entryId, action: actionKey, input: entry.path, output: '',
            stdout: '', stderr: `skipped: would overwrite ${basename(check.predicted)}`, success: false,
          }, ...h].slice(0, 50))
          return
        }
      }
      const res = await invoke<CcResult>('cc_auto', { path: entry.path })
      setHistory((h) => [{ ...res, id: ++entryId }, ...h].slice(0, 50))
      const selectAfter = res.success && res.output ? res.output : undefined
      await refresh(cwd, selectAfter)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [cwd, refresh, askOverwrite])

  const selectedFiles = useMemo(() => {
    if (!listing) return [] as FsEntry[]
    return listing.entries.filter((e) => selection.has(e.path) && !e.is_dir)
  }, [listing, selection])

  const runOnSelection = useCallback(async (action: 'compress' | 'decompress' | 'lock' | 'unlock' | 'auto') => {
    if (selectedFiles.length === 0) return
    if ((action === 'lock' || action === 'unlock') && !password) {
      setError('Password required for lock / unlock.')
      return
    }
    setError(null)
    setBusy(true)
    let lastOutput: string | undefined
    let sticky: StickyChoice = null
    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        const f = selectedFiles[i]
        setProgress({ i: i + 1, n: selectedFiles.length, current: f.name })
        const actionKey =
          action === 'auto'
            ? (f.path.toLowerCase().endsWith('.cute') ? 'decompress' : 'compress')
            : action

        const check = await invoke<OutputCheck>('cc_check_output', { action: actionKey, input: f.path })
        let proceed = true
        if (check.exists) {
          if (sticky === 'replace_all') proceed = true
          else if (sticky === 'skip_all') proceed = false
          else {
            const choice = await askOverwrite(basename(check.predicted))
            if (choice === 'cancel') break
            if (choice === 'skip') proceed = false
            else if (choice === 'replace') proceed = true
            else if (choice === 'replace_all') { sticky = 'replace_all'; proceed = true }
            else if (choice === 'skip_all') { sticky = 'skip_all'; proceed = false }
          }
        }
        if (!proceed) {
          setHistory((h) => [{
            id: ++entryId, action: actionKey, input: f.path, output: '',
            stdout: '', stderr: `skipped: would overwrite ${basename(check.predicted)}`, success: false,
          }, ...h].slice(0, 50))
          continue
        }

        const cmd =
          action === 'auto' ? 'cc_auto' :
          action === 'compress' ? 'cc_compress' :
          action === 'decompress' ? 'cc_decompress' :
          action === 'lock' ? 'cc_lock' : 'cc_unlock'
        const args: Record<string, string> =
          (action === 'lock' || action === 'unlock')
            ? { path: f.path, password }
            : { path: f.path }
        const res = await invoke<CcResult>(cmd, args)
        setHistory((h) => [{ ...res, id: ++entryId }, ...h].slice(0, 50))
        if (res.success && res.output) lastOutput = res.output
      }
      await refresh(cwd, lastOutput)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [selectedFiles, password, cwd, refresh, askOverwrite])

  const runArchive = useCallback(async (params: {
    output: string; password?: string; lockMode: LockMode; lockValue?: number
  }) => {
    if (selectedFiles.length === 0) return
    setError(null)
    const exists = await invoke<boolean>('cc_path_exists', { path: params.output })
    if (exists) {
      const choice = await askOverwrite(basename(params.output))
      if (choice !== 'replace' && choice !== 'replace_all') return
    }
    setBusy(true)
    setProgress({ i: 1, n: 1, current: basename(params.output) })
    try {
      const res = await invoke<CcResult>('cc_archive', {
        paths: selectedFiles.map((f) => f.path),
        output: params.output,
        password: params.password ?? null,
        lockMode: params.lockMode === 'none' ? null : params.lockMode,
        lockValue: params.lockMode === 'none' ? null : params.lockValue ?? null,
      })
      setHistory((h) => [{ ...res, id: ++entryId }, ...h].slice(0, 50))
      const selectAfter = res.success && res.output ? res.output : undefined
      await refresh(cwd, selectAfter)
      if (res.success) setArchiveOpen(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [selectedFiles, cwd, refresh, askOverwrite])

  // OS-level drag-drop into the window: enter and process
  useEffect(() => {
    const webview = getCurrentWebview()
    const unlisten = webview.onDragDropEvent(async (evt) => {
      if (evt.payload.type !== 'drop') return
      const paths = evt.payload.paths
      if (!paths?.length) return
      // If a single dir was dropped, navigate; otherwise auto-process all files.
      if (paths.length === 1) {
        try {
          const l = await invoke<Listing>('list_dir', { path: paths[0], showHidden })
          setListing(l); setPathInput(l.path); setSelection(new Set()); return
        } catch { /* not a dir — fall through */ }
      }
      setBusy(true)
      let lastOutput: string | undefined
      let sticky: StickyChoice = null
      try {
        for (let i = 0; i < paths.length; i++) {
          const p = paths[i]
          setProgress({ i: i + 1, n: paths.length, current: basename(p) })
          const actionKey = p.toLowerCase().endsWith('.cute') ? 'decompress' : 'compress'
          const check = await invoke<OutputCheck>('cc_check_output', { action: actionKey, input: p })
          let proceed = true
          if (check.exists) {
            if (sticky === 'replace_all') proceed = true
            else if (sticky === 'skip_all') proceed = false
            else {
              const choice = await askOverwrite(basename(check.predicted))
              if (choice === 'cancel') break
              if (choice === 'skip') proceed = false
              else if (choice === 'replace') proceed = true
              else if (choice === 'replace_all') { sticky = 'replace_all'; proceed = true }
              else if (choice === 'skip_all') { sticky = 'skip_all'; proceed = false }
            }
          }
          if (!proceed) {
            setHistory((h) => [{
              id: ++entryId, action: actionKey, input: p, output: '',
              stdout: '', stderr: `skipped: would overwrite ${basename(check.predicted)}`, success: false,
            }, ...h].slice(0, 50))
            continue
          }
          const res = await invoke<CcResult>('cc_auto', { path: p })
          setHistory((h) => [{ ...res, id: ++entryId }, ...h].slice(0, 50))
          if (res.success && res.output) lastOutput = res.output
        }
        if (cwd) await refresh(cwd, lastOutput)
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(false)
        setProgress(null)
      }
    })
    return () => { void unlisten.then((f) => f()) }
  }, [cwd, showHidden, refresh, askOverwrite])

  // Keyboard shortcuts. Skip when focus is in an input — typing should be free.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        if (e.key === 'Escape') (t as HTMLInputElement).blur()
        return
      }
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'ArrowUp') { e.preventDefault(); goUp() }
      else if (e.key === 'Escape') { setSelection(new Set()); setExpandedHistory(null) }
      else if (meta && (e.key === 'a' || e.key === 'A')) {
        if (sortedListing) {
          e.preventDefault()
          setSelection(new Set(sortedListing.entries.map((x) => x.path)))
        }
      }
      else if (e.key === 'Enter') {
        if (selection.size === 1 && sortedListing && !busy) {
          const [path] = selection
          const entry = sortedListing.entries.find((x) => x.path === path)
          if (entry) void onItemOpen(entry)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [goUp, sortedListing, selection, onItemOpen, busy])

  // Native menu events from the Tauri menu bar. Each item emits its id;
  // we dispatch to the same handlers the in-app buttons / shortcuts use.
  useEffect(() => {
    const unlisten = listen<string>('menu', async (evt) => {
      const id = evt.payload
      switch (id) {
        case 'file.open': {
          const picked = await openDialog({ directory: true, multiple: false })
          if (picked && typeof picked === 'string') void refresh(picked)
          break
        }
        case 'file.reveal': {
          const target = selection.size > 0 ? [...selection][0] : cwd
          if (target) void invoke('cc_reveal', { path: target })
          break
        }
        case 'file.archive':
          if (selectedFiles.length >= 2) setArchiveOpen(true)
          break
        case 'view.toggle_hidden': setShowHidden((v) => !v); break
        case 'view.sort_name': cycleSort('name'); break
        case 'view.sort_size': cycleSort('size'); break
        case 'view.sort_modified': cycleSort('modified'); break
        case 'view.parent': goUp(); break
        case 'view.reload': if (cwd) void refresh(cwd); break
        case 'action.auto':       void runOnSelection('auto'); break
        case 'action.compress':   void runOnSelection('compress'); break
        case 'action.decompress': void runOnSelection('decompress'); break
        case 'action.lock':       void runOnSelection('lock'); break
        case 'action.unlock':     void runOnSelection('unlock'); break
        case 'help.repo':
          void invoke('cc_open_url', { url: 'https://github.com/sewerfilth/cc-gui' })
          break
        case 'help.releases':
          void invoke('cc_open_url', { url: 'https://github.com/sewerfilth/cc-gui/releases' })
          break
      }
    })
    return () => { void unlisten.then((f) => f()) }
  }, [cwd, refresh, goUp, cycleSort, selection, selectedFiles, runOnSelection])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PathBar
        path={pathInput}
        canUp={!!listing?.parent}
        showHidden={showHidden}
        onChange={setPathInput}
        onSubmit={() => navigate(pathInput)}
        onUp={goUp}
        onToggleHidden={() => setShowHidden((v) => !v)}
      />

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Sidebar
          shortcuts={shortcuts}
          activePath={cwd}
          onPick={navigate}
          history={history}
          expandedId={expandedHistory}
          onToggleExpand={(id) => setExpandedHistory((cur) => cur === id ? null : id)}
          onClearHistory={() => { setHistory([]); setExpandedHistory(null) }}
        />

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <FileList
            listing={sortedListing}
            selection={selection}
            sort={sort}
            onSort={cycleSort}
            onClick={onItemClick}
            onOpen={onItemOpen}
          />

          <StatusBar listing={sortedListing} selectedFiles={selectedFiles} />

          {error && (
            <div style={{
              background: 'rgba(248,113,113,0.08)', color: 'var(--err)',
              borderTop: '1px solid rgba(248,113,113,0.3)',
              padding: '8px 14px', fontSize: 12,
            }}>{error}</div>
          )}

          <ActionBar
            count={selectedFiles.length}
            sample={selectedFiles[0]?.name}
            password={password}
            setPassword={setPassword}
            busy={busy}
            progress={progress}
            onRun={runOnSelection}
            onArchive={() => setArchiveOpen(true)}
          />
        </main>
      </div>

      {overwritePrompt && (
        <OverwritePrompt name={overwritePrompt.name} onChoice={resolveOverwrite} />
      )}
      {archiveOpen && (
        <ArchiveModal
          files={selectedFiles}
          defaultOutput={archiveDefaultOutput(selectedFiles, cwd)}
          busy={busy}
          onSubmit={runArchive}
          onCancel={() => setArchiveOpen(false)}
        />
      )}
    </div>
  )
}

function archiveDefaultOutput(files: FsEntry[], cwd: string): string {
  const dir = files[0]
    ? files[0].path.slice(0, files[0].path.lastIndexOf('/'))
    : cwd
  return `${dir}/archive.cute`
}

function PathBar({ path, canUp, showHidden, onChange, onSubmit, onUp, onToggleHidden }: {
  path: string; canUp: boolean; showHidden: boolean
  onChange: (s: string) => void; onSubmit: () => void; onUp: () => void; onToggleHidden: () => void
}) {
  return (
    <div className="titlebar" style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 12px 8px 84px', background: 'var(--surface)',
      borderBottom: '1px solid var(--border)', flex: '0 0 auto',
      height: 44,
    }}>
      <div className="no-drag" style={{
        display: 'flex', alignItems: 'center', gap: 6,
        color: 'var(--accent)', fontWeight: 600, fontSize: 13,
        letterSpacing: '0.02em', marginRight: 6, userSelect: 'none',
      }}>
        <span style={{ fontSize: 14 }}>◆</span>cc-gui
      </div>
      <button onClick={onUp} disabled={!canUp} title="Parent (⌘↑)" style={iconBtn}>↑</button>
      <input
        value={path}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSubmit() }}
        spellCheck={false}
        style={{
          flex: 1, background: 'var(--surface-2)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 6,
          padding: '6px 10px', fontSize: 12, outline: 'none',
          fontFamily: "'SF Mono', monospace",
        }}
      />
      <button onClick={onToggleHidden} title="Show hidden files"
        style={{ ...iconBtn, color: showHidden ? 'var(--accent-blue)' : 'var(--text-dim)' }}>
        ⊙
      </button>
    </div>
  )
}

function Sidebar({ shortcuts, activePath, onPick, history, expandedId, onToggleExpand, onClearHistory }: {
  shortcuts: Shortcut[]; activePath: string; onPick: (p: string) => void
  history: HistoryEntry[]
  expandedId: number | null
  onToggleExpand: (id: number) => void
  onClearHistory: () => void
}) {
  return (
    <aside style={{
      width: 180, flex: '0 0 180px',
      background: 'var(--surface)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <SidebarSection title="Places">
        {shortcuts.map((s) => {
          const active = s.path === activePath
          return (
            <button key={s.path} onClick={() => onPick(s.path)}
              style={{
                background: active ? 'var(--surface-2)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--text-dim)',
                border: 'none', borderRadius: 6,
                textAlign: 'left', padding: '6px 10px', fontSize: 12.5,
                display: 'flex', alignItems: 'center', gap: 6, width: '100%',
              }}>
              <span style={{ opacity: 0.7 }}>★</span>{s.name}
            </button>
          )
        })}
      </SidebarSection>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={sectionHeader}>
          <span>History</span>
          {history.length > 0 && <button onClick={onClearHistory} style={linkBtn}>clear</button>}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
          {history.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '8px 4px' }}>
              No operations yet.
            </div>
          )}
          {history.map((h) => {
            const expanded = expandedId === h.id
            const detail = (h.stderr || h.stdout || '').trim()
            const hasDetail = detail.length > 0
            return (
              <div key={h.id}
                onClick={() => hasDetail && onToggleExpand(h.id)}
                title={hasDetail ? (expanded ? 'collapse' : 'show output') : ''}
                style={{
                  padding: '6px 8px', marginBottom: 4,
                  borderRadius: 6, background: 'var(--surface-2)',
                  fontSize: 11, lineHeight: 1.35,
                  cursor: hasDetail ? 'pointer' : 'default',
                }}>
                <div style={{
                  color: h.success ? 'var(--ok)' : 'var(--err)',
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                  fontWeight: 600, fontSize: 9.5, marginBottom: 2,
                  display: 'flex', justifyContent: 'space-between',
                }}>
                  <span>{h.action} {h.success ? '✓' : '✗'}</span>
                  {hasDetail && <span style={{ opacity: 0.6 }}>{expanded ? '▾' : '▸'}</span>}
                </div>
                <div className="mono" style={{ color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                  {basename(h.input)}
                </div>
                {h.success && h.output && (
                  <div className="mono" style={{ color: 'var(--text)', wordBreak: 'break-all' }}>
                    → {basename(h.output)}
                  </div>
                )}
                {expanded && hasDetail && (
                  <pre className="mono" style={{
                    marginTop: 6, padding: '6px 8px', borderRadius: 4,
                    background: 'var(--bg)', color: h.success ? 'var(--text-dim)' : 'var(--err)',
                    fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    maxHeight: 180, overflowY: 'auto',
                  }}>{detail}</pre>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '8px' }}>
      <div style={sectionHeader}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{children}</div>
    </div>
  )
}

function FileList({ listing, selection, sort, onSort, onClick, onOpen }: {
  listing: Listing | null
  selection: Set<string>
  sort: { key: SortKey; dir: SortDir }
  onSort: (k: SortKey) => void
  onClick: (e: FsEntry, ev: React.MouseEvent) => void
  onOpen: (e: FsEntry) => void
}) {
  const lastClick = useRef<{ path: string; t: number }>({ path: '', t: 0 })

  if (!listing) {
    return <div style={{ flex: 1, color: 'var(--text-dim)', padding: 24, fontSize: 13 }}>Loading…</div>
  }
  if (listing.entries.length === 0) {
    return <DropHint label="Empty folder" hint="Drop files here to compress, lock, or unlock — or browse with the sidebar." />
  }

  const arrow = (k: SortKey) => sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  return (
    <div style={{ flex: 1, overflow: 'auto', minHeight: 0, minWidth: 0 }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse', fontSize: 12.5,
        tableLayout: 'fixed',
      }}>
        <thead style={{
          position: 'sticky', top: 0, background: 'var(--bg)',
          color: 'var(--text-dim)', fontSize: 10.5,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          <tr>
            <th style={th(28)}></th>
            <th style={{ ...th(), cursor: 'pointer' }} onClick={() => onSort('name')}>Name{arrow('name')}</th>
            <th style={{ ...th(90, 'right'), cursor: 'pointer' }} onClick={() => onSort('size')}>Size{arrow('size')}</th>
            <th style={{ ...th(140), cursor: 'pointer' }} onClick={() => onSort('modified')}>Modified{arrow('modified')}</th>
          </tr>
        </thead>
        <tbody>
          {listing.entries.map((entry) => {
            const sel = selection.has(entry.path)
            const isCute = entry.ext === 'cute'
            const handleClick = (ev: React.MouseEvent) => {
              const now = Date.now()
              const dbl = lastClick.current.path === entry.path && now - lastClick.current.t < 350
              lastClick.current = { path: entry.path, t: now }
              if (dbl) onOpen(entry)
              else onClick(entry, ev)
            }
            return (
              <tr key={entry.path}
                onClick={handleClick}
                style={{
                  background: sel ? 'rgba(56,189,248,0.16)' : 'transparent',
                  cursor: 'default',
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                }}>
                <td style={td(28)}>
                  <span style={{
                    fontSize: 14,
                    color: entry.is_dir ? 'var(--accent-blue)' : isCute ? 'var(--accent)' : 'var(--text-dim)',
                  }}>
                    {entry.is_dir ? '▸' : isCute ? '◆' : '·'}
                  </span>
                </td>
                <td style={{
                  ...td(),
                  color: entry.is_dir ? 'var(--text)' : 'var(--text)',
                  fontWeight: entry.is_dir ? 500 : 400,
                }}>
                  {entry.name}
                  {isCute && <span style={{
                    marginLeft: 6, fontSize: 9.5, color: 'var(--accent)',
                    background: 'rgba(251,111,146,0.15)', padding: '1px 5px', borderRadius: 3,
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                  }}>cute</span>}
                </td>
                <td style={{ ...td(90, 'right'), color: 'var(--text-dim)', fontFamily: "'SF Mono', monospace", fontSize: 11 }}>
                  {entry.is_dir ? '—' : formatSize(entry.size)}
                </td>
                <td style={{ ...td(140), color: 'var(--text-dim)', fontSize: 11 }}>
                  {formatDate(entry.modified)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ActionBar({ count, sample, password, setPassword, busy, progress, onRun, onArchive }: {
  count: number; sample?: string; password: string; setPassword: (s: string) => void
  busy: boolean
  progress: Progress | null
  onRun: (a: 'compress' | 'decompress' | 'lock' | 'unlock' | 'auto') => void
  onArchive: () => void
}) {
  const disabled = count === 0 || busy
  const archiveDisabled = count < 2 || busy
  const status = busy && progress
    ? (progress.n > 1
        ? `${progress.i}/${progress.n} · ${progress.current}`
        : `Working · ${progress.current}`)
    : busy ? 'Working…'
    : count === 0 ? 'No selection · ⏎ open · ⌘↑ parent · ⌘A all'
    : count === 1 ? `1 file selected · ${sample}`
    : `${count} files selected`
  return (
    <div style={{
      flex: '0 0 auto', borderTop: '1px solid var(--border)',
      background: 'var(--surface)', padding: '10px 14px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
        <span style={{
          color: 'var(--text-dim)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
        }}>{status}</span>
        <input
          type="password"
          placeholder="Password (lock/unlock)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{
            background: 'var(--surface-2)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 6,
            padding: '5px 9px', fontSize: 12, outline: 'none',
            width: 220,
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <ActionButton label="Auto" hint="compress raw · decompress .cute"
          tone="blue" disabled={disabled} onClick={() => onRun('auto')} />
        <ActionButton label="Compress" disabled={disabled} onClick={() => onRun('compress')} />
        <ActionButton label="Decompress" disabled={disabled} onClick={() => onRun('decompress')} />
        <ActionButton label="Lock" tone="rose"
          disabled={disabled || !password} onClick={() => onRun('lock')} />
        <ActionButton label="Unlock" tone="rose"
          disabled={disabled || !password} onClick={() => onRun('unlock')} />
        <div style={{ flex: 1 }} />
        <ActionButton label="Archive…" tone="blue" hint="Bundle ≥2 files into one .cute"
          disabled={archiveDisabled} onClick={onArchive} />
      </div>
    </div>
  )
}

function ActionButton({ label, hint, disabled, onClick, tone = 'neutral' }: {
  label: string; hint?: string; disabled: boolean; onClick: () => void
  tone?: 'neutral' | 'blue' | 'rose'
}) {
  const accent = tone === 'blue' ? 'var(--accent-blue)' : tone === 'rose' ? 'var(--accent)' : 'var(--text)'
  return (
    <button onClick={onClick} disabled={disabled} title={hint}
      style={{
        background: disabled ? 'var(--surface-2)' : tone === 'neutral' ? 'var(--surface-2)' : `${tone === 'blue' ? 'rgba(56,189,248,0.18)' : 'rgba(251,111,146,0.18)'}`,
        color: disabled ? 'var(--text-dim)' : accent,
        border: `1px solid ${disabled ? 'var(--border)' : tone === 'neutral' ? 'var(--border)' : accent + '55'}`,
        borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}>
      {label}
    </button>
  )
}

function DropHint({ label, hint }: { label: string; hint: string }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: 24, gap: 10, color: 'var(--text-dim)',
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 14,
        border: '2px dashed var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 28, color: 'var(--accent)',
      }}>◆</div>
      <div style={{ fontSize: 13, color: 'var(--text)' }}>{label}</div>
      <div style={{ fontSize: 11.5, maxWidth: 320, textAlign: 'center', lineHeight: 1.5 }}>
        {hint}
      </div>
    </div>
  )
}

function StatusBar({ listing, selectedFiles }: { listing: Listing | null; selectedFiles: FsEntry[] }) {
  const stats = useMemo(() => {
    if (!listing) return null
    let dirs = 0, files = 0, cute = 0, bytes = 0
    for (const e of listing.entries) {
      if (e.is_dir) dirs++
      else { files++; bytes += e.size; if (e.ext === 'cute') cute++ }
    }
    return { dirs, files, cute, bytes }
  }, [listing])

  if (!stats) return null
  const selBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0)
  return (
    <div style={{
      flex: '0 0 auto', padding: '4px 14px',
      borderTop: '1px solid var(--border)',
      background: 'var(--bg)',
      color: 'var(--text-dim)', fontSize: 11,
      display: 'flex', gap: 14, alignItems: 'center',
      fontFamily: "'SF Mono', monospace", letterSpacing: '0.02em',
    }}>
      <span>{stats.dirs} dir{stats.dirs === 1 ? '' : 's'}</span>
      <span>·</span>
      <span>{stats.files} file{stats.files === 1 ? '' : 's'}</span>
      {stats.cute > 0 && <>
        <span>·</span>
        <span style={{ color: 'var(--accent)' }}>{stats.cute} .cute</span>
      </>}
      <span>·</span>
      <span>{formatSize(stats.bytes)}</span>
      {selectedFiles.length > 0 && <>
        <span style={{ marginLeft: 'auto' }}>
          <span style={{ color: 'var(--accent-blue)' }}>{selectedFiles.length}</span> selected · {formatSize(selBytes)}
        </span>
      </>}
    </div>
  )
}

/* ── modals ──────────────────────────────────────────────────────────── */

function ModalShell({ title, onClose, children, width = 420 }: {
  title: string; onClose: () => void; children: React.ReactNode; width?: number
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)',
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width, maxWidth: '92vw', maxHeight: '88vh',
        display: 'flex', flexDirection: 'column',
        background: 'var(--surface)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 10,
        boxShadow: '0 18px 50px rgba(0,0,0,0.55)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid var(--border)',
          fontSize: 12.5, fontWeight: 600, letterSpacing: '0.02em',
        }}>{title}</div>
        <div style={{ padding: '14px', overflow: 'auto' }}>{children}</div>
      </div>
    </div>
  )
}

function OverwritePrompt({ name, onChoice }: {
  name: string; onChoice: (c: OverwriteChoice) => void
}) {
  return (
    <ModalShell title="File already exists" onClose={() => onChoice('cancel')}>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 14 }}>
        <div style={{ marginBottom: 6 }}>Output already exists:</div>
        <div className="mono" style={{
          padding: '6px 8px', borderRadius: 6, background: 'var(--bg)',
          color: 'var(--accent)', fontSize: 11.5, wordBreak: 'break-all',
        }}>{name}</div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
        <ActionButton label="Cancel" disabled={false} onClick={() => onChoice('cancel')} />
        <ActionButton label="Skip" disabled={false} onClick={() => onChoice('skip')} />
        <ActionButton label="Skip all" disabled={false} onClick={() => onChoice('skip_all')} />
        <ActionButton label="Replace all" tone="rose" disabled={false} onClick={() => onChoice('replace_all')} />
        <ActionButton label="Replace" tone="rose" disabled={false} onClick={() => onChoice('replace')} />
      </div>
    </ModalShell>
  )
}

function ArchiveModal({ files, defaultOutput, busy, onSubmit, onCancel }: {
  files: FsEntry[]
  defaultOutput: string
  busy: boolean
  onSubmit: (p: { output: string; password?: string; lockMode: LockMode; lockValue?: number }) => void
  onCancel: () => void
}) {
  const [output, setOutput] = useState(defaultOutput)
  const [pwd, setPwd] = useState('')
  const [mode, setMode] = useState<LockMode>('none')
  const [val, setVal] = useState<number>(1)
  const totalBytes = files.reduce((a, f) => a + f.size, 0)

  const submit = () => {
    if (!output.trim()) return
    onSubmit({
      output: output.trim(),
      password: pwd || undefined,
      lockMode: mode,
      lockValue: mode === 'none' ? undefined : Math.max(1, Math.floor(val || 1)),
    })
  }

  return (
    <ModalShell title="Create archive" onClose={onCancel} width={520}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
        Bundle {files.length} files ({formatSize(totalBytes)}) into a single
        depo container with the ARCV trailer.
      </div>
      <div style={{
        maxHeight: 110, overflow: 'auto', borderRadius: 6,
        border: '1px solid var(--border)', background: 'var(--bg)',
        padding: '6px 8px', marginBottom: 12, fontSize: 11.5, lineHeight: 1.5,
      }}>
        {files.map((f) => (
          <div key={f.path} className="mono" style={{
            color: 'var(--text-dim)', wordBreak: 'break-all',
          }}>{f.name}</div>
        ))}
      </div>

      <Field label="Output path">
        <input value={output} onChange={(e) => setOutput(e.target.value)}
          spellCheck={false} style={modalInput} />
      </Field>

      <Field label="Password (optional)">
        <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)}
          placeholder="leave empty for unencrypted archive" style={modalInput} />
      </Field>

      <Field label="Lock mode">
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={mode} onChange={(e) => setMode(e.target.value as LockMode)}
            style={{ ...modalInput, flex: 1 }}>
            <option value="none">none</option>
            <option value="fused">fused (max decryptions)</option>
            <option value="timed">timed (valid epochs)</option>
            <option value="delayed">delayed (delay seconds)</option>
          </select>
          {mode !== 'none' && (
            <input type="number" min={1} value={val}
              onChange={(e) => setVal(parseInt(e.target.value || '1', 10))}
              style={{ ...modalInput, width: 110 }} />
          )}
        </div>
        {mode !== 'none' && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>
            Lock modes require CLI support — the cutecontainer CLI may reject
            unknown flags. Surface stderr will show what's missing.
          </div>
        )}
      </Field>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <ActionButton label="Cancel" disabled={busy} onClick={onCancel} />
        <ActionButton label="Create" tone="blue" disabled={busy || !output.trim()} onClick={submit} />
      </div>
    </ModalShell>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        fontSize: 10.5, color: 'var(--text-dim)', textTransform: 'uppercase',
        letterSpacing: '0.07em', marginBottom: 4,
      }}>{label}</div>
      {children}
    </div>
  )
}

const modalInput: React.CSSProperties = {
  width: '100%', background: 'var(--surface-2)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6,
  padding: '6px 10px', fontSize: 12, outline: 'none',
  fontFamily: "'SF Mono', monospace",
}

/* ── helpers ─────────────────────────────────────────────────────────── */

const iconBtn: React.CSSProperties = {
  background: 'var(--surface-2)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6,
  padding: '4px 10px', fontSize: 12, cursor: 'pointer',
  minWidth: 30,
}

const linkBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--text-dim)',
  fontSize: 10.5, padding: 0, cursor: 'pointer',
}

const sectionHeader: React.CSSProperties = {
  fontSize: 10, color: 'var(--text-dim)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  padding: '6px 10px',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
}

const th = (w?: number, align: 'left' | 'right' = 'left'): React.CSSProperties => ({
  textAlign: align, fontWeight: 600,
  padding: '6px 10px', borderBottom: '1px solid var(--border)',
  width: w, whiteSpace: 'nowrap',
})

const td = (w?: number, align: 'left' | 'right' = 'left'): React.CSSProperties => ({
  textAlign: align,
  padding: '5px 10px',
  width: w, whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
})

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDate(epochSec: number): string {
  if (epochSec === 0) return '—'
  const d = new Date(epochSec * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}
