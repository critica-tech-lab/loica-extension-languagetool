# Incremental checks and non-prose skipping

Status: awaiting approval. Size: small change (two independent parts).

## Intent

Every pause in typing re-sends the whole document and LanguageTool re-checks
all of it. Documents vary a lot in length. Long ones load prod's single CPU
(shared with loica) on every pause. Separately, code is flagged as spelling
errors.

## Goals

- A check after a small edit costs about one paragraph of LanguageTool work,
  not the whole document.
- Code blocks and inline code are never sent to LanguageTool.

## Non-goals

- No change to the HTTP contract (`{ content, language, shareToken }` in,
  `{ matches, language, checked }` out).
- No client-side diffing or per-paragraph requests.
- No persistence of the cache across restarts.
- No new rules, languages or UI.

## Anti-goals

- A cached result must never leak between users or change what a user sees.
  Per-user learned words are applied after the cache, never stored in it.
- A cache or masking bug must not make the editor throw (existing rule:
  `languagetool-plugin.ts` never throws into ProseMirror).

## Constraints

- Prod: 1 vCPU, 1.9 GiB RAM shared with loica. Cache memory must be bounded.
- Document text is private. The cache key is a hash, and values are matches
  (offsets, messages, replacements), not document text.
- `splitRuns` merges neighbouring same-language sentences, so an English
  document is one run. Caching must happen below the run level.

## Approaches considered

1. **Server-side paragraph cache (chosen).** `check.ts` splits each run into
   paragraphs, looks each up by (language code, hash of paragraph text), sends
   only misses to LanguageTool, and shifts offsets back into full-text
   coordinates. Client unchanged.
2. Client sends only changed paragraphs. Less upload, but needs per-paragraph
   offset mapping, Yjs concurrent-edit handling and an API change. Upload is a
   few KB, the cost is LanguageTool, so the gain is small. Rejected.
3. Cache per run. Useless: a single-language document is one run, so any edit
   invalidates it. Rejected.

## Design

### Part 1: paragraph cache (`check.ts`, new `paragraph-cache.ts`)

- Split a run on `\n` into paragraphs, keeping offsets. Drop empty ones.
- `paragraph-cache.ts`: LRU keyed by `${code}:${sha1(text)}`, value = matches
  with offsets relative to the paragraph. Bounded by entry count (starting
  point: 2000, builder may tune) and a per-paragraph size cap so one huge
  paragraph is not cached.
- All missed paragraphs of a run go to `checkText` in ONE request, joined with
  `\n`; matches are then assigned to paragraphs by offset and cached per
  paragraph. A cold document therefore costs the same single request as today,
  and a warm one only pays for the paragraphs that changed. Do not send one
  request per paragraph: on one CPU that is slower than today.
- Cached matches are stored before `filterLearnedWords` and filtered per
  request, as today.
- Language of a cached entry is the code it was checked in (`en-US`, `es`), so
  a paragraph checked under a different language is a different key.
- Known loss: rules that look across paragraphs stop firing. Not measured; the
  builder should note which rule ids (if any) change in a before/after check.

### Part 2: skip non-prose (`languagetool-plugin.ts`, `docToText`)

- Skip `code_block` nodes and text carrying the `code` mark. Emit `\n` in
  their place so neighbouring words are not joined. The existing `segs` map
  already tolerates gaps (`offsetToPos` returns null for them).
- URL, email and mention masking is conditional. First run this against prod
  LanguageTool (it already skips some of these itself):

  ```
  curl -s -XPOST localhost:8081/v2/check \
    --data-urlencode 'text=Escribe a juan.perez@acme.io o mira https://acme.io/qwzx y pide a @maria.' \
    --data 'language=es'
  ```

  Mask only what it flags. If it flags none, ship Part 2 without masking.
- Node and mark names come from loica's schema, so the builder must check them
  there before relying on `code_block` / `code`.

## Acceptance (ship only if all hold)

Measure `POST /api/languagetool/:id` on a long document (about 30 paragraphs)
against a local LanguageTool, before and after:

1. Cold check: no slower than before (within noise).
2. After editing one paragraph: clearly faster than before.
3. Same matches as before for the same text, except rules that span
   paragraphs, which are listed. Any other difference is a bug.

If 1 or 3 fails, do not ship Part 1.

## Tests

- `paragraph-cache`: hit, miss, eviction, key differs by language, learned
  words still filter after a hit, offsets shifted correctly.
- `docToText`: code block and inline code produce no text and no joined words;
  offsets of surrounding text still map to the right positions.
- Run the repo's own checks (`bun run typecheck`, tests) and report output.

## Left to the builder

- Exact cache size and size cap.
- Whether to export `docToText` for testing (visibility change: ask first).
- Whether masking is needed, decided by the curl above.
