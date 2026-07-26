/**
 * MissionControl — AI chat panel matching SVG radical concept.
 *
 * SVG Layout:
 *   - Beam border on left (cyan glowing 2px line)
 *   - Header: "Mission Control" title + model pill (purple) + close button
 *   - Context strip: file pills
 *   - Chat messages: AI (purple tint), User (cyan tint)
 *   - AI code response: dark bg, code with Apply/Copy buttons
 *   - Thinking indicator: 3 dots with cascade animation
 *   - Input area: placeholder + send arrow button
 *   - Bottom hint: ⌘K · attach file · switch model
 *
 * Wires to: invokeAi, applyCodeSnippet, chatHistory, isAiWriting, clearChatHistory
 */

import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Send, Paperclip, X, ImageIcon, Square } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useAgent } from '../../store/agentStore'
import { AgentRun } from '../Agent/AgentRun'
import { Bot } from 'lucide-react'

export function MissionControl() {
  const {
    chatHistory, invokeAi, isAiWriting, applyCodeSnippet,
    activeFile, streamingText, cancelAi, addChatMessage,
  } = useAppStore()

  const [prompt, setPrompt] = useState('')
  const [agentMode, setAgentMode] = useState(true)
  const { start: startAgent, running: agentRunning } = useAgent()
  const [attachedImage, setAttachedImage] = useState<{ base64: string; mimeType: string; preview: string } | null>(null)
  const msgsEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatHistory, streamingText])

  const busy = isAiWriting || agentRunning

  const handleSend = () => {
    if ((!prompt.trim() && !attachedImage) || busy) return
    // Agent mode runs the tool-using loop (it can read and search the project
    // before deciding); plain mode is a single-shot answer about what's open.
    if (agentMode && !attachedImage) {
      const task = prompt
      addChatMessage({ role: 'user', content: task })
      setPrompt('')
      startAgent(task)
      return
    }
    invokeAi(prompt, attachedImage ? { base64: attachedImage.base64, mimeType: attachedImage.mimeType } : undefined)
    setPrompt('')
    setAttachedImage(null)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string
      const base64 = dataUrl.split(',')[1]
      setAttachedImage({ base64, mimeType: file.type, preview: dataUrl })
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const renderMessageContent = (content: string) => {
    const parts = content.split(/```(\w+)?\r?\n([\s\S]*?)```/g)
    if (parts.length === 1) {
      return <div className="whitespace-pre-wrap text-[12px] leading-relaxed">{content}</div>
    }

    const blocks: JSX.Element[] = []
    let i = 0
    while (i < parts.length) {
      const text = parts[i]
      if (text) blocks.push(
        <div key={`t${i}`} className="whitespace-pre-wrap text-[12px] leading-relaxed mb-2">{text}</div>
      )
      const lang = parts[i + 1]
      const code = parts[i + 2]
      if (code !== undefined) {
        blocks.push(
          <div key={`c${i}`} className="relative my-2 rounded-[10px] overflow-hidden group"
            style={{
              background: 'rgba(0,4,14,0.9)',
              border: '0.5px solid rgba(0,200,255,0.3)',
            }}
          >
            {/* Top beam line */}
            <div className="h-[1px] w-full" style={{ background: 'rgba(0,200,255,0.3)' }} />
            <div className="flex items-center justify-between px-3 py-1.5 text-[12px] font-mono"
              style={{ color: '#A78BFA' }}
            >
              <span>AI · {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <pre className="px-3 pb-3 overflow-x-auto text-[12px] font-mono text-text-primary leading-relaxed">
              <code>{code}</code>
            </pre>
            {/* Apply / Copy buttons */}
            <div className="flex items-center justify-end gap-2 px-3 pb-2">
              <button
                onClick={() => navigator.clipboard.writeText(code)}
                className="px-3 py-1 rounded-full text-[12px]"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '0.5px solid rgba(255,255,255,0.08)',
                  color: '#64748B',
                }}
              >
                copy
              </button>
              <button
                onClick={() => applyCodeSnippet(code, lang ?? '')}
                disabled={isAiWriting}
                className="btn-beam text-[12px] px-3 py-1 disabled:opacity-50"
              >
                <span>✦ Apply</span>
              </button>
            </div>
          </div>
        )
      }
      i += 3
    }
    return <div>{blocks}</div>
  }

  return (
    <div className="mission-control">
      <AgentRun />
      {/* ─── Context strip ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 shrink-0"
        style={{
          height: '34px',
          background: 'rgba(0,0,0,0.2)',
          borderBottom: '0.5px solid rgba(255,255,255,0.05)',
        }}
      >
        <span className="text-[12px] text-text-muted">context:</span>
        {activeFile && (
          <div className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-mono"
            style={{
              background: 'rgba(0,200,255,0.08)',
              border: '0.5px solid rgba(0,200,255,0.3)',
              color: '#00C8FF',
            }}
          >
            {activeFile.split('/').pop()}
          </div>
        )}
      </div>

      {/* ─── Chat History ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {chatHistory.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center opacity-30">
            <div className="text-3xl font-display font-bold text-gradient mb-3">0G</div>
            <p className="text-[12px] text-text-secondary">I have access to your active file and project.</p>
            <p className="text-[12px] text-text-muted mt-1">What are we building?</p>
          </div>
        )}

        {chatHistory.map((msg) => (
          <motion.div
            key={msg.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className={`flex flex-col max-w-[95%] ${msg.role === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'}`}
          >
            <div className="rounded-[10px] px-3 py-2.5"
              style={msg.role === 'user' ? {
                background: 'rgba(0,200,255,0.07)',
                border: '0.5px solid rgba(0,200,255,0.2)',
              } : {
                background: 'rgba(139,92,246,0.07)',
                border: '0.5px solid rgba(139,92,246,0.2)',
              }}
            >
              {msg.role === 'assistant' && (
                <div className="text-[12px] mb-1.5" style={{ color: '#A78BFA' }}>
                  AI · {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
              {renderMessageContent(msg.content)}
            </div>
          </motion.div>
        ))}

        {/* T0-3: live streaming bubble — tokens render as they arrive */}
        {isAiWriting && streamingText && (
          <div className="flex flex-col mr-auto items-start max-w-[95%]">
            <div className="rounded-[10px] px-3 py-2.5"
              style={{
                background: 'rgba(139,92,246,0.07)',
                border: '0.5px solid rgba(139,92,246,0.2)',
              }}
            >
              <div className="text-[12px] mb-1.5" style={{ color: '#A78BFA' }}>
                AI · streaming
              </div>
              {renderMessageContent(streamingText)}
              <span
                className="inline-block w-[6px] h-[12px] ml-0.5 align-middle"
                style={{ backgroundColor: '#00C8FF', animation: 'cursorBlink 1s steps(2) infinite' }}
              />
            </div>
          </div>
        )}

        {/* Thinking indicator — before the first token lands */}
        {isAiWriting && !streamingText && (
          <div className="flex mr-auto items-start max-w-[90%]">
            <div className="flex items-center gap-1.5 px-4 py-2.5 rounded-full"
              style={{
                background: 'rgba(139,92,246,0.07)',
                border: '0.5px solid rgba(139,92,246,0.2)',
              }}
            >
              {[0, 0.2, 0.4].map((delay, di) => (
                <div
                  key={di}
                  className="w-1.5 h-1.5 rounded-full"
                  style={{
                    backgroundColor: '#A78BFA',
                    animation: `thinkDot 1.4s ease-in-out ${delay}s infinite`,
                  }}
                />
              ))}
              <span className="text-[12px] ml-1.5" style={{ color: '#A78BFA', opacity: 0.7 }}>thinking...</span>
            </div>
          </div>
        )}
        <div ref={msgsEndRef} />
      </div>

      {/* ─── Input Area ─────────────────────────────────────────────────── */}
      <div className="shrink-0" style={{
        background: 'rgba(0,4,14,0.7)',
        borderTop: '0.5px solid rgba(0,200,255,0.12)',
        padding: '12px',
      }}>
        {/* Image Preview */}
        <AnimatePresence>
          {attachedImage && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mb-2 flex items-center gap-2 px-2 py-1.5 rounded-lg overflow-hidden"
              style={{ background: 'rgba(0,200,255,0.06)', border: '0.5px solid rgba(0,200,255,0.15)' }}
            >
              <ImageIcon size={12} className="text-cyan shrink-0" />
              <img src={attachedImage.preview} alt="attachment" className="h-10 w-10 object-cover rounded" />
              <span className="text-[12px] text-text-muted flex-1 truncate">{attachedImage.mimeType}</span>
              <button onClick={() => setAttachedImage(null)} className="text-text-muted hover:text-red transition-colors">
                <X size={12} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-end gap-2">
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />

          {/* Input box */}
          <div className="flex-1 relative rounded-[10px] overflow-hidden"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '0.6px solid rgba(0,200,255,0.3)',
            }}
          >
            <div className="flex items-end">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-2 shrink-0 text-text-muted/40 hover:text-cyan transition-colors"
              >
                <Paperclip size={14} />
              </button>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleSend() }
                }}
                placeholder="Describe what you want to build..."
                className="flex-1 bg-transparent py-2.5 px-1 text-[12px] outline-none resize-none overflow-y-auto max-h-28 min-h-[38px] text-text-primary"
                style={{ '::placeholder': { color: '#2D3748' } } as React.CSSProperties}
                rows={Math.min(4, Math.max(1, prompt.split('\n').length))}
              />
            </div>
          </div>

          {/* Send / Stop button */}
          {isAiWriting ? (
            <button
              onClick={() => cancelAi()}
              className="shrink-0 rounded-[10px] flex items-center justify-center transition-all"
              style={{
                width: '38px',
                height: '38px',
                background: 'rgba(255,69,58,0.12)',
                border: '0.6px solid rgba(255,69,58,0.5)',
              }}
              title="Stop generation"
            >
              <Square size={12} className="text-red" fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={(!prompt.trim() && !attachedImage) || busy}
              className="shrink-0 rounded-[10px] flex items-center justify-center transition-all disabled:opacity-30"
              style={{
                width: '38px',
                height: '38px',
                background: 'rgba(0,200,255,0.15)',
                border: '0.6px solid rgba(0,200,255,0.5)',
              }}
            >
              <Send size={14} className="text-cyan" />
            </button>
          )}
        </div>

        {/* Bottom hint */}
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            className="agent-toggle"
            aria-pressed={agentMode}
            onClick={() => setAgentMode((v) => !v)}
            title={agentMode
              ? 'Agent can read and search your project before editing'
              : 'Single answer using only the open file'}
          >
            <Bot size={12} />
            {agentMode ? 'Agent' : 'Chat'}
          </button>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
            Ctrl+Enter to send
          </span>
        </div>
      </div>
    </div>
  )
}
