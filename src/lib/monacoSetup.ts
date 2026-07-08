/**
 * monacoSetup — bundle Monaco locally instead of loading it from a CDN.
 *
 * The default @monaco-editor/react loader fetches Monaco from jsdelivr at
 * runtime, which fails in a desktop webview that is offline or behind a
 * firewall — the editor then never renders. Here we (1) point the loader at
 * the npm `monaco-editor` we bundle, and (2) wire language workers through
 * Vite's ?worker imports so IntelliSense/validation run without the network.
 *
 * Imported for its side effects at the very top of main.tsx, before <App/>.
 */

import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// Monaco asks for a worker by language label; hand back the bundled one.
;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  },
}

// Use the bundled instance — no CDN fetch.
loader.config({ monaco })
