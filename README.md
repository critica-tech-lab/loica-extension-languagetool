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

1. On load and after each edit (debounced ~0.5s), the plugin serialises the doc
   to **plain text**, recording an offset → ProseMirror-position map for every
   text run (block breaks become `\n`).
2. It POSTs the plain text to `/api/languagetool/:id`.
3. Each match's plain-text offset is mapped back to a PM range and rendered as
   an inline `Decoration` (wavy underline, coloured by issue type: red =
   spelling, amber = grammar, blue = style).
4. Clicking a spelling underline opens a compact chip above the word
   (`[ best suggestion | ignore | more ]`). Grammar and style underlines open
   a popover with the message and suggestion buttons. Either dispatches a
   replace transaction.

Decorations are editor-view state — **not synced over Yjs**, so each collaborator
checks their own view independently.

Two things keep checks cheap and quiet:

- **Paragraph cache** (`paragraph-cache.ts`, used by `check.ts`). Results are
  cached per paragraph, keyed by language and a hash of the text. After an edit
  only the changed paragraphs go to LanguageTool, in one request. The cache is
  in memory, bounded, and holds no text. Learned words are applied after it, per
  user. Rules that look across paragraphs do not fire.
- **Code is skipped** (`doc-text.ts`). Code blocks are not sent. Inline code is
  replaced by the word `code`, so the sentence around it still reads normally.

### Which spellchecker is active

```
 edit -> debounce 0.5s -> POST /api/languagetool/:id -> LanguageTool
                                      |
              ok  -> LT underlines only, browser spellcheck OFF
              err -> footer: "Spelling check unavailable",
                     browser spellcheck ON (fallback)
```

The browser underlines misspellings on its own, with its own dictionary, so a
word could be underlined twice with different suggestions
(`native-spellcheck.ts`). Once LanguageTool answers, the editor turns the
browser's spellcheck off. If a check fails, the browser's comes back and the
footer shows "Spelling check unavailable" (hover for the reason). The message
clears on the next successful check. Without it, a broken `LANGUAGETOOL_URL`
looks like a document with no mistakes.

### Learned words and ignored suggestions

- **Add to dictionary** (chip menu) stores the word per user and language in
  `lt_learned_words` (`learned-words.server.ts`). The server drops matching
  `misspelling` matches after each check. It never hides grammar or style
  matches. Anonymous share-link viewers have no account, so they cannot learn
  words and see the unfiltered result.
- Adding a word shows an undo toast.
- **Ignore** hides that match (same rule and flagged text) in memory only, until
  the editor is reloaded.

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

### Production notes

Loica runs LanguageTool in Docker on the same host, bound to loopback (see
`deploy/README.md`):

```bash
cd deploy
docker build -t loica-languagetool:dict .
docker run -d --name loica-languagetool --restart unless-stopped \
  -p 127.0.0.1:8081:8010 -e Java_Xmx=768m --memory 1g loica-languagetool:dict
# loica .env: LANGUAGETOOL_URL=http://localhost:8081
```

- Sized for a 2 GB host shared with loica: heap 768m, container capped at 1 GiB.
  A runaway JVM is killed (and restarted) instead of starving loica. Check
  `docker inspect loica-languagetool --format '{{.State.OOMKilled}} {{.RestartCount}}'`.
- No n-gram data. They only power `CONFUSION_RULE` (their/there, its/it's), which
  helps English and does nothing measurable for Spanish. They need roughly 2 GB
  of heap and about 8 GB of disk for English alone.
- `LANGUAGETOOL_URL` is read from the process environment, so changing it needs a
  restart of loica.
- A 502 from `/api/languagetool/:id` means loica could not get a valid answer
  from LanguageTool: the container is down, the URL is wrong, or it points at a
  host that is not LanguageTool. The response body says which.

## Outcome counters

The editor counts how suggestions are used, to show whether they are worth
their noise: `opened` (the popover was opened), `accepted` (a suggestion was
applied) and `learned` ("add to dictionary"). Only counts per day and language
(`en`, `es`, `other`) are stored in `lt_stats`; there is no text and no user id.
Anonymous share-link viewers are not counted. Acceptance rate by language:

```sql
SELECT lang,
       SUM(CASE WHEN event = 'accepted' THEN count END) * 1.0 /
       SUM(CASE WHEN event = 'opened'   THEN count END) AS acceptance
FROM lt_stats GROUP BY lang;
```

## Install

Requires a loica build with the generic extension seam (auto-discovery +
`editorPlugins`), and `getUserDocAccess` from `~/lib/doc-access.server` (loica #136 or
later). No loica core edits.

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
