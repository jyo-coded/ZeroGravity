/**
 * FileExplorer — slide-in file tree panel with full file operations (A1).
 *
 * Right-click context menu: New File, New Folder, Rename (F2), Duplicate,
 * Delete (undoable via changelog), Copy Path / Relative Path, Reveal in OS.
 * Header: new file/folder, auto-save toggle, undo-delete, refresh.
 *
 * All persistent ops route through the store → Tauri → orchestrator → changelog → P2P.
 */

import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  ChevronRight, ChevronDown, File, Folder, FolderOpen, FolderPlus,
  Plus, RotateCcw, RefreshCw, Save, AlertTriangle, Eraser,
} from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import type { FileNode } from '../../lib/types'

interface MenuState {
  x: number
  y: number
  node: FileNode
}

export function FileExplorer() {
  const {
    fileTree, activeFile, openFile, expandedDirs, toggleDir, loadFileTree,
    createFile, createFolder, renameFsPath, deleteFsPath, duplicateFile,
    copyPath, revealInExplorer, changelog,
    lastDeleteEntryIds, undoLastDelete,
    autoSave, setAutoSave, trimOnSave, setTrimOnSave,
    gitModified, gitUntracked,
    explorerCreateRequest, clearExplorerCreateRequest,
  } = useAppStore()

  const gitModSet = new Set(gitModified)
  const gitNewSet = new Set(gitUntracked)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)   // path being renamed
  const [renameValue, setRenameValue] = useState('')
  const [creating, setCreating] = useState<{ dir: string; kind: 'file' | 'folder' } | null>(null)
  const [createValue, setCreateValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<FileNode | null>(null)

  // Close context menu on any click / Escape
  useEffect(() => {
    const close = () => setMenu(null)
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(null); setRenaming(null); setCreating(null); setConfirmDelete(null) }
      if (e.key === 'F2' && !renaming) {
        // Inside Monaco, F2 is LSP rename-symbol — don't hijack it (A4)
        if ((e.target as HTMLElement)?.closest?.('.monaco-editor')) return
        const s = useAppStore.getState()
        if (s.activeFile) startRename(s.activeFile)
      }
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', esc) }
  }, [renaming])

  // #4: palette "New File / New Folder" focuses the inline create input
  useEffect(() => {
    if (!explorerCreateRequest) return
    setCreating(explorerCreateRequest)
    setCreateValue('')
    clearExplorerCreateRequest()
  }, [explorerCreateRequest, clearExplorerCreateRequest])

  const conflictedFiles = new Set<string>(
    changelog.filter((e) => e.conflict_flag).map((e) => e.file)
  )

  function startRename(path: string) {
    setRenaming(path)
    setRenameValue(path.split('/').pop() ?? path)
    setMenu(null)
  }

  async function commitRename(path: string) {
    const newName = renameValue.trim()
    setRenaming(null)
    if (!newName || newName === path.split('/').pop()) return
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const to = parent ? `${parent}/${newName}` : newName
    await renameFsPath(path, to)
  }

  async function commitCreate() {
    if (!creating) return
    const name = createValue.trim()
    setCreating(null)
    setCreateValue('')
    if (!name) return
    const full = creating.dir ? `${creating.dir}/${name}` : name
    if (creating.kind === 'file') await createFile(full)
    else await createFolder(full)
  }

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 232, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="shrink-0 flex flex-col glass-panel overflow-hidden relative z-30"
      style={{ borderRight: '1px solid rgba(255,255,255,0.05)' }}
    >
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-3 py-2.5 shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
      >
        <span className="text-[9px] font-mono tracking-[0.2em] uppercase flex-1"
          style={{ color: 'rgba(0,200,255,0.5)' }}
        >
          Explorer
        </span>

        {lastDeleteEntryIds.length > 0 && (
          <button
            onClick={() => undoLastDelete()}
            className="p-1 rounded text-orange/70 hover:text-orange transition-colors"
            title={`Undo delete (${lastDeleteEntryIds.length} file(s))`}
          >
            <RotateCcw size={12} />
          </button>
        )}
        <button
          onClick={() => setAutoSave(autoSave === 'off' ? 'idle' : 'off')}
          className={`p-1 rounded transition-colors ${autoSave === 'idle' ? 'text-green' : 'text-text-muted/40 hover:text-text-muted'}`}
          title={`Auto-save: ${autoSave === 'idle' ? 'ON (1s idle)' : 'OFF'}`}
        >
          <Save size={12} />
        </button>
        <button
          onClick={() => setTrimOnSave(!trimOnSave)}
          className={`p-1 rounded transition-colors ${trimOnSave ? 'text-green' : 'text-text-muted/40 hover:text-text-muted'}`}
          title={`Trim trailing whitespace on save: ${trimOnSave ? 'ON' : 'OFF'}`}
        >
          <Eraser size={12} />
        </button>
        <button
          onClick={() => loadFileTree()}
          className="p-1 rounded text-text-muted/40 hover:text-cyan transition-colors"
          title="Refresh tree"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => { setCreating({ dir: '', kind: 'folder' }); setCreateValue('') }}
          className="p-1 rounded text-text-muted/40 hover:text-cyan transition-colors"
          title="New folder"
        >
          <FolderPlus size={12} />
        </button>
        <button
          onClick={() => { setCreating({ dir: '', kind: 'file' }); setCreateValue('') }}
          className="p-1 rounded text-text-muted/40 hover:text-cyan transition-colors"
          title="New file"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* ─── Create input (root level) ──────────────────────────────────── */}
      {creating && (
        <div className="mx-2 mt-2 rounded-lg p-2"
          style={{ border: '0.5px solid rgba(0,200,255,0.25)', background: 'rgba(0,200,255,0.04)' }}
        >
          <div className="flex items-center gap-1.5">
            {creating.kind === 'file' ? <File size={11} className="text-cyan shrink-0" /> : <Folder size={11} className="text-cyan shrink-0" />}
            <input
              value={createValue}
              onChange={(e) => setCreateValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitCreate() }}
              placeholder={creating.kind === 'file'
                ? (creating.dir ? `${creating.dir}/…` : 'src/new-file.ts')
                : (creating.dir ? `${creating.dir}/…` : 'new-folder')}
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary placeholder-text-dim font-mono outline-none"
            />
          </div>
        </div>
      )}

      {/* ─── Tree ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto py-1">
        {fileTree.length === 0 ? (
          <p className="text-[10px] text-text-muted text-center mt-6">No files yet</p>
        ) : (
          fileTree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              activeFile={activeFile}
              openFile={openFile}
              expandedDirs={expandedDirs}
              toggleDir={toggleDir}
              conflictedFiles={conflictedFiles}
              gitModified={gitModSet}
              gitUntracked={gitNewSet}
              onContextMenu={(e, n) => {
                e.preventDefault()
                e.stopPropagation()
                setMenu({ x: e.clientX, y: e.clientY, node: n })
              }}
              renaming={renaming}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              commitRename={commitRename}
            />
          ))
        )}
      </div>

      {/* ─── Context menu ───────────────────────────────────────────────── */}
      {menu && (
        <div
          className="fixed z-[70] w-52 glass-elevated rounded-xl overflow-hidden py-1"
          style={{
            left: Math.min(menu.x, window.innerWidth - 220),
            top: Math.min(menu.y, window.innerHeight - 300),
            border: '0.6px solid rgba(0,200,255,0.25)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem label="New File" onClick={() => {
            const dir = menu.node.is_dir ? menu.node.path : (menu.node.path.includes('/') ? menu.node.path.slice(0, menu.node.path.lastIndexOf('/')) : '')
            setCreating({ dir, kind: 'file' }); setCreateValue(''); setMenu(null)
          }} />
          <MenuItem label="New Folder" onClick={() => {
            const dir = menu.node.is_dir ? menu.node.path : (menu.node.path.includes('/') ? menu.node.path.slice(0, menu.node.path.lastIndexOf('/')) : '')
            setCreating({ dir, kind: 'folder' }); setCreateValue(''); setMenu(null)
          }} />
          <MenuDivider />
          <MenuItem label="Rename" hint="F2" onClick={() => startRename(menu.node.path)} />
          {!menu.node.is_dir && (
            <MenuItem label="Duplicate" onClick={() => { duplicateFile(menu.node.path); setMenu(null) }} />
          )}
          <MenuItem label="Delete" danger onClick={() => { setConfirmDelete(menu.node); setMenu(null) }} />
          <MenuDivider />
          <MenuItem label="Copy Path" onClick={() => { copyPath(menu.node.path, false); setMenu(null) }} />
          <MenuItem label="Copy Relative Path" onClick={() => { copyPath(menu.node.path, true); setMenu(null) }} />
          <MenuItem label="Reveal in File Explorer" onClick={() => { revealInExplorer(menu.node.path); setMenu(null) }} />
        </div>
      )}

      {/* ─── Delete confirm modal ───────────────────────────────────────── */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center" style={{ background: 'rgba(0,2,8,0.6)' }}>
          <div className="w-80 glass-elevated rounded-xl p-4"
            style={{ border: '0.6px solid rgba(255,69,58,0.35)' }}
          >
            <p className="text-xs text-text-primary mb-1 font-semibold">
              Delete {confirmDelete.is_dir ? 'folder' : 'file'}?
            </p>
            <p className="text-[10px] font-mono text-text-muted mb-3 break-all">{confirmDelete.path}</p>
            <p className="text-[10px] text-text-muted mb-4">
              Undoable this session — contents are preserved in the mission log.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1 rounded-lg text-[10px] text-text-muted hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { deleteFsPath(confirmDelete.path); setConfirmDelete(null) }}
                className="px-3 py-1 rounded-lg text-[10px] font-semibold"
                style={{ background: 'rgba(255,69,58,0.15)', border: '0.5px solid rgba(255,69,58,0.5)', color: '#FF453A' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  )
}

