/**
 * Dev-only Tauri shim.
 *
 * The app talks to a Rust backend through Tauri's IPC. Opened in a plain
 * browser (which is how UI iteration is fastest), those internals are absent
 * and the app crashes before first paint — so the UI could only ever be
 * reviewed by running the full desktop build.
 *
 * This provides the minimum surface for the shell to render with empty data.
 * It is imported behind `import.meta.env.DEV`, so bundlers drop it entirely
 * from production builds, and it no-ops inside the real desktop app where the
 * genuine internals already exist.
 */
export function installDevTauriShim() {
  const w = window as unknown as Record<string, unknown>
  if (w.__TAURI_INTERNALS__) return // real Tauri — never shadow it

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    invoke: async (cmd: string) => {
      // Git: report "no repository" rather than null, so panels take their real
      // empty path instead of a crash path that only exists in the browser.
      if (cmd === 'git_status_full') {
        return { is_repo: false, branch: '', upstream: null, ahead: 0, behind: 0, changes: [] }
      }
      if (cmd === 'git_branches') return { current: '', local: [] }
      if (cmd === 'revert_session') return []
      if (cmd === 'dap_running') return false
      if (cmd === 'suggest_project_dir') return 'C:\\Users\\you\\Documents\\0G\\demo'
      if (/^dap_/.test(cmd)) return null // no debugger in a plain browser
      if (/^git_/.test(cmd)) return []
      if (/tree|list|recent|search|collaborators|usage|rotation|skills/i.test(cmd)) return []
      if (/graph/i.test(cmd)) return { nodes: [], edges: [] }
      if (/read_file|open_file|format/i.test(cmd)) return ''
      if (/detect/i.test(cmd)) return {}
      return null
    },
    transformCallback: (cb: unknown) => {
      const id = Math.floor(Math.random() * 1e9)
      w[`_${id}`] = cb
      return id
    },
    convertFileSrc: (p: string) => p,
  }

  // Event plugin: listeners register and are never fired in the browser.
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }

  console.info('[0G] dev Tauri shim active — backend calls return empty data')
}
