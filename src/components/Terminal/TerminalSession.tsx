import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {
  ptySpawn, ptyWrite, ptyResize, onPtyOutput, onPtyExit, decodePtyChunk,
} from '../../lib/terminalApi'

interface Props {
  id: string
  cwd?: string
  /** Visible sessions render; hidden ones stay mounted so scrollback survives. */
  active: boolean
  onExit?: (code: number | null) => void
}

/**
 * One xterm.js view bound to one backend PTY.
 *
 * Kept mounted when inactive rather than unmounted, so switching terminal tabs
 * preserves scrollback and the running process — the thing that makes an
 * integrated terminal usable instead of a toy.
 *
 * Theme is read from the design tokens so the terminal is part of the product's
 * visual system rather than a black rectangle pasted into it.
 */
export function TerminalSession({ id, cwd, active, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const css = getComputedStyle(document.documentElement)
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback

    const term = new Terminal({
      fontFamily: v('--font-code', 'JetBrains Mono, monospace'),
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      // Transparent so the workspace's ground shows through — the terminal reads
      // as part of the app, not a pasted-in black box.
      theme: {
        background: 'rgba(0,0,0,0)',
        foreground: v('--text-primary', '#E7EDF8'),
        cursor: v('--accent', '#38BDF8'),
        cursorAccent: v('--bg-base', '#05070E'),
        selectionBackground: 'rgba(56,189,248,0.28)',
        black: '#0A0D18', red: '#F85149', green: '#3FB950', yellow: '#D29922',
        blue: '#58A6FF', magenta: '#A78BFA', cyan: '#38BDF8', white: '#AAB8CE',
        brightBlack: '#55607A', brightRed: '#FF7B72', brightGreen: '#56D364',
        brightYellow: '#E3B341', brightBlue: '#79C0FF', brightMagenta: '#BBA2FC',
        brightCyan: '#5CCBFA', brightWhite: '#E7EDF8',
      },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    let unlistenOut: (() => void) | undefined
    let unlistenExit: (() => void) | undefined
    let disposed = false

    ;(async () => {
      // Subscribe BEFORE spawning: a fast-starting shell prints its prompt
      // immediately, and a listener attached after the spawn would miss it.
      unlistenOut = await onPtyOutput((p) => {
        if (p.id === id) term.write(decodePtyChunk(p.data))
      })
      unlistenExit = await onPtyExit((p) => {
        if (p.id !== id) return
        term.write(`\r\n\x1b[38;5;244m[process exited${p.code !== null ? ` with code ${p.code}` : ''}]\x1b[0m\r\n`)
        onExit?.(p.code)
      })
      if (disposed) return

      fit.fit()
      try {
        await ptySpawn(id, term.cols, term.rows, cwd)
      } catch (e) {
        term.write(`\x1b[38;5;203mCould not start a shell: ${String(e)}\x1b[0m\r\n`)
        return
      }
      term.onData((d) => { ptyWrite(id, d).catch(() => {}) })
      term.focus()
    })()

    // Keep the PTY's window size in sync with the rendered grid, or full-screen
    // programs (vim, htop, anything using the alternate buffer) draw wrong.
    const ro = new ResizeObserver(() => {
      if (!active) return
      try {
        fit.fit()
        ptyResize(id, term.cols, term.rows).catch(() => {})
      } catch { /* element mid-layout */ }
    })
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      unlistenOut?.()
      unlistenExit?.()
      term.dispose()
      termRef.current = null
      // The PTY itself is intentionally NOT killed here — the owning panel
      // decides a session's lifetime, so a re-render never kills a shell.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Becoming visible: re-fit (a hidden element measures as zero) and take focus.
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (term) {
          ptyResize(id, term.cols, term.rows).catch(() => {})
          term.focus()
        }
      } catch { /* not laid out yet */ }
    }, 30)
    return () => clearTimeout(t)
  }, [active, id])

  return (
    <div
      ref={hostRef}
      className="terminal-host"
      style={{ display: active ? 'block' : 'none' }}
      data-terminal-id={id}
    />
  )
}
