# loica-extension-languagetool

**Inline** grammar / spelling / style checking for Loica, powered by a
**self-hosted LanguageTool server**. Issues are underlined (wavy) directly in
the editor; click an underline to see the explanation and apply a suggested
fix. **Read-only until you accept** — the document only changes when you click a
suggestion.

Lives out-of-root and is symlinked into `app/extensions/languagetool`, mirroring
`loica-extension-translation`.

## Architecture

| File | Role |
|------|------|
| `index.ts` | Client registry entry — contributes an `editorPlugins` factory. |
| `index.server.ts` | Server registry entry — makes the ext "enabled" so the plugin mounts. |
| `languagetool-plugin.ts` | The ProseMirror plugin: serialise → check → map offsets → inline decorations + click-to-fix popover. |
| `check.ts` | Route `action`: auth + POST to LanguageTool, returns trimmed `{ matches, language, checked }`. Never writes the doc. |

### How inline highlighting works

1. On load and after each edit (debounced ~1.2s), the plugin serialises the doc
   to **plain text**, recording an offset → ProseMirror-position map for every
   text run (block breaks become `\n`).
2. It POSTs the plain text to `/api/languagetool/:id`.
3. Each match's plain-text offset is mapped back to a PM range and rendered as
   an inline `Decoration` (wavy underline, coloured by issue type: red =
   spelling, amber = grammar, blue = style).
4. Clicking an underline opens a popover with the message + suggestion buttons;
   a button dispatches a replace transaction.

Decorations are editor-view state — **not synced over Yjs**, so each collaborator
checks their own view independently.

### Core seam this needs in loica (one-time)

Reuses a generic extension point rather than anything LT-specific:

- `app/extensions/types.ts` — `editorPlugins?(ctx)` field + `ExtensionEditorPluginContext`.
- `app/extensions/hooks.ts` — `useEditorPluginFactories()` (enabled exts' factories).
- `app/components/DocEditorView.tsx` — passes the factories to the editor.
- `app/components/ProseMirrorEditor.tsx` — mounts them in the plugin list (non-readOnly).
- `app/extensions/index.ts` / `index.server.ts` — register this extension.
- `app/routes/api.languagetool.$id.ts` — shim route re-exporting `check.ts`'s `action`.

The plugin imports `prosemirror-state` / `prosemirror-view` bare; the host's
`vite.config.ts` already `dedupe`s all PM packages, so it shares the editor's
single ProseMirror instance.

## Config (env, optional)

| Var | Default | Meaning |
|-----|---------|---------|
| `LANGUAGETOOL_URL` | `http://localhost:8081` | LanguageTool server base URL |

`defaultEnabled: false` — off on a fresh install (needs an external server). An
admin enables it from the Extensions panel once a server is reachable.

**Transport:** document text is POSTed to `LANGUAGETOOL_URL`, so a **non-local
server must be `https://`** — the extension refuses to send content to a remote
`http://` host. Plain `http://` is allowed only for loopback (`localhost`,
`127.0.0.1`, `::1`) for local dev. Examples:

```bash
LANGUAGETOOL_URL=http://localhost:8081       # local dev (loopback, ok)
LANGUAGETOOL_URL=https://lt.example.com      # remote (must be https)
```

### Run a LanguageTool server

```bash
docker run -d --rm -p 8081:8010 erikvl87/languagetool
# any server exposing POST /v2/check works (official image / local JAR)
```

LanguageTool is free/open-source (LGPL); the base rules (~30 languages) need no
license. Language is auto-detected per check.

## Install

```bash
ln -s /path/to/loica-extension-languagetool /path/to/loica/app/extensions/languagetool
# apply the core-seam edits above, then rebuild:
bun run build && restart
```
