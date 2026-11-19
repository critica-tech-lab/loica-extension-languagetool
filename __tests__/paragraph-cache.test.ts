import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import {
  MAX_CACHED_PARAGRAPH_CHARS,
  checkByParagraphs,
  createParagraphCache,
  type ParagraphResult,
} from "../paragraph-cache";

interface M {
  offset: number;
  length: number;
}

const BAD = "bad";
const LANG = "en-US";

/** Fake LanguageTool: flags every "bad", counts calls, records request texts. */
function fakeCheck() {
  const texts: string[] = [];
  const check = async (text: string): Promise<ParagraphResult<M>> => {
    texts.push(text);
    const matches: M[] = [];
    let at = text.indexOf(BAD);
    while (at !== -1) {
      matches.push({ offset: at, length: BAD.length });
      at = text.indexOf(BAD, at + 1);
    }
    return { matches, language: LANG };
  };
  return { check, texts };
}

describe("checkByParagraphs", () => {
  test("cold check makes one request for all paragraphs", async () => {
    const { check, texts } = fakeCheck();
    const cache = createParagraphCache<M>();

    const res = await checkByParagraphs("a bad\nb bad\nc", "en-US", check, cache);

    expect(texts).toEqual(["a bad\nb bad\nc"]);
    expect(res.matches.map((m) => m.offset)).toEqual([2, 8]);
  });

  test("second identical check makes no request", async () => {
    const { check, texts } = fakeCheck();
    const cache = createParagraphCache<M>();

    const first = await checkByParagraphs("a bad\nb bad", "en-US", check, cache);
    const second = await checkByParagraphs("a bad\nb bad", "en-US", check, cache);

    expect(texts.length).toBe(1);
    expect(second.matches).toEqual(first.matches);
  });

  test("edit of one paragraph re-checks only that paragraph", async () => {
    const { check, texts } = fakeCheck();
    const cache = createParagraphCache<M>();

    await checkByParagraphs("a bad\nb bad", "en-US", check, cache);
    const res = await checkByParagraphs("a bad\nb bad!", "en-US", check, cache);

    expect(texts).toEqual(["a bad\nb bad", "b bad!"]);
    expect(res.matches.map((m) => m.offset)).toEqual([2, 8]);
  });

  test("same text under another code is a separate entry", async () => {
    const { check, texts } = fakeCheck();
    const cache = createParagraphCache<M>();

    await checkByParagraphs("a bad", "en-US", check, cache);
    await checkByParagraphs("a bad", "es", check, cache);

    expect(texts.length).toBe(2);
  });

  test("returned matches are copies", async () => {
    const { check } = fakeCheck();
    const cache = createParagraphCache<M>();

    const first = await checkByParagraphs("a bad", "en-US", check, cache);
    first.matches[0].offset = 99;
    const second = await checkByParagraphs("a bad", "en-US", check, cache);

    expect(second.matches[0].offset).toBe(2);
  });

  test("empty and whitespace-only text makes no request", async () => {
    const { check, texts } = fakeCheck();
    const cache = createParagraphCache<M>();

    for (const text of ["", "\n\n", "  \n "]) {
      const res = await checkByParagraphs(text, "en-US", check, cache);
      expect(res.matches).toEqual([]);
      expect(res.language).toBe("en-US");
    }
    expect(texts.length).toBe(0);
  });

  test("match crossing a paragraph boundary is returned but not cached", async () => {
    const texts: string[] = [];
    const crossing = async (text: string): Promise<ParagraphResult<M>> => {
      texts.push(text);
      return { matches: [{ offset: 3, length: 5 }], language: LANG };
    };
    const cache = createParagraphCache<M>();

    const first = await checkByParagraphs("abcd\nefgh", "en-US", crossing, cache);
    await checkByParagraphs("abcd\nefgh", "en-US", crossing, cache);

    expect(first.matches).toEqual([{ offset: 3, length: 5 }]);
    expect(texts.length).toBe(2);
  });

  test("paragraph over the size cap is not cached", async () => {
    const { check, texts } = fakeCheck();
    const cache = createParagraphCache<M>();
    const long = "x".repeat(MAX_CACHED_PARAGRAPH_CHARS + 1);

    await checkByParagraphs(long, "en-US", check, cache);
    await checkByParagraphs(long, "en-US", check, cache);

    expect(texts.length).toBe(2);
  });

  test("evicts least recently used past maxEntries", async () => {
    const { check, texts } = fakeCheck();
    const cache = createParagraphCache<M>(2);

    await checkByParagraphs("p1", "en-US", check, cache);
    await checkByParagraphs("p2", "en-US", check, cache);
    await checkByParagraphs("p1", "en-US", check, cache); // hit, p1 is now newest
    await checkByParagraphs("p3", "en-US", check, cache); // evicts p2
    expect(texts).toEqual(["p1", "p2", "p3"]);

    await checkByParagraphs("p1", "en-US", check, cache); // still cached
    expect(texts.length).toBe(3);
    await checkByParagraphs("p2", "en-US", check, cache); // evicted
    expect(texts.length).toBe(4);
  });

  test("cache stores unfiltered matches", async () => {
    const raw: M[] = [{ offset: 2, length: 3 }];
    const check = async (): Promise<ParagraphResult<M>> => ({ matches: raw, language: LANG });
    const cache = createParagraphCache<M>();

    await checkByParagraphs("a bad", "en-US", check, cache);

    expect(cache.get(keyFor("a bad", "en-US"))?.matches).toEqual(raw);
  });
});

/** Mirrors the module's documented key format: `${code}:${sha1(paragraph)}`. */
function keyFor(paragraph: string, code: string): string {
  return `${code}:${createHash("sha1").update(paragraph).digest("hex")}`;
}