/* ─── Menu bits ─────────────────────────────────────────────────────────── */

function MenuItem({ label, hint, danger, onClick }: { label: string; hint?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors ${
        danger ? 'text-red/80 hover:text-red hover:bg-red/10' : 'text-text-secondary hover:text-text-primary hover:bg-surface/40'
      }`}
    >
      <span>{label}</span>
      {hint && <span className="text-[9px] font-mono text-text-muted/50">{hint}</span>}
    </button>
  )
}

function MenuDivider() {
  return <div className="my-1 h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
}

/* ─── TreeNode ──────────────────────────────────────────────────────────── */

interface TreeNodeProps {
  node: FileNode
  depth: number
  activeFile: string | null
  openFile: (path: string) => Promise<void>
  expandedDirs: Set<string>
  toggleDir: (path: string) => void
  conflictedFiles: Set<string>
  gitModified: Set<string>
  gitUntracked: Set<string>
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void
  renaming: string | null
  renameValue: string
  setRenameValue: (v: string) => void
  commitRename: (path: string) => void
}

function TreeNode(props: TreeNodeProps) {
  const {
    node, depth, activeFile, openFile, expandedDirs, toggleDir,
    conflictedFiles, gitModified, gitUntracked,
    onContextMenu, renaming, renameValue, setRenameValue, commitRename,
  } = props
  const isExpanded = expandedDirs.has(node.path)
  const isActive = activeFile === node.path
  const indent = depth * 12 + 8
  const hasConflict = conflictedFiles.has(node.path)
  const isRenaming = renaming === node.path
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus()
      const dot = renameValue.lastIndexOf('.')
      inputRef.current.setSelectionRange(0, dot > 0 ? dot : renameValue.length)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRenaming])

  const renameInput = (
    <input
      ref={inputRef}
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') commitRename(node.path) }}
      onBlur={() => commitRename(node.path)}
      onClick={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 bg-void/60 text-[11px] text-text-primary font-mono outline-none px-1 rounded"
      style={{ border: '0.5px solid rgba(0,200,255,0.4)' }}
    />
  )

  if (node.is_dir) {
    return (
      <div>
        <button
          onClick={() => toggleDir(node.path)}
          onContextMenu={(e) => onContextMenu(e, node)}
          className="w-full flex items-center gap-1.5 py-1 pr-2 hover:bg-surface/30 transition-colors duration-100 group"
          style={{ paddingLeft: indent }}
        >
          {isExpanded ? <ChevronDown size={11} className="text-text-muted shrink-0" /> : <ChevronRight size={11} className="text-text-muted shrink-0" />}
          {isExpanded ? <FolderOpen size={12} className="text-cyan shrink-0" /> : <Folder size={12} className="text-cyan/60 shrink-0" />}
          {isRenaming ? renameInput : (
            <span className="text-[11px] text-text-secondary group-hover:text-text-primary truncate">{node.name}</span>
          )}
        </button>
        {isExpanded && node.children && (
          <div>
            {node.children.map((child) => (
              <TreeNode key={child.path} {...props} node={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={() => openFile(node.path)}
      onContextMenu={(e) => onContextMenu(e, node)}
      className={`w-full flex items-center gap-1.5 py-1 pr-2 transition-all duration-100 group relative ${
        isActive ? 'text-text-primary' : 'hover:bg-surface/30 text-text-secondary hover:text-text-primary'
      }`}
      style={{ paddingLeft: indent, background: isActive ? 'rgba(0,200,255,0.07)' : undefined }}
    >
      {isActive && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-cyan rounded-r" style={{ boxShadow: '0 0 6px rgba(0,200,255,0.5)' }} />}
      <File size={11} className={isActive ? 'text-cyan shrink-0' : 'text-text-muted shrink-0'} />
      {isRenaming ? renameInput : (
        <span className="text-[11px] truncate flex-1 text-left">{node.name}</span>
      )}
      {hasConflict && <AlertTriangle size={10} className="text-orange mr-1 shrink-0" />}
      {/* A6: uncommitted-change dots (orange = modified, green = untracked) */}
      {!hasConflict && gitModified.has(node.path) && (
        <div className="w-1.5 h-1.5 rounded-full shrink-0 mr-0.5" title="Modified (uncommitted)"
          style={{ backgroundColor: '#FFA500', boxShadow: '0 0 4px rgba(255,165,0,0.5)' }}
        />
      )}
      {!hasConflict && !gitModified.has(node.path) && gitUntracked.has(node.path) && (
        <div className="w-1.5 h-1.5 rounded-full shrink-0 mr-0.5" title="Untracked"
          style={{ backgroundColor: '#00FF88', boxShadow: '0 0 4px rgba(0,255,136,0.5)' }}
        />
      )}
    </button>
  )
}
