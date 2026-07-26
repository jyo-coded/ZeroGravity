/**
 * TeamPanel — slide-in team surface (T1): live roster, team chat, and the
 * manual WAN connect ("your address" + connect-by-ip) for peers UDP discovery
 * can't reach. Chat + connect both ride the encrypted mesh.
 */

import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Send, Plug, Copy, Check } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'

const STATUS_COLOR: Record<string, string> = {
  idle: '#64748B', writing: '#00C8FF', reviewing: '#FFA500', offline: '#2D3748',
}

export function TeamPanel() {
  const { collaborators, teamChat, sendTeamChat, addNotification } = useAppStore()
  const [text, setText] = useState('')
  const [net, setNet] = useState<{ ip: string; tcp_port: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const [connectAddr, setConnectAddr] = useState('')
  const [connecting, setConnecting] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getNetworkInfo().then((n) => setNet({ ip: n.ip, tcp_port: n.tcp_port })).catch(() => setNet(null))
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [teamChat.length])

  const myAddr = net ? `${net.ip}:${net.tcp_port}` : '—'

  async function connect() {
    const a = connectAddr.trim()
    if (!a) return
    setConnecting(true)
    try {
      await api.connectPeer(a)
      addNotification({ type: 'peer_join', detail: 'Connecting', message: `Reaching out to ${a}…` })
      setConnectAddr('')
    } catch (e: any) {
      addNotification({ type: 'error', detail: 'Connect Failed', message: String(e) })
    } finally {
      setConnecting(false)
    }
  }

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 300, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="shrink-0 flex flex-col glass-panel overflow-hidden relative z-30"
      style={{ borderRight: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div className="px-3 py-2.5 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <span className="text-[12px] font-mono tracking-[0.2em] uppercase" style={{ color: 'rgba(0,200,255,0.5)' }}>
          Team
        </span>
      </div>

      {/* Roster */}
      <div className="px-2 py-2 shrink-0" style={{ borderBottom: '0.5px solid rgba(255,255,255,0.05)' }}>
        {collaborators.map((c) => (
          <div key={c.id} className="flex items-center gap-2 px-1 py-1">
            <div className="relative shrink-0">
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold"
                style={{ backgroundColor: c.avatar_color, color: '#000408' }}
              >
                {c.username.slice(0, 2).toUpperCase()}
              </div>
              <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border"
                style={{ backgroundColor: STATUS_COLOR[c.status] ?? '#2D3748', borderColor: '#02040C' }}
              />
            </div>
            <span className="text-[12px] text-text-primary truncate flex-1">
              {c.username}{c.is_self && <span className="text-text-muted"> (you)</span>}
            </span>
            {c.current_file && !c.is_self && (
              <span className="text-[12px] font-mono text-cyan/60 truncate max-w-[90px]" title={c.current_file}>
                {c.current_file.split('/').pop()}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Chat log */}
      <div ref={logRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {teamChat.length === 0 && (
          <p className="text-[12px] text-text-muted/40 text-center mt-4">
            No messages yet — say hello to your team
          </p>
        )}
        {teamChat.map((m) => (
          <div key={m.id} className={`flex flex-col ${m.isSelf ? 'items-end' : 'items-start'}`}>
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[12px] font-semibold" style={{ color: m.color }}>{m.username}</span>
              <span className="text-[11px] text-text-muted/50">
                {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div className="text-[12px] text-text-primary rounded-lg px-2.5 py-1.5 max-w-[240px] break-words"
              style={m.isSelf
                ? { background: 'rgba(0,200,255,0.08)', border: '0.5px solid rgba(0,200,255,0.2)' }
                : { background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)' }}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>

      {/* Chat input */}
      <div className="p-2 shrink-0" style={{ borderTop: '0.5px solid rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-1.5 rounded-lg px-2"
          style={{ background: 'rgba(255,255,255,0.04)', border: '0.6px solid rgba(0,200,255,0.25)' }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { sendTeamChat(text); setText('') } }}
            placeholder="Message the team…"
            className="flex-1 min-w-0 bg-transparent py-2 text-[12px] text-text-primary placeholder-text-dim outline-none"
          />
          <button
            onClick={() => { sendTeamChat(text); setText('') }}
            disabled={!text.trim()}
            className="p-1 text-cyan disabled:opacity-30"
          >
            <Send size={13} />
          </button>
        </div>
      </div>

      {/* WAN connect */}
      <div className="p-2 shrink-0 space-y-1.5" style={{ borderTop: '0.5px solid rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-mono tracking-widest uppercase text-text-muted/50">Your address</span>
          <code className="text-[12px] font-mono text-cyan/80 flex-1 truncate">{myAddr}</code>
          <button
            onClick={() => {
              if (!net) return
              navigator.clipboard.writeText(myAddr).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
            }}
            className="p-0.5 text-text-muted hover:text-cyan transition-colors"
            title="Copy address"
          >
            {copied ? <Check size={11} className="text-green" /> : <Copy size={11} />}
          </button>
        </div>
        <div className="flex items-center gap-1.5 rounded-lg px-2"
          style={{ background: 'rgba(255,255,255,0.03)', border: '0.5px solid rgba(255,255,255,0.08)' }}
        >
          <Plug size={11} className="text-text-muted shrink-0" />
          <input
            value={connectAddr}
            onChange={(e) => setConnectAddr(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') connect() }}
            placeholder="peer ip:port (WAN)"
            className="flex-1 min-w-0 bg-transparent py-1.5 text-[12px] font-mono text-text-primary placeholder-text-dim outline-none"
          />
          <button
            onClick={connect}
            disabled={connecting || !connectAddr.trim()}
            className="text-[12px] font-mono px-2 py-0.5 rounded-full disabled:opacity-30 shrink-0"
            style={{ background: 'rgba(0,200,255,0.1)', border: '0.5px solid rgba(0,200,255,0.4)', color: '#00C8FF' }}
          >
            {connecting ? '…' : 'Connect'}
          </button>
        </div>
        <p className="text-[11px] text-text-muted/40 leading-tight">
          Same LAN auto-discovers. Across networks, share your address (port-forward may be needed).
        </p>
      </div>
    </motion.div>
  )
}
