import { Sparkles, Trash2, PanelRightClose } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useLayoutStore } from '../../store/layoutStore'
import { MissionControl } from '../MissionControl/MissionControl'
import { ModelPill } from '../MissionControl/ModelPill'
import { DiffReview } from '../Review/DiffReview'
import { useChangeSet } from '../../store/changeSetStore'

/**
 * The AI panel — a permanent dock, not a floating window.
 *
 * The agent is a first-class region of the workspace, always in the same place
 * beside the code it edits. Its header carries the two controls that belong to
 * the conversation itself (which model, clear history); everything about an
 * individual edit lives in the review UI inside.
 */
export function AiPanel() {
  const clearChatHistory = useAppStore((s) => s.clearChatHistory)
  const changeSet = useChangeSet((s) => s.changeSet)
  const { aiWidth, toggleAi } = useLayoutStore()

  return (
    <aside className="panel panel-ai" style={{ width: aiWidth }} aria-label="AI assistant">
      <header className="panel-header">
        <Sparkles size={14} style={{ color: 'var(--ai)' }} />
        <h2 className="panel-title">Mission Control</h2>
        <div style={{ flex: 1 }} />
        <ModelPill />
        <button className="btn btn-ghost btn-icon" onClick={() => clearChatHistory()} title="Clear conversation" aria-label="Clear conversation">
          <Trash2 size={14} />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={toggleAi} title="Hide AI panel (Ctrl+Shift+A)" aria-label="Hide AI panel">
          <PanelRightClose size={14} />
        </button>
      </header>
      {/* A pending change set takes over the panel. Reviewing beats chatting:
          nothing the model says next matters more than deciding on the code it
          just proposed, and splitting attention between the two loses edits. */}
      <div className="panel-body" style={{ overflow: 'hidden' }}>
        {changeSet ? <DiffReview /> : <MissionControl />}
      </div>
    </aside>
  )
}
