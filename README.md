# ZeroGravity — 0G

> An AI-native, real-time collaborative code editor for teams — as a native desktop app.
> Open a project, invite your team with a 6-character code, and edit together with live
> cursors and a shared AI that has full structural context of your codebase. **Serverless:
> collaboration runs peer-to-peer over your LAN — no accounts, no backend, no cloud.**

Built with **Tauri v2** (Rust) + **React/TypeScript**, with **Monaco** as the editor.

---

## Why it's different

Most collaborative editors need a central server and cloud accounts. Most AI coding tools
lock you to one model and treat history as an afterthought. 0G is built around four ideas:

- **Serverless P2P** — teammates auto-discover on the LAN (UDP) and sync over an encrypted
  TCP mesh. Works air-gapped; join with a 6-char invite code. A manual connect-by-address
  fallback covers cross-network setups.
- **Encrypted, attributed AI ledger** — every change is recorded with *who × which model ×
  summary × affected lines*, sealed at rest with **XChaCha20-Poly1305** (key derived via
  **Argon2id**). It's a cryptographic audit trail, not just git history — and it doubles as
  the checkpoint layer beneath live editing.
- **Orchestrator write-gatekeeper** — every write (human, AI, or remote peer) passes through
  a single FCFS choke point that detects conflicts and commits to the ledger before touching
  disk or broadcasting.
- **BYOM everywhere** — bring your own model for chat *and* the code-merge engine. Keys stay
  on your machine.

---

## Features

### Collaboration
- **Live co-editing (CRDT)** — character-level conflict-free sync via Yjs, relayed over the
  encrypted mesh; the ledger checkpoints on save.
- **Presence** — live remote cursors and selections with name labels; click a teammate's
  avatar to follow their viewport.
- **Team chat** over the same encrypted mesh.
- **Encrypted wire** — every P2P frame is XChaCha20-Poly1305 sealed with a key derived from
  the invite code + shared passphrase; a wrong passphrase fails at the first frame.

### AI
- **BYOM** — OpenAI, Anthropic, Google Gemini, **Groq**, **OpenRouter**, Ollama (local), and
  any OpenAI-compatible endpoint.
- **Streaming** responses with a stop control; **multimodal** image attachments for
  vision-capable models.
- **Automatic failover & rotation** — build an ordered model list; on rate-limit (429) the
  same request retries the next provider, with proactive skipping against known free-tier caps.
- **Context re-establishment on model switch** — a `[MODEL HANDOFF]` block plus a freshly
  rebuilt context so a new model picks up cleanly.
- **Rich context pipeline** — every prompt is enriched with project structure, a semantic
  code-graph slice (imports / reverse-deps / definitions), the active file, referenced files,
  and recent teammate activity (see below).
- **Apply-merge** — "Apply" on any AI code block performs a context-aware merge into the
  target file through the orchestrator, not a blind overwrite.

### Editor
- **Language intelligence (LSP)** — hover, completion, signature help, go-to-definition /
  references / peek (cross-file), rename-symbol, diagnostics, and quick fixes via
  rust-analyzer, typescript-language-server, and pyright.
- **Semantic code graph** — a **tree-sitter** parser (Rust/TS/JS/Python/Go) builds a live
  graph of files, symbols, and imports, rendered as an interactive "constellation."
- **Full editor surface** — tabs (drag-reorder, split view), fuzzy file finder (Ctrl+P),
  symbol search (Ctrl+T), command palette (Ctrl+Shift+P), project-wide find & replace,
  format-on-command (rustfmt / black / prettier), and a Problems panel.
- **Git awareness** (read-only) — branch in the top bar, modified/untracked dots in the tree,
  and uncommitted diff gutters. Your ledger remains the source of truth for history.

---

## Getting started

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) + Cargo
- Tauri v2 prerequisites for your OS — see [tauri.app](https://tauri.app/start/prerequisites/)
- *Optional, for language intelligence:* `rust-analyzer`, `typescript-language-server`, `pyright`

### Run (dev)
```bash
npm install
npm run tauri dev      # compiles the Rust backend + opens the desktop app
```
> First run compiles all Rust crates (incl. tree-sitter grammars) — a few minutes; fast after.

### Build a release binary
```bash
npm run tauri build    # → src-tauri/target/release/bundle/
```

---

## Collaboration setup (P2P)

| Protocol | Port | Purpose |
|----------|------|---------|
| UDP | **47000** | Peer discovery broadcast (LAN) |
| TCP | dynamic | Encrypted data sync (CRDT, chat, ledger) |

1. One teammate creates a project → shares the **6-char invite code** + the **shared passphrase**.
2. Others join with the code + passphrase, pointing at a local folder.
3. Same LAN → auto-discovery. Across networks → paste a teammate's `ip:port` from the Team panel.

The passphrase both encrypts the changelog at rest and gates the wire — it never leaves the machine.

---

## AI context pipeline

Every AI call is assembled as:

```
[SYSTEM CONTEXT]   project type, folder tree, key files, README excerpt
[GRAPH CONTEXT]    imports / reverse-deps / definitions for the active file
Currently Open File + full content
[REFERENCED FILES] files mentioned in chat that exist in the project
[TEAM CONTEXT]     recent cross-file changes + per-file changelog
[MODEL HANDOFF]    (only when the serving model changed)
[USER REQUEST]     your message
```

---

## Architecture

```
src/                         React + TypeScript (Zustand state, Monaco editor)
├── components/
│   ├── Canvas/              floating editor cards + inline code constellation
│   ├── MissionControl/      AI chat, streaming, model rotation pill
│   ├── Explorer/            file tree + context-menu file ops
│   ├── Search/ Problems/    project find-replace, LSP diagnostics
│   ├── Team/                roster, chat, WAN connect
│   ├── QuickOpen/           Ctrl+P / Ctrl+T / command palette
│   └── LeftDock, TopBar, CockpitRing, Constellation, Notifications
├── lib/
│   ├── lsp.ts               Monaco ⇄ LSP client
│   ├── crdt.ts              Yjs binding + presence over the mesh
│   └── api.ts               Tauri command bindings
└── store/appStore.ts        global state

src-tauri/src/               Rust backend (Tauri v2)
├── commands.rs              Tauri command handlers
├── orchestrator.rs          FCFS write-gatekeeper + prompt enrichment
├── model.rs                 BYOM client (streaming, multimodal, multi-provider)
├── rotation.rs              failover, rate-cap tracking, model handoff
├── network.rs               P2P mesh: UDP discovery + encrypted TCP frames
├── changelog.rs             XChaCha20-Poly1305 + Argon2id encrypted ledger
├── graph.rs / parser.rs     tree-sitter semantic code graph
├── lsp.rs                   JSON-RPC language-server host
└── context_scanner.rs       background project watcher
```

---

## Security notes

- Changelog is encrypted at rest with **XChaCha20-Poly1305**; the key is derived from the
  project passphrase with **Argon2id**.
- P2P frames are individually sealed with the same primitives, keyed by invite code + passphrase.
- Model API keys are stored locally and never synced to teammates.

---

## Tech stack

**Backend:** Rust, Tauri v2, Tokio, tree-sitter, petgraph, RustCrypto (chacha20poly1305, argon2), reqwest
**Frontend:** React 18, TypeScript, Zustand, Monaco, Yjs, Framer Motion, Tailwind CSS

---

## License

MIT — see [LICENSE](LICENSE).
