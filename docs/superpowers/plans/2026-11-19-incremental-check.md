# Incremental Check and Non-Prose Skipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-check only changed paragraphs after an edit, and stop sending code to LanguageTool.

**Architecture:** A pure, bounded LRU of per-paragraph LanguageTool results lives in a new `paragraph-cache.ts`; `check.ts` routes its two `checkText` call sites through it. Cache misses of a run go to LanguageTool in one batched request. On the client, `docToText` moves to a new `doc-text.ts` and skips code blocks and inline code.

**Tech Stack:** Bun (`bun:test`), TypeScript, ProseMirror (`prosemirror-schema-basic` in tests), `node:crypto` for hashing.

**Spec:** `docs/superpowers/specs/2026-11-19-incremental-check-design.md`

## Global Constraints

- HTTP contract of `/api/languagetool/:id` unchanged: `{ content, language, shareToken }` in, `{ matches, language, checked }` out.
- Cache holds hashes and matches only, never document text. Key: `${code}:${sha1(paragraph)}`.
- Cache stores unfiltered matches; `filterLearnedWords` still runs per request, after the cache.
- Cache bounded: 2000 entries, paragraphs over 5000 chars are not cached.
- Misses of one run go in ONE request joined with `\n`. Never one request per paragraph.
- The plugin must never throw into ProseMirror.
- Repo style (AGENTS.md): always braces, early returns, named constants instead of magic values, enums instead of boolean params, functions under 30 chars, short why/what comments, no visibility changes without asking, minimal diff outside the feature.
- Amendment to spec: inline code is replaced by a placeholder token, not `\n` (see Task 3). A `\n` mid-sentence would split the sentence and the cache paragraph.

## Review Focus

- A match crossing a paragraph boundary must not be cached (cached offsets would be wrong). Test in Task 1.
- User B must not see user A's learned-word filtering: the cache holds unfiltered matches. Test in Task 1.
- Same text under two language codes must not collide. Test in Task 1.
- Mutating a returned match must not corrupt the cache. Test in Task 1.
- Empty, whitespace-only and `\n`-only input must return no matches and make no request. Test in Task 1.
- Inline code at paragraph start/end, adjacent code nodes, and a code-only document must not produce joined words, double placeholders or a request. Test in Task 3.
- A cold (empty cache) check must cost exactly one request per run. Test in Task 1.

---

### Task 1: Paragraph cache

**Files:**
- Create: `paragraph-cache.ts`
- Test: `__tests__/paragraph-cache.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAX_CACHED_PARAGRAPH_CHARS = 5000;
  export interface ParagraphResult<M> { matches: M[]; language: string }
  export interface ParagraphCache<M> {
    get(key: string): ParagraphResult<M> | undefined;
    set(key: string, value: ParagraphResult<M>): void;
    readonly size: number;
  }
  export function createParagraphCache<M>(maxEntries?: number): ParagraphCache<M>; // default 2000, LRU
  export async function checkByParagraphs<M extends { offset: number; length: number }>(
    text: string,
    code: string,
    check: (text: string, code: string) => Promise<ParagraphResult<M>>,
    cache: ParagraphCache<M>,
  ): Promise<ParagraphResult<M>>;
  ```

Behaviour of `checkByParagraphs`: split `text` on `\n` keeping each paragraph's offset; skip paragraphs that are empty or whitespace-only. Look up each by key; for misses call `check` once with the misses joined by `\n`, assign each returned match to the paragraph whose range `[batchStart, batchEnd]` (end inclusive) holds `match.offset`, store each paragraph's matches with offsets relative to the paragraph (`offset - batchStart`), then return all matches with offsets in `text` coordinates as fresh copies (cached objects are never returned or mutated). If any match in the batch runs past its paragraph's end, cache nothing from that batch. Do not cache paragraphs longer than `MAX_CACHED_PARAGRAPH_CHARS`. Returned `language`: the language `check` returned if it ran, else the first cached paragraph's stored language, else `code` when there is nothing to check.

