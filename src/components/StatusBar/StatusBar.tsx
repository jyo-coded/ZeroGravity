/**
 * StatusBar — fixed bottom bar with project info, canvas stats, cursor position.
 *
 * Wires to: project, activeFile, collaborators, changelog
 */

import { useAppStore } from '../../store/appStore'

export function StatusBar() {
  const { project, activeFile, collaborators, changelog, fileTree, isAiWriting } = useAppStore()

  const online = collaborators.filter((c) => c.status !== 'offline').length
  const totalFiles = countFiles(fileTree)

  return (
    <div className="status-bar">
      <div className="flex items-center gap-3">
        {/* Project */}
        <span className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-cyan" />
          <span>{project?.name ?? 'No project'}</span>
        </span>

        <span className="text-border">|</span>

        {/* Files */}
        <span>{totalFiles} files</span>

        <span className="text-border">|</span>

        {/* Peers */}
        <span>{online} peer{online !== 1 ? 's' : ''} online</span>

        <span className="text-border">|</span>

        {/* Changelog */}
        <span>{changelog.length} changes</span>
      </div>

      <div className="flex items-center gap-3">
        {isAiWriting && (
          <span className="text-cyan animate-pulse">AI writing...</span>
        )}
        {activeFile && (
          <span className="text-text-muted/60">{activeFile}</span>
        )}
      </div>
    </div>
  )
}

function countFiles(nodes: any[]): number {
  let count = 0
  for (const n of nodes) {
    if (!n.is_dir) count++
    if (n.children) count += countFiles(n.children)
  }
  return count
}
