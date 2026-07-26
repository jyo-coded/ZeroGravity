# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Delivered as a Tauri v2 desktop application (Rust backend + React/TypeScript frontend,
WebView2 on Windows). The UI is web technology; the target platform is desktop.

## Users

Primary: **developers who write code with an AI assistant and need to prove what the AI
changed.** Two situations drive the product:

1. Solo developer working on a real codebase who wants an agentic AI that edits multiple
   files reliably — and wants to review every change before it lands.
2. Two or more developers pair-programming over a direct peer-to-peer connection with no
   server in the middle, on untrusted or flaky networks.

Immediate evaluation audience: **hackathon/forum judges** who will open the product cold,
poke at features in depth, and ask adversarial questions about what is real vs. demo-ware.

## Product Purpose

0G ("Zero Gravity") is an AI-native code editor. It exists to make AI-authored code
**trustworthy**: the AI acts as an engine that edits the codebase directly, and every edit
it makes is reviewable before it lands and cryptographically recorded after it lands.

Success means a developer can hand a real task to the agent, watch it work across multiple
files, accept or reject its changes hunk by hunk, and later prove exactly which lines were
written by a human and which by a model.

## Positioning

The mechanism a neighbouring product cannot truthfully copy: **a serverless, end-to-end
encrypted collaboration mesh combined with a cryptographically signed audit ledger of AI
provenance.**

- Zed has multiplayer, but it is routed through Zed's own servers and has no AI provenance
  ledger.
- Cursor / Antigravity have strong agents, but no verifiable record of AI authorship and no
  serverless peer-to-peer collaboration.
- 0G's collaboration requires no backend service at all (UDP discovery + encrypted TCP
  mesh), and its changelog is an append-only encrypted ledger (XChaCha20-Poly1305, Argon2id)
  that records who — or which model — authored every change.

Bring-your-own-model is a first-class constraint, not an afterthought: users supply their
own provider keys, and no code is sent to a vendor the user did not choose.

## Operating Context

- Desktop application, primarily Windows 11; developers keep it open for long sessions.
- Works against a local filesystem project directory; a background scanner maintains a
  context map and a tree-sitter code graph.
- Network conditions for collaboration are assumed hostile: peers disconnect mid-session,
  Wi-Fi is flaky, sessions last hours.
- Model providers are rate-limited and can hang or fail; the product must degrade rather
  than stall.
- Evaluation context: live demonstration in front of judges who will test edge cases.

## Capabilities and Constraints

**Confirmed and working today**
- Monaco-based code editing with a bundled (offline) editor and language workers.
- Encrypted changelog / audit ledger: XChaCha20-Poly1305 with Argon2id key derivation,
  atomic writes, bounded growth.
- Orchestrator: a first-come-first-served write gatekeeper that all writes (human, AI, and
  remote peer) pass through; conflict detection currently flags rather than resolves.
- Peer-to-peer mesh: UDP discovery plus an encrypted TCP mesh; deterministic peer-id
  tie-break so a pair opens exactly one connection.
- Live co-editing via Yjs CRDT relayed over the mesh.
- Multi-provider model layer with ordered rotation and failover, plus response streaming.
- Language Server Protocol host.
- tree-sitter code graph feeding a dependency visualisation.

**Known gaps this build must close** (verified absent in the codebase)
- No inline completion (ghost text).
- No integrated terminal (the control exists but is disabled).
- No git integration of any kind.
- No hunk-level review of AI edits; AI application currently rewrites whole files via a
  second model call, which is non-deterministic and unreviewable.
- No multi-file agent loop with tool use.
- No semantic/embedding index; retrieval is keyword plus code graph only.
- No debugger.

**Technical constraints**
- The editor surface is Monaco inside WebView2. A native GPU-rendered editor (Zed's GPUI)
  is out of scope; the achievable target is a VS Code-class web editor, which is the same
  architecture family as Antigravity.
- WebGL is unreliable in this WebView; visualisations must degrade to SVG/DOM.
- Everything must work offline and without a company backend.

**Terminology**
- *Ledger* — the encrypted, append-only changelog of every change.
- *Orchestrator* — the single write gatekeeper.
- *Provenance* — the recorded authorship (human vs. specific model) of a change.
- *Mesh* — the serverless peer-to-peer collaboration network.

## Brand Commitments

- Product name **0G / Zero Gravity**; the "0G" wordmark is in use.
- The visual identity is a deep-space / cosmic world (near-black background, cyan and
  violet accents, subtle glow and starfield atmosphere). Confirmed binding: the cosmic
  identity is retained as **atmosphere and accent over a professional, deterministic
  editor layout** — not as the layout structure itself.
- Voice: precise and technical, not playful.

## Evidence on Hand

- Working encrypted ledger, P2P mesh, CRDT co-editing, model rotation, and LSP host in the
  repository — these are real and demonstrable, not mockups.
- No benchmarks, user studies, testimonials, customers, or press exist. None may be
  fabricated or implied in any surface.
- Comparison claims about Zed and Antigravity must stay factual: Zed is a native Rust
  editor with server-routed multiplayer; Antigravity is a VS Code–derived agentic IDE.

## Product Principles

1. **Reviewable over automatic.** The agent may edit anything, but a human sees a diff and
   accepts or rejects before it lands. No silent whole-file rewrites.
2. **Provenance is the product.** Every change — human or model — is attributable and
   verifiable. Features should feed the ledger, not bypass it.
3. **Serverless by construction.** No capability may require a 0G-operated backend.
   Collaboration and AI both run on infrastructure the user controls.
4. **Degrade, never hang.** Rate limits, dead peers, missing GPUs, and slow models produce
   a clear state and a path forward — never an operation that spins forever or loses data.
5. **Structure earns the polish.** The interface must be predictable and dense like a
   professional tool first; the cosmic identity is expressed in material and detail, never
   by making layout unpredictable.

## Accessibility & Inclusion

- Long-session legibility is a product requirement: UI text must not fall below a readable
  size (the current interface's 8–10px labels are a defect to correct).
- Full keyboard operation is required — every panel, palette, and review action reachable
  without a mouse.
- Motion must respect `prefers-reduced-motion`.
