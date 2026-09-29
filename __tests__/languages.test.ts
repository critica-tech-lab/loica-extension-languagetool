import { test, expect, describe } from "bun:test";
import { detectLang, splitRuns, checkByRuns } from "../languages";

const EN = "We reviewed the proposal and agreed on the next steps.";
const ES = "El documento se sincroniza en tiempo real entre todos los usuarios.";

describe("detectLang", () => {
  test("English sentence", () => {
    expect(detectLang(EN)).toBe("en");
  });

  test("Spanish sentence", () => {
    expect(detectLang(ES)).toBe("es");
  });

  test("misspelled Spanish is still Spanish", () => {
    expect(detectLang("Ella tambien vino a la fiesta.")).toBe("es");
  });

  test("misspelled English is still English", () => {
    expect(detectLang("Their going to publish the article tomorow.")).toBe("en");
  });

  test("Spanish-only characters tip a short sentence", () => {
    expect(detectLang("¿Cómo estás hoy?")).toBe("es");
    expect(detectLang("Nos vemos mañana.")).toBe("es");
  });

  test("too little signal returns null", () => {
    expect(detectLang("OK.")).toBeNull();
    expect(detectLang("Yjs")).toBeNull();
    expect(detectLang("")).toBeNull();
  });
});

describe("splitRuns", () => {
  const slices = (text: string) => splitRuns(text).map((r) => text.slice(r.start, r.end));

  test("empty text has no runs", () => {
    expect(splitRuns("")).toEqual([]);
  });

  test("single-language text is one run over the whole text", () => {
    const text = `${EN} ${EN}`;
    expect(splitRuns(text)).toEqual([{ start: 0, end: text.length, lang: "en" }]);
  });

  test("runs partition the text with no gaps or overlaps", () => {
    const text = `${EN}\n${ES}\n${EN}`;
    expect(slices(text).join("")).toBe(text);
  });

  test("paragraphs in two languages become separate runs", () => {
    const text = `${EN}\n${ES}\n${EN}`;
    expect(splitRuns(text).map((r) => r.lang)).toEqual(["en", "es", "en"]);
  });

  test("a language switch inside one paragraph is split", () => {
    const text = `${EN} ${ES}`;
    expect(splitRuns(text).map((r) => r.lang)).toEqual(["en", "es"]);
  });

  test("consecutive sentences in the same language merge", () => {
    const text = `${EN} ${EN} ${ES} ${ES}`;
    expect(splitRuns(text).map((r) => r.lang)).toEqual(["en", "es"]);
  });

  test("a sentence with no signal inherits the previous language", () => {
    const text = `${ES} OK. ${ES}`;
    expect(splitRuns(text).map((r) => r.lang)).toEqual(["es"]);
  });

  test("a leading sentence with no signal inherits the next language", () => {
    const text = `OK. ${ES}`;
    expect(splitRuns(text).map((r) => r.lang)).toEqual(["es"]);
  });

  test("text with no signal anywhere is one undetected run", () => {
    expect(splitRuns("Yjs SQLite")).toEqual([{ start: 0, end: 10, lang: null }]);
  });
});

describe("checkByRuns", () => {
  // Flags the first character of whatever text it is given, so offsets show
  // which run produced each match.
  const fake = async (text: string, code: string) => ({
    matches: [{ offset: 0, length: 1, from: text.slice(0, 5) }],
    language: code === "auto" ? "de-DE" : code,
  });

  test("shifts each run's offsets back into the full text", async () => {
    const text = `${EN}\n${ES}`;
    const { matches } = await checkByRuns(text, fake);
    expect(matches.map((m) => m.offset)).toEqual([0, EN.length + 1]);
  });

  test("tags each match with its run's language code", async () => {
    const { matches } = await checkByRuns(`${EN}\n${ES}`, fake);
    expect(matches.map((m) => m.lang)).toEqual(["en-US", "es"]);
  });

  test("reports the language of the longest run", async () => {
    const { language } = await checkByRuns(`${EN}\n${ES} ${ES}`, fake);
    expect(language).toBe("es");
  });

  test("an undetected run is checked with auto", async () => {
    const { matches, language } = await checkByRuns("Yjs SQLite", fake);
    expect(matches[0].lang).toBe("de-DE");
    expect(language).toBe("de-DE");
  });

  test("empty text checks nothing", async () => {
    expect(await checkByRuns("", fake)).toEqual({ matches: [], language: "auto" });
  });
});
