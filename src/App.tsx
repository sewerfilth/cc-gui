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

interface ArchiveEntry {
  path: string
  size: number
  compressed_size: number
  mtime: number
  is_dir: boolean
  is_encrypted: boolean
  is_symlink: boolean
}
interface ArchiveListing {
  format: string
  count: number
  entries: ArchiveEntry[]
}
interface ArchiveBrowse {
  path: string         // filesystem path of the archive itself
  format: string       // "zip", "tar.gz", "cute", ...
  entries: ArchiveEntry[]
  curDir: string       // path within archive ("" = root)
}

const ARCHIVE_EXTS = new Set([
  'cute', 'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz', 'tbz2', 'txz', 'press',
])

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
  const [filter, setFilter] = useState('')
  const [compressLevel, setCompressLevel] = useState<number>(5)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FsEntry } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ mode: 'trash' | 'permanent'; files: FsEntry[] } | null>(null)
  const [inspect, setInspect] = useState<{ path: string; loading: boolean; result: CcResult | null } | null>(null)
  const [archive, setArchive] = useState<ArchiveBrowse | null>(null)

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

  // Sync the path bar text with archive state for the visual breadcrumb.
  useEffect(() => {
    if (archive) {
      setPathInput(`${archive.path}${archive.curDir ? ' › ' + archive.curDir : ''}`)
    } else if (listing) {
      setPathInput(listing.path)
    }
  }, [archive, listing])

  const navigate = useCallback((path: string) => {
    if (archive) setArchive(null)
    void refresh(path)
  }, [refresh, archive])
  const goUp = useCallback(() => {
    if (archive) {
      if (archive.curDir) {
        const slash = archive.curDir.lastIndexOf('/')
        const newDir = slash >= 0 ? archive.curDir.slice(0, slash) : ''
        setArchive({ ...archive, curDir: newDir })
        setSelection(new Set()); setAnchor(null)
      } else {
        // exit archive — go back to its parent directory on disk
        const slash = archive.path.lastIndexOf('/')
        const parentDir = slash >= 0 ? archive.path.slice(0, slash) : archive.path
        setArchive(null)
        void refresh(parentDir, archive.path)
      }
      return
    }
    if (listing?.parent) void refresh(listing.parent)
  }, [archive, listing, refresh])

  // When browsing an archive, build a synthetic Listing the rest of the
  // pipeline (sort/filter/render/select) can consume unchanged. Dir entries
  // are inferred from path prefixes since many formats (zip, tar) don't
  // store explicit directories.
  const effectiveListing = useMemo<Listing | null>(() => {
    if (!archive) return listing
    const prefix = archive.curDir ? archive.curDir + '/' : ''
    const seenDirs = new Set<string>()
    const out: FsEntry[] = []
    for (const e of archive.entries) {
      if (!e.path.startsWith(prefix)) continue
      const rel = e.path.slice(prefix.length)
      if (!rel) continue
      const slash = rel.indexOf('/')
      if (slash >= 0) {
        const dirName = rel.slice(0, slash)
        if (seenDirs.has(dirName)) continue
        seenDirs.add(dirName)
        out.push({
          name: dirName,
          path: prefix + dirName,
          is_dir: true,
          size: 0,
          modified: e.mtime,
          ext: '',
        })
      } else if (e.is_dir) {
        if (seenDirs.has(rel)) continue
        seenDirs.add(rel)
        out.push({ name: rel, path: e.path, is_dir: true, size: 0, modified: e.mtime, ext: '' })
      } else {
        const dot = rel.lastIndexOf('.')
        out.push({
          name: rel,
          path: e.path,
          is_dir: false,
          size: e.size,
          modified: e.mtime,
          ext: dot >= 0 ? rel.slice(dot + 1).toLowerCase() : '',
        })
      }
    }
    const display = `${archive.path}${archive.curDir ? ' › ' + archive.curDir : ''}`
    return { path: display, parent: '__archive_up__', entries: out }
  }, [listing, archive])

  // Sort + filter transform — directories always first, then by selected key.
  // Filter is case-insensitive substring on the entry name.
  const sortedListing = useMemo<Listing | null>(() => {
    if (!effectiveListing) return null
    const needle = filter.trim().toLowerCase()
    const dirMul = sort.dir === 'asc' ? 1 : -1
    const filtered = needle
      ? effectiveListing.entries.filter((e) => e.name.toLowerCase().includes(needle))
      : effectiveListing.entries
    const entries = [...filtered].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
      let cmp = 0
      if (sort.key === 'name') cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      else if (sort.key === 'size') cmp = a.size - b.size
      else cmp = a.modified - b.modified
      return cmp * dirMul
    })
    return { ...effectiveListing, entries }
  }, [effectiveListing, sort, filter])

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

  // Double-click semantics:
  //   - dir on filesystem → navigate into it (refresh)
  //   - archive-extension file → try to enter archive-browse mode
  //     (cc_archive_list); on failure (e.g. single-file .cute) fall back to
  //     opening with the system default handler
  //   - regular file → system default handler
  //   - inside archive: dir → drill into curDir; file → no-op for now
  //     (extract via the Extract action)
  const onItemOpen = useCallback(async (entry: FsEntry) => {
    if (archive) {
      if (entry.is_dir) {
        setArchive({ ...archive, curDir: entry.path })
        setSelection(new Set()); setAnchor(null)
      }
      return
    }
    if (entry.is_dir) { void refresh(entry.path); return }
    if (ARCHIVE_EXTS.has(entry.ext)) {
      try {
        const listing = await invoke<ArchiveListing>('cc_archive_list', { path: entry.path })
        setArchive({ path: entry.path, format: listing.format, entries: listing.entries, curDir: '' })
        setSelection(new Set()); setAnchor(null)
        return
      } catch (_e) {
        // Not browsable as archive (likely single-file .cute) — fall through
      }
    }
    try {
      await invoke('cc_open', { path: entry.path })
    } catch (e) {
      setError(String(e))
    }
  }, [refresh, archive])

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
        const args: Record<string, unknown> =
          (action === 'lock' || action === 'unlock')
            ? { path: f.path, password }
          : action === 'compress'
            ? { path: f.path, level: compressLevel }
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
  }, [selectedFiles, password, cwd, refresh, askOverwrite, compressLevel])

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

  const runInspect = useCallback(async (path: string) => {
    setInspect({ path, loading: true, result: null })
    try {
      const res = await invoke<CcResult>('cc_info', { path })
      setInspect({ path, loading: false, result: res })
    } catch (e) {
      setInspect({ path, loading: false, result: {
        action: 'info', input: path, output: '', stdout: '',
        stderr: String(e), success: false,
      }})
    }
  }, [])

  const runExtract = useCallback(async (selected?: FsEntry[]) => {
    if (!archive) return
    const dest = await openDialog({ directory: true, multiple: false })
    if (!dest || typeof dest !== 'string') return
    setBusy(true)
    setError(null)
    try {
      const targets = selected && selected.length > 0 ? selected : null
      if (targets) {
        // Extract specific entries by their original index in the archive
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i]
          const idx = archive.entries.findIndex((e) => e.path === t.path)
          if (idx < 0) continue
          setProgress({ i: i + 1, n: targets.length, current: t.name })
          const outPath = `${dest}/${t.name}`
          const res = await invoke<CcResult>('cc_archive_extract', {
            path: archive.path, dest: outPath, index: idx,
          })
          setHistory((h) => [{ ...res, id: ++entryId }, ...h].slice(0, 50))
        }
      } else {
        setProgress({ i: 1, n: 1, current: basename(archive.path) })
        const res = await invoke<CcResult>('cc_archive_extract', {
          path: archive.path, dest, index: null,
        })
        setHistory((h) => [{ ...res, id: ++entryId }, ...h].slice(0, 50))
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [archive])

  const runDelete = useCallback(async (mode: 'trash' | 'permanent', files: FsEntry[]) => {
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const cmd = mode === 'trash' ? 'cc_trash' : 'cc_delete'
      await invoke(cmd, { paths: files.map((f) => f.path) })
      await refresh(cwd)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
      setConfirmDelete(null)
    }
  }, [cwd, refresh])

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
      else if (meta && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        const inp = document.querySelector<HTMLInputElement>('input[data-filter]')
        inp?.focus(); inp?.select()
      }
      else if (e.key === 'Escape') {
        setSelection(new Set()); setExpandedHistory(null)
        setContextMenu(null); setFilter('')
      }
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
        case 'file.inspect': {
          const target = selection.size > 0 ? [...selection][0] : null
          if (target) void runInspect(target)
          break
        }
        case 'file.trash':
        case 'file.delete': {
          const targets = Array.from(selection)
            .map((p) => listing?.entries.find((e) => e.path === p))
            .filter((e): e is FsEntry => !!e)
          if (targets.length === 0) break
          setConfirmDelete({
            mode: id === 'file.trash' ? 'trash' : 'permanent',
            files: targets,
          })
          break
        }
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
  }, [cwd, refresh, goUp, cycleSort, selection, selectedFiles, runOnSelection, runInspect, listing])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PathBar
        path={pathInput}
        canUp={!!listing?.parent || !!archive}
        showHidden={showHidden}
        filter={filter}
        archiveFormat={archive?.format}
        onChange={setPathInput}
        onSubmit={() => navigate(pathInput)}
        onUp={goUp}
        onToggleHidden={() => setShowHidden((v) => !v)}
        onFilter={setFilter}
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
            onContextMenu={(entry, ev) => {
              setSelection((prev) => prev.has(entry.path) ? prev : new Set([entry.path]))
              setAnchor(entry.path)
              setContextMenu({ x: ev.clientX, y: ev.clientY, entry })
            }}
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
            level={compressLevel}
            setLevel={setCompressLevel}
            archiveMode={!!archive}
            archiveFormat={archive?.format}
            onRun={runOnSelection}
            onArchive={() => setArchiveOpen(true)}
            onExtract={() => runExtract(selectedFiles.length > 0 ? selectedFiles : undefined)}
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
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x} y={contextMenu.y} entry={contextMenu.entry}
          selection={Array.from(selection)}
          listing={listing}
          archiveMode={!!archive}
          hasPassword={!!password}
          onClose={() => setContextMenu(null)}
          onAction={(id) => {
            setContextMenu(null)
            if (archive) {
              const archTargets = Array.from(selection)
                .map((p) => sortedListing?.entries.find((e) => e.path === p))
                .filter((e): e is FsEntry => !!e && !e.is_dir)
              switch (id) {
                case 'extract':
                  void runExtract(archTargets.length > 0 ? archTargets : undefined)
                  break
                case 'reveal_archive':
                  void invoke('cc_reveal', { path: archive.path })
                  break
                case 'exit_archive':
                  goUp()
                  break
              }
              return
            }
            const targets = Array.from(selection)
              .map((p) => listing?.entries.find((e) => e.path === p))
              .filter((e): e is FsEntry => !!e)
            const fileTargets = targets.filter((e) => !e.is_dir)
            switch (id) {
              case 'open': void invoke('cc_open', { path: contextMenu.entry.path }); break
              case 'reveal': void invoke('cc_reveal', { path: contextMenu.entry.path }); break
              case 'inspect': void runInspect(contextMenu.entry.path); break
              case 'compress':   if (fileTargets.length) void runOnSelection('compress'); break
              case 'decompress': if (fileTargets.length) void runOnSelection('decompress'); break
              case 'lock':       if (fileTargets.length) void runOnSelection('lock'); break
              case 'unlock':     if (fileTargets.length) void runOnSelection('unlock'); break
              case 'auto':       if (fileTargets.length) void runOnSelection('auto'); break
              case 'archive':    if (fileTargets.length >= 2) setArchiveOpen(true); break
              case 'trash':       if (targets.length) setConfirmDelete({ mode: 'trash', files: targets }); break
              case 'delete':      if (targets.length) setConfirmDelete({ mode: 'permanent', files: targets }); break
            }
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDelete
          mode={confirmDelete.mode}
          files={confirmDelete.files}
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => runDelete(confirmDelete.mode, confirmDelete.files)}
        />
      )}
      {inspect && (
        <InspectModal
          path={inspect.path}
          loading={inspect.loading}
          result={inspect.result}
          onClose={() => setInspect(null)}
        />
      )}
    </div>
  )
}

