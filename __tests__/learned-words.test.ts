import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createLearnedWordsStore } from "../learned-words-store";

const USER = "u1";
const LANG = "es";

let store: ReturnType<typeof createLearnedWordsStore>;

beforeEach(() => {
  const db = new Database(":memory:");
  // Minimal stand-in for the core table the words reference.
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO users (id) VALUES (?)").run(USER);
  store = createLearnedWordsStore(db);
});

describe("removeLearnedWord", () => {
  test("forgets a word regardless of the case it was learned in", () => {
    store.addLearnedWord(USER, "Berdad", LANG);
    expect(store.getLearnedWords(USER, LANG).has("berdad")).toBe(true);

    store.removeLearnedWord(USER, "berdad", LANG);

    expect(store.getLearnedWords(USER, LANG).has("berdad")).toBe(false);
  });

  test("leaves other words and languages alone", () => {
    store.addLearnedWord(USER, "gato", LANG);
    store.addLearnedWord(USER, "gato", "en");
    store.addLearnedWord(USER, "perro", LANG);

    store.removeLearnedWord(USER, "GATO", LANG);

    expect(store.getLearnedWords(USER, LANG).has("gato")).toBe(false);
    expect(store.getLearnedWords(USER, LANG).has("perro")).toBe(true);
    expect(store.getLearnedWords(USER, "en").has("gato")).toBe(true);
  });
});
