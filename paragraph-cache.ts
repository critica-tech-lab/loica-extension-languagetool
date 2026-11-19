/**
 * Per-paragraph cache of LanguageTool results.
 *
 * Every pause in typing re-checks the whole document. Most paragraphs did not
 * change, so their result is reused and only the new ones go to LanguageTool,
 * all in one request:
 *
 *   "A.\nB.\nC."  (A and C cached)  ->  check("B.")  ->  merge  ->  matches
 *
 * Only unfiltered matches are stored. Per-user filtering (learned words) is the
 * caller's job, after this, so one user's words never reach another's result.
 * Keys are hashes and values are matches, so no document text is kept.
 */
import { createHash } from "node:crypto";

export const MAX_CACHED_PARAGRAPH_CHARS = 5000;

const DEFAULT_MAX_ENTRIES = 2000;
const PARAGRAPH_BREAK = "\n";
const KEY_HASH = "sha1";

export interface ParagraphResult<M> {
  matches: M[];
  language: string;
}

export interface ParagraphCache<M> {
  get(key: string): ParagraphResult<M> | undefined;
  set(key: string, value: ParagraphResult<M>): void;
  readonly size: number;
}

/** Bounded least-recently-used cache. */
export function createParagraphCache<M>(
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): ParagraphCache<M> {
  const entries = new Map<string, ParagraphResult<M>>();

  return {
    get(key) {
      const value = entries.get(key);
      if (!value) {
        return undefined;
      }

      // Re-insert so the entry counts as the most recently used.
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
  };
}

interface Paragraph {
  text: string;
  /** Offset of the paragraph in the full text. */
  start: number;
  key: string;
}

function cacheKey(code: string, paragraph: string): string {
  return `${code}:${createHash(KEY_HASH).update(paragraph).digest("hex")}`;
}

/** Non-blank paragraphs with their offsets in `text`. */
function splitParagraphs(text: string, code: string): Paragraph[] {
  const out: Paragraph[] = [];
  let start = 0;

  for (const part of text.split(PARAGRAPH_BREAK)) {
    if (part.trim()) {
      out.push({ text: part, start, key: cacheKey(code, part) });
    }
    start += part.length + PARAGRAPH_BREAK.length;
  }
  return out;
}

/**
 * Check `text`, asking `check` only about paragraphs the cache has not seen.
 * Returned matches are fresh copies with offsets in `text` coordinates.
 */
export async function checkByParagraphs<M extends { offset: number; length: number }>(
  text: string,
  code: string,
  check: (text: string, code: string) => Promise<ParagraphResult<M>>,
  cache: ParagraphCache<M>,
): Promise<ParagraphResult<M>> {
  const paragraphs = splitParagraphs(text, code);
  if (paragraphs.length === 0) {
    return { matches: [], language: code };
  }

  // Matches per paragraph with offsets relative to the paragraph.
  const relative = new Map<string, M[]>();
  const misses: Paragraph[] = [];
  let language: string | undefined;

  for (const p of paragraphs) {
    const hit = cache.get(p.key);
    if (!hit) {
      misses.push(p);
      continue;
    }
    relative.set(p.key, hit.matches);
    language ??= hit.language;
  }

  if (misses.length > 0) {
    const fresh = await checkMisses(misses, code, check);
    language = fresh.language;

    for (const [p, matches] of fresh.byParagraph) {
      relative.set(p.key, matches);
      if (fresh.cacheable && p.text.length <= MAX_CACHED_PARAGRAPH_CHARS) {
        cache.set(p.key, { matches, language: fresh.language });
      }
    }
  }

  const matches = paragraphs.flatMap((p) =>
    (relative.get(p.key) ?? []).map((m) => ({ ...m, offset: m.offset + p.start })),
  );
  return { matches, language: language ?? code };
}

/**
 * One request for all misses, joined by paragraph breaks. Each match goes to
 * the paragraph holding its start. A match that runs past its paragraph would
 * be wrong once the neighbours change, so then nothing from this batch is cached.
 */
async function checkMisses<M extends { offset: number; length: number }>(
  misses: Paragraph[],
  code: string,
  check: (text: string, code: string) => Promise<ParagraphResult<M>>,
): Promise<{
  byParagraph: Array<[Paragraph, M[]]>;
  language: string;
  cacheable: boolean;
}> {
  const batch = misses.map((p) => p.text).join(PARAGRAPH_BREAK);
  const res = await check(batch, code);

  let at = 0;
  let cacheable = true;
  const byParagraph = misses.map((p): [Paragraph, M[]] => {
    const from = at;
    const to = from + p.text.length;
    at = to + PARAGRAPH_BREAK.length;
    return [p, res.matches.filter((m) => m.offset >= from && m.offset <= to).map((m) => {
      if (m.offset + m.length > to) {
        cacheable = false;
      }
      return { ...m, offset: m.offset - from };
    })];
  });

  return { byParagraph, language: res.language, cacheable };
}