- [ ] **Step 1: Write failing tests** in `__tests__/paragraph-cache.test.ts`. Use a fake `check` that counts calls and records its `text`, flagging every occurrence of `"bad"` as `{ offset, length: 3 }` with language `"en-US"`. Tests, named exactly:
  - `cold check makes one request for all paragraphs`: text `"a bad\nb bad\nc"` -> `calls === 1`, check received `"a bad\nb bad\nc"`, matches offsets `[2, 8]`.
  - `second identical check makes no request`: run twice, `calls === 1`, same matches both times.
  - `edit of one paragraph re-checks only that paragraph`: after caching `"a bad\nb bad"`, check `"a bad\nb bad!"` -> `calls === 2`, second request text `"b bad!"`, matches offsets `[2, 8]` in full-text coordinates.
  - `same text under another code is a separate entry`: `"en-US"` then `"es"` -> `calls === 2`.
  - `returned matches are copies`: mutate `result.matches[0].offset`, re-run, offset unchanged.
  - `empty and whitespace-only text makes no request`: `""`, `"\n\n"`, `"  \n "` -> `calls === 0`, `matches` `[]`, `language` equals `code`.
  - `match crossing a paragraph boundary is returned but not cached`: fake check returns `{ offset: 3, length: 5 }` for `"abcd\nefgh"`; second identical call -> `calls === 2`.
  - `paragraph over the size cap is not cached`: paragraph of `MAX_CACHED_PARAGRAPH_CHARS + 1` chars checked twice -> `calls === 2`.
  - `evicts least recently used past maxEntries`: `createParagraphCache(2)`, check `"p1"`, `"p2"`, re-check `"p1"` (hit), check `"p3"`, then `"p2"` misses and `"p1"` hits.
  - `cache stores unfiltered matches`: the matches in `cache.get(key)` equal the raw ones `check` returned (filtering is the caller's job; this pins that `checkByParagraphs` never drops matches).

- [ ] **Step 2: Run to verify failure.** Run: `bun test __tests__/paragraph-cache.test.ts`. Expected: FAIL, cannot find module `../paragraph-cache`.

- [ ] **Step 3: Implement `paragraph-cache.ts`** per the interface above. Use `Map` for the LRU (delete and re-insert on `get`, evict `map.keys().next().value` on `set` past the cap) and `createHash("sha1")` from `node:crypto` for keys. Name the batch separator `"\n"` as a constant.

- [ ] **Step 4: Run to verify pass.** Run: `bun test __tests__/paragraph-cache.test.ts`. Expected: all pass.

- [ ] **Step 5: Commit** (only if the user asked for commits): stage `paragraph-cache.ts` and `__tests__/paragraph-cache.test.ts`; subject `Add per-paragraph check cache`.

---

### Task 2: Wire the cache into `check.ts`

**Files:**
- Modify: `check.ts` (`checkText` call sites in `action`, around the auto-language branch and the explicit-language branch; import `createParagraphCache`, `checkByParagraphs`)

**Interfaces:**
- Consumes: `createParagraphCache`, `checkByParagraphs`, `ParagraphResult` (Task 1); existing `checkText(text, language): Promise<{ matches: LTMatch[]; language: string }>`.
- Produces: module-level `const paragraphCache = createParagraphCache<LTMatch>()` and a local `checkCached(text: string, code: string)` with the same return shape as `checkText`.

- [ ] **Step 1: Add the cache and `checkCached`** in `check.ts`: `checkCached` calls `checkByParagraphs(text, code, checkText, paragraphCache)`. Replace the two `checkText(...)` calls in `action` (inside the `checkByRuns` callback and the explicit-language branch) with `checkCached(...)`. Leave `filterLearnedWords` calls exactly where they are, after the cache. Add one comment above the cache saying why it exists (per-paragraph reuse, unfiltered, in-memory, lost on restart).

- [ ] **Step 2: Typecheck.** `check.ts` imports `~/lib/*` from loica, so it cannot run in this repo alone. In a loica checkout with this extension at `app/extensions/languagetool` run `bun run typecheck`. Expected: no errors in `app/extensions/languagetool`. If no loica checkout is available, say so in the report and rely on Task 4.

- [ ] **Step 3: Run this repo's tests.** Run: `bun test`. Expected: all pass.

- [ ] **Step 4: Commit** (only if asked): stage `check.ts`; subject `Check through the paragraph cache`.

---

### Task 3: Skip code in `docToText`

**Files:**
- Create: `doc-text.ts` (moved from `languagetool-plugin.ts`: `Seg`, `docToText`, `offsetToPos`)
- Modify: `languagetool-plugin.ts` (delete the moved definitions, import them)
- Test: `__tests__/doc-text.test.ts`

Requires approval first: moving these three from the plugin to a new module exports them. Ask the user before starting; this is the visibility change the spec flagged.

**Interfaces:**
- Produces (same shapes as today):
  ```ts
  export interface Seg { textStart: number; pmFrom: number; len: number }
  export const CODE_BLOCK_NODE = "code_block";
  export const CODE_MARK = "code";
  export const CODE_PLACEHOLDER = "code";
  export function docToText(doc: PMNode): { text: string; segs: Seg[] };
  export function offsetToPos(segs: Seg[], offset: number): number | null;
  ```

Behaviour: a `code_block` node contributes no text (the existing block rule already puts `\n` before it; also emit one after so following text starts a new line). A text node carrying the `code` mark contributes one `CODE_PLACEHOLDER` to `text`, with no `Seg`, so a match on it maps to `null` and is dropped by `buildDecorations`. Consecutive code-marked text nodes in one inline run contribute one placeholder total.

- [ ] **Step 1: Write failing tests** in `__tests__/doc-text.test.ts` using `prosemirror-schema-basic` (`schema.marks.code`, `schema.nodes.code_block`). Names and assertions:
  - `code block produces no text and its own line break`: doc paragraph `"before"`, code_block `"npm install"`, paragraph `"after"` -> `text === "before\nafter"`.
  - `inline code becomes one placeholder`: paragraph `"Run "` + code `"npm install"` + `" now"` -> `text === "Run code now"`.
  - `placeholder has no segment`: for the above, `offsetToPos(segs, 4)` is `null` and `offsetToPos(segs, 0)` equals the PM position of `"R"`.
  - `text after inline code still maps to the right position`: `offsetToPos(segs, "Run code now".indexOf("now"))` equals the PM position of `"n"` in `"now"`.
  - `adjacent code nodes give one placeholder`: code `"a"` then code `"b"` (two nodes with the mark) -> `text === "code"`.
  - `code at paragraph start and end`: code + `" tail"` -> `"code tail"`; `"head "` + code -> `"head code"`.
  - `code-only document`: doc with a single code_block -> `text === ""` and `segs` `[]`.
  - `plain prose is unchanged`: paragraph `"Hello world"` plus paragraph `"Second"` -> `text === "Hello world\nSecond"`, same `segs` as the previous implementation (`textStart 0 len 11`, `textStart 12 len 6`).

- [ ] **Step 2: Run to verify failure.** Run: `bun test __tests__/doc-text.test.ts`. Expected: FAIL, cannot find module `../doc-text`.

- [ ] **Step 3: Implement `doc-text.ts`.** Move the three definitions unchanged from `languagetool-plugin.ts` (lines around 189-231), then add the skipping rules. Track "previous text node was code" in the `descendants` callback to collapse adjacent code nodes into one placeholder. Delete the originals from the plugin and add `import { docToText, offsetToPos, type Seg } from "./doc-text";`. Do not touch other plugin code.

- [ ] **Step 4: Run to verify pass.** Run: `bun test`. Expected: all pass, including existing `languagetool-plugin.test.ts`.

- [ ] **Step 5: Verify node and mark names against loica's schema.** In a loica checkout, grep its editor schema for the code block node and code mark names. If they are not `code_block` and `code`, change the two constants and note it in the report. If unavailable, say so.

- [ ] **Step 6: Commit** (only if asked): stage `doc-text.ts`, `languagetool-plugin.ts`, `__tests__/doc-text.test.ts`; subject `Skip code when serialising for checks`.

---

### Task 4: Acceptance on prod and README

**Files:**
- Modify: `README.md` (short note under "How inline highlighting works": paragraph cache and code skipping; keep it to a few lines)

- [ ] **Step 1: URL and email check against LanguageTool (decides masking).** On prod run:
  ```
  curl -s -XPOST localhost:8081/v2/check \
    --data-urlencode 'text=Escribe a juan.perez@acme.io o mira https://acme.io/qwzx y pide a @maria.' \
    --data 'language=es'
  ```
  Expected: report which of email, URL, mention LanguageTool flags. If none, no masking work. If some, open a follow-up task for exactly those; it is out of this plan.

- [ ] **Step 2: Baseline timing (before deploy).** On prod, time `POST /api/languagetool/:id` for one long document (about 30 paragraphs): first call and a call after changing one paragraph. Note both from the journal line `POST ... 200 - - <ms>`.

- [ ] **Step 3: Deploy and re-measure.** Pull the submodule in `/srv/loica/app/extensions/languagetool`, rebuild and restart loica as in `deploy-loica`, repeat Step 2.

- [ ] **Step 4: Acceptance.** Cold (first call after restart) no slower than the baseline within noise; call after a one-paragraph edit clearly faster; same underlines as before on the same text, except rules spanning paragraphs (list any that changed). If cold is slower or underlines differ otherwise, revert and report.

- [ ] **Step 5: README note and commit** (only if asked): stage `README.md`; subject `Document paragraph cache and code skipping`.
