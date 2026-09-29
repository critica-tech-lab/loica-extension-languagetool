/**
 * Per-sentence language detection for mixed English/Spanish documents.
 *
 * LanguageTool's `auto` picks ONE language for the whole request, so in a
 * document that mixes English and Spanish the minority language is checked
 * with the wrong rules and its errors are missed. Splitting the text into
 * single-language runs and checking each run with its own language fixes that.
 *
 *   "We met. El equipo llegó tarde. See you."
 *     |-- en --|------- es --------|-- en --|   -> 3 requests, 3 languages
 */

export type Lang = "en" | "es";

export interface Run {
  /** Offset of the run's first character in the full text. */
  start: number;
  /** Offset one past the run's last character. */
  end: number;
  /** Null when nothing in the text carries a language signal. */
  lang: Lang | null;
}

const LANG_CODES: Record<Lang, string> = { en: "en-US", es: "es" };
const AUTO = "auto";

// A language needs at least this many signal points to win a sentence.
const MIN_SIGNAL = 2;
// Characters that only Spanish uses are stronger evidence than one stopword.
const SPANISH_MARK_WEIGHT = 3;

// Common function words. Words shared by both languages ("a", "me", "no", "he")
// are left out on purpose: they would add noise to both scores.
const EN_WORDS = new Set(
  ("the and of to is are was were in that it for with this on as be by not have has you your " +
    "they their we our but or an at from will would should can its it's i my what which there " +
    "than then been more all if so does don't").split(" "),
);
const ES_WORDS = new Set(
  ("el la los las de del que y en un una es son fue por para con se su sus al lo como más pero " +
    "muy sin sobre este esta esto ese esa estos están está hay ya también nos le les mi tu yo " +
    "él ella ellos cuando donde porque si entre todos").split(" "),
);

const SPANISH_ONLY_MARKS = /[¿¡ñ]/g;
const ACCENTED_VOWELS = /[áéíóú]/g;
// A sentence ends at ".", "!" or "?" followed by whitespace, or at a newline.
const SENTENCE_END = /[.!?]+["')\]»”’]*\s+|\n+/g;

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** English or Spanish, or null when the text has too little signal to tell. */
export function detectLang(text: string): Lang | null {
  const lower = text.toLowerCase();
  const words = lower.match(/[\p{L}']+/gu) ?? [];

  let en = 0;
  let es = 0;
  for (const word of words) {
    if (EN_WORDS.has(word)) {
      en++;
    }
    if (ES_WORDS.has(word)) {
      es++;
    }
  }
  es += countMatches(lower, SPANISH_ONLY_MARKS) * SPANISH_MARK_WEIGHT;
  es += countMatches(lower, ACCENTED_VOWELS);

  if (es >= MIN_SIGNAL && es > en) {
    return "es";
  }
  if (en >= MIN_SIGNAL && en > es) {
    return "en";
  }
  return null;
}

/** Cut the text into sentence-sized pieces that cover it with no gaps. */
function sentences(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = 0;

  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    out.push({ start, end });
    start = end;
  }
  if (start < text.length) {
    out.push({ start, end: text.length });
  }
  return out;
}

/**
 * Split the text into runs of one language each. A sentence with no signal
 * ("OK.", a bare name) takes the language of its neighbour, so short fragments
 * never open a run of their own.
 */
export function splitRuns(text: string): Run[] {
  const pieces = sentences(text).map((s) => ({
    ...s,
    lang: detectLang(text.slice(s.start, s.end)),
  }));
  if (pieces.length === 0) {
    return [];
  }

  // Forward fill, then backward fill for any leading sentences with no signal.
  let known: Lang | null = null;
  for (const p of pieces) {
    p.lang ??= known;
    known = p.lang;
  }
  known = null;
  for (let i = pieces.length - 1; i >= 0; i--) {
    pieces[i].lang ??= known;
    known = pieces[i].lang;
  }

  const runs: Run[] = [];
  for (const p of pieces) {
    const last = runs[runs.length - 1];
    if (last && last.lang === p.lang) {
      last.end = p.end;
      continue;
    }
    runs.push({ start: p.start, end: p.end, lang: p.lang });
  }
  return runs;
}

interface RunResult<M> {
  matches: M[];
  language: string;
}

/**
 * Check each language run separately and merge the results back into the
 * coordinates of the full text. Each match is tagged with the language code
 * its run was checked in, so "learn word" stores it under the right language.
 */
export async function checkByRuns<M extends { offset: number }>(
  text: string,
  check: (runText: string, code: string) => Promise<RunResult<M>>,
): Promise<{ matches: Array<M & { lang: string }>; language: string }> {
  const runs = splitRuns(text);
  if (runs.length === 0) {
    return { matches: [], language: AUTO };
  }

  const results = await Promise.all(
    runs.map(async (run) => ({
      run,
      res: await check(text.slice(run.start, run.end), run.lang ? LANG_CODES[run.lang] : AUTO),
    })),
  );

  const matches = results.flatMap(({ run, res }) =>
    res.matches.map((m) => ({ ...m, offset: m.offset + run.start, lang: res.language })),
  );

  // The dominant run's language stands for the document as a whole.
  const longest = results.reduce((a, b) =>
    b.run.end - b.run.start > a.run.end - a.run.start ? b : a,
  );
  return { matches, language: longest.res.language };
}
