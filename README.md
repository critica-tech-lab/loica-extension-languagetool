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

### Mixed English/Spanish documents

With `language=auto` the server (`check.ts`) splits the text into sentences,
detects English or Spanish for each one (`languages.ts`, stopword based, no
network), merges neighbours of the same language into runs and checks each run
in its own language (`en-US` / `es`). LanguageTool's own `auto` picks one
language per request: on a document that is mostly English, every Spanish word
was flagged as a misspelling and Spanish errors were checked against the
English dictionary. A sentence with no signal ("OK.") takes its neighbour's
language. Matches carry the `lang` they were checked in, so "Add to
dictionary" stores the word under the right language. Only English and
Spanish are detected; text in another language falls back to LanguageTool's
`auto` when nothing in the document is recognised.

## Config (env, optional)

| Var | Default | Meaning |
|-----|---------|---------|
| `LANGUAGETOOL_URL` | `http://localhost:8081` | LanguageTool server base URL |

`defaultEnabled: false` — off on a fresh install (needs an external server). An
admin enables it from the Extensions panel once a server is reachable.

Port 8081 is often taken by another local service. If the URL points at
something that is not LanguageTool, the check fails with "The server at … did not
answer like LanguageTool (it said: …). Check LANGUAGETOOL_URL." Set the variable
to the port LanguageTool actually listens on (for example
`LANGUAGETOOL_URL=http://localhost:8010`).

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

Requires a loica build with the generic extension seam (auto-discovery +
`editorPlugins`). No loica core edits.

Installed as a git submodule, so the extension lives physically under `app/` and
its `routes.ts` points straight at `check.ts` — no symlink, no route shim:

```bash
cd /path/to/loica
git submodule add git@github.com:critica-tech-lab/loica-extension-languagetool.git \
  app/extensions/languagetool

# Build + restart, then enable "languagetool" in the Extensions admin panel
# with a reachable LANGUAGETOOL_URL in the environment.
bun run build && restart
```

Anyone cloning loica afterward gets it with `git submodule update --init
app/extensions/languagetool`. The pinned commit is tracked in loica, so the
installed version travels with the repo.

> Earlier installs symlinked this repo into `app/extensions/` and copied a shim
> into `app/routes/`, kept out of git via `.git/info/exclude`. That worked but
> left no versioned record of what was installed, and the out-of-root symlink
> broke React Router's server/client split unless the shim was present. The
> submodule layout removes both problems.