function archiveDefaultOutput(files: FsEntry[], cwd: string): string {
  const dir = files[0]
    ? files[0].path.slice(0, files[0].path.lastIndexOf('/'))
    : cwd
  // ZIP is the only writer libcutecontainer currently supports.
  return `${dir}/archive.zip`
}

function PathBar({ path, canUp, showHidden, filter, archiveFormat, onChange, onSubmit, onUp, onToggleHidden, onFilter }: {
  path: string; canUp: boolean; showHidden: boolean
  filter: string
  archiveFormat?: string
  onChange: (s: string) => void; onSubmit: () => void; onUp: () => void; onToggleHidden: () => void
  onFilter: (s: string) => void
}) {
  const inArchive = !!archiveFormat
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
      <button onClick={onUp} disabled={!canUp}
        title={inArchive ? 'Up (⌘↑) — leave archive at root' : 'Parent (⌘↑)'}
        style={iconBtn}>↑</button>
      {inArchive && (
        <span style={{
          fontSize: 9.5, fontWeight: 700, letterSpacing: '0.07em',
          padding: '3px 7px', borderRadius: 4,
          background: 'rgba(56,189,248,0.16)', color: 'var(--accent-blue)',
          textTransform: 'uppercase', userSelect: 'none',
        }}>{archiveFormat}</span>
      )}
      <input
        value={path}
        readOnly={inArchive}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSubmit() }}
        spellCheck={false}
        style={{
          flex: 1, minWidth: 0, background: 'var(--surface-2)',
          color: inArchive ? 'var(--accent-blue)' : 'var(--text)',
          border: `1px solid ${inArchive ? 'rgba(56,189,248,0.35)' : 'var(--border)'}`,
          borderRadius: 6,
          padding: '6px 10px', fontSize: 12, outline: 'none',
          fontFamily: "'SF Mono', monospace",
        }}
      />
      <input
        data-filter
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        placeholder="filter (⌘F)"
        spellCheck={false}
        style={{
          width: 150, background: 'var(--surface-2)', color: 'var(--text)',
          border: `1px solid ${filter ? 'var(--accent-blue)' : 'var(--border)'}`,
          borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none',
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

function FileList({ listing, selection, sort, onSort, onClick, onOpen, onContextMenu }: {
  listing: Listing | null
  selection: Set<string>
  sort: { key: SortKey; dir: SortDir }
  onSort: (k: SortKey) => void
  onClick: (e: FsEntry, ev: React.MouseEvent) => void
  onOpen: (e: FsEntry) => void
  onContextMenu: (e: FsEntry, ev: React.MouseEvent) => void
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
                onContextMenu={(ev) => { ev.preventDefault(); onContextMenu(entry, ev) }}
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

function ActionBar({ count, sample, password, setPassword, busy, progress, level, setLevel, archiveMode, archiveFormat, onRun, onArchive, onExtract }: {
  count: number; sample?: string; password: string; setPassword: (s: string) => void
  busy: boolean
  progress: Progress | null
  level: number
  setLevel: (n: number) => void
  archiveMode: boolean
  archiveFormat?: string
  onRun: (a: 'compress' | 'decompress' | 'lock' | 'unlock' | 'auto') => void
  onArchive: () => void
  onExtract: () => void
}) {
  const disabled = count === 0 || busy
  const archiveDisabled = count < 2 || busy
  const status = busy && progress
    ? (progress.n > 1
        ? `${progress.i}/${progress.n} · ${progress.current}`
        : `Working · ${progress.current}`)
    : busy ? 'Working…'
    : archiveMode
      ? (count === 0
          ? `Browsing ${archiveFormat ?? 'archive'} · Extract all, or select entries to extract`
          : count === 1 ? `1 entry selected · ${sample}`
          : `${count} entries selected`)
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
        {archiveMode ? (
          <>
            <ActionButton label={count > 0 ? `Extract ${count}…` : 'Extract All…'}
              tone="blue" disabled={busy} onClick={onExtract} />
            <div style={{ flex: 1 }} />
          </>
        ) : (
          <>
            <ActionButton label="Auto" hint="compress raw · decompress .cute"
              tone="blue" disabled={disabled} onClick={() => onRun('auto')} />
            <ActionButton label="Compress" disabled={disabled} onClick={() => onRun('compress')} />
            <select value={level} onChange={(e) => setLevel(parseInt(e.target.value, 10))}
              title="Compression level (1 fastest · 9 smallest)"
              style={{
                background: 'var(--surface-2)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 6,
                padding: '5px 6px', fontSize: 11, outline: 'none',
                fontFamily: "'SF Mono', monospace",
              }}>
              {[1,2,3,4,5,6,7,8,9].map((l) => <option key={l} value={l}>L{l}</option>)}
            </select>
            <ActionButton label="Decompress" disabled={disabled} onClick={() => onRun('decompress')} />
            <ActionButton label="Lock" tone="rose"
              disabled={disabled || !password} onClick={() => onRun('lock')} />
            <ActionButton label="Unlock" tone="rose"
              disabled={disabled || !password} onClick={() => onRun('unlock')} />
            <div style={{ flex: 1 }} />
            <ActionButton label="Archive…" tone="blue" hint="Bundle ≥2 files into one .cute"
              disabled={archiveDisabled} onClick={onArchive} />
          </>
        )}
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

/* ── context menu ────────────────────────────────────────────────────── */

type CtxItem =
  | { type: 'item'; id: string; label: string; hint?: string; disabled?: boolean; danger?: boolean }
  | { type: 'sep' }

function ContextMenu({ x, y, entry, selection, listing, archiveMode, hasPassword, onClose, onAction }: {
  x: number; y: number; entry: FsEntry; selection: string[]
  listing: Listing | null
  archiveMode: boolean
  hasPassword: boolean
  onClose: () => void
  onAction: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })

  useEffect(() => {
    // Clamp inside viewport
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    const left = Math.min(x, window.innerWidth - r.width - 8)
    const top = Math.min(y, window.innerHeight - r.height - 8)
    setPos({ left, top })
  }, [x, y])

  const targets = selection
    .map((p) => listing?.entries.find((e) => e.path === p))
    .filter((e): e is FsEntry => !!e)
  const fileCount = targets.filter((e) => !e.is_dir).length
  const total = targets.length || 1
  const single = total === 1
  const isCute = single && entry.ext === 'cute'

  const items: CtxItem[] = archiveMode ? [
    { type: 'item', id: 'extract',
      label: total > 1 ? `Extract ${total} entries…` : 'Extract this entry…',
      disabled: entry.is_dir && total === 1 },
    { type: 'sep' },
    { type: 'item', id: 'reveal_archive', label: 'Reveal source archive in Finder' },
    { type: 'item', id: 'exit_archive',   label: 'Exit archive' },
  ] : [
    { type: 'item', id: 'open', label: entry.is_dir ? 'Open Folder' : 'Open with default app' },
    { type: 'item', id: 'reveal', label: 'Reveal in Finder' },
    ...(single && !entry.is_dir ? [{ type: 'item' as const, id: 'inspect', label: 'Inspect…', hint: 'show .cute info' }] : []),
    { type: 'sep' },
    { type: 'item', id: 'auto', label: `Auto Process${total > 1 ? ` (${fileCount})` : ''}`, disabled: fileCount === 0 },
    { type: 'item', id: 'compress', label: `Compress${total > 1 ? ` (${fileCount})` : ''}`, disabled: fileCount === 0 },
    { type: 'item', id: 'decompress', label: isCute ? 'Decompress' : `Decompress${total > 1 ? ` (${fileCount})` : ''}`, disabled: fileCount === 0 },
    { type: 'sep' },
    { type: 'item', id: 'lock', label: 'Lock with password', disabled: fileCount === 0 || !hasPassword, hint: hasPassword ? undefined : 'set password in action bar' },
    { type: 'item', id: 'unlock', label: 'Unlock with password', disabled: fileCount === 0 || !hasPassword, hint: hasPassword ? undefined : 'set password in action bar' },
    { type: 'item', id: 'archive', label: `Archive ${fileCount} files…`, disabled: fileCount < 2 },
    { type: 'sep' },
    { type: 'item', id: 'trash', label: `Move to Trash${total > 1 ? ` (${total})` : ''}`, danger: true },
    { type: 'item', id: 'delete', label: `Delete Permanently${total > 1 ? ` (${total})` : ''}`, danger: true },
  ]

  return (
    <div onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 200 }}>
      <div ref={ref} onClick={(e) => e.stopPropagation()} style={{
        position: 'fixed', left: pos.left, top: pos.top,
        background: 'var(--surface)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 8,
        padding: 4, minWidth: 230,
        boxShadow: '0 14px 38px rgba(0,0,0,0.5)',
        fontSize: 12.5,
      }}>
        {items.map((it, i) =>
          it.type === 'sep' ? (
            <div key={i} style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} />
          ) : (
            <button key={it.id}
              disabled={it.disabled}
              onClick={() => !it.disabled && onAction(it.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'transparent', border: 'none',
                padding: '6px 10px', borderRadius: 4,
                color: it.disabled ? 'var(--text-dim)' : it.danger ? 'var(--err)' : 'var(--text)',
                cursor: it.disabled ? 'not-allowed' : 'pointer',
                fontSize: 12.5,
              }}
              onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'var(--surface-2)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              title={it.hint}>
              {it.label}
              {it.hint && (
                <span style={{ marginLeft: 6, color: 'var(--text-dim)', fontSize: 10.5 }}>
                  · {it.hint}
                </span>
              )}
            </button>
          )
        )}
      </div>
    </div>
  )
}

/* ── delete confirm + inspect ─────────────────────────────────────────── */

function ConfirmDelete({ mode, files, busy, onCancel, onConfirm }: {
  mode: 'trash' | 'permanent'
  files: FsEntry[]
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const total = files.length
  const totalBytes = files.reduce((a, f) => a + f.size, 0)
  const title = mode === 'trash' ? `Move to Trash` : `Delete Permanently`
  const danger = mode === 'permanent'
  return (
    <ModalShell title={title} onClose={onCancel} width={460}>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 12 }}>
        {danger ? (
          <div style={{ color: 'var(--err)', marginBottom: 8 }}>
            ⚠ This <b>cannot be undone</b>. Files will not appear in the Trash.
          </div>
        ) : (
          <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>
            Files will be moved to the macOS Trash and can be restored from
            Finder.
          </div>
        )}
        <div>
          {total} {total === 1 ? 'item' : 'items'} ({formatSize(totalBytes)}):
        </div>
      </div>
      <div style={{
        maxHeight: 160, overflow: 'auto', borderRadius: 6,
        border: '1px solid var(--border)', background: 'var(--bg)',
        padding: '6px 8px', marginBottom: 14, fontSize: 11.5, lineHeight: 1.5,
      }}>
        {files.slice(0, 20).map((f) => (
          <div key={f.path} className="mono" style={{
            color: 'var(--text-dim)', wordBreak: 'break-all',
          }}>{f.is_dir ? '▸ ' : ''}{f.name}</div>
        ))}
        {files.length > 20 && (
          <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 4 }}>
            …and {files.length - 20} more
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <ActionButton label="Cancel" disabled={busy} onClick={onCancel} />
        <ActionButton
          label={mode === 'trash' ? 'Move to Trash' : 'Delete Permanently'}
          tone={danger ? 'rose' : 'blue'}
          disabled={busy}
          onClick={onConfirm}
        />
      </div>
    </ModalShell>
  )
}

function InspectModal({ path, loading, result, onClose }: {
  path: string; loading: boolean; result: CcResult | null; onClose: () => void
}) {
  const body = loading ? 'Loading…'
    : result?.success ? (result.stdout || '(no output)')
    : (result?.stderr || result?.stdout || 'failed')
  return (
    <ModalShell title={`Inspect — ${basename(path)}`} onClose={onClose} width={620}>
      <pre className="mono" style={{
        margin: 0, padding: '10px 12px', borderRadius: 6,
        background: 'var(--bg)', color: 'var(--text)',
        fontSize: 11.5, lineHeight: 1.55,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        maxHeight: '60vh', overflow: 'auto',
      }}>{body}</pre>
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <ActionButton label="Close" disabled={false} onClick={onClose} />
      </div>
    </ModalShell>
  )
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
