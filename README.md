# loica-extension-languagetool

**Inline** grammar / spelling / style checking for Loica, powered by a
**self-hosted LanguageTool server**. Issues are underlined (wavy) directly in
the editor; click an underline to see the explanation and apply a suggested
fix. **Read-only until you accept** — the document only changes when you click a
suggestion.

A self-contained extension folder under `app/extensions/languagetool`. Loica's
registry auto-discovers it at build time (glob) — nothing in core names it.
Upstream source of truth: `loica-extension-languagetool`.

## Architecture

| File | Role |
|------|------|
| `index.ts` | Client entry — `export default` a `LoicaExtension` that contributes an `editorPlugins` factory. |
| `index.server.ts` | Server entry — `export default` so the ext registers server-side (enablement + route gating). |
| `routes.ts` | `export default` the `/api/languagetool/:id` route, pointing straight at `check.ts` (no shim). |
| `languagetool-plugin.ts` | The ProseMirror plugin: serialise → check → map offsets → inline decorations + click-to-fix popover. |
| `check.ts` | Route `action`: auth + POST to LanguageTool, returns trimmed `{ matches, language, checked }`. Never writes the doc. |

### How it plugs into loica (zero core edits)

The extension relies only on loica's generic extension seams — the core has no
LanguageTool-specific code:

- **Discovery** — `app/extensions/index.ts` / `index.server.ts` / `routes.ts`
  glob `app/extensions/<name>/*` and register any that `export default`. Drop
  this folder in → registered; remove it → gone.
- **`editorPlugins` seam** — the client `index.ts` returns a ProseMirror plugin
  via `editorPlugins(ctx)`; the core mounts it (`ProseMirrorEditor.tsx`,
  non-readOnly). The plugin imports `prosemirror-state` / `prosemirror-view`
  bare; the host's `vite.config.ts` already `dedupe`s PM so it shares the
  editor's single instance.

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

Drop the folder in and rebuild — no core edits:

```bash
cp -R /path/to/loica-extension-languagetool /path/to/loica/app/extensions/languagetool
bun run build && restart
# then enable "languagetool" in the Extensions admin panel, with a reachable
# LANGUAGETOOL_URL in the environment.
```
