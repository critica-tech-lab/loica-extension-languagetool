/**
 * Per-user "learned words" for the LanguageTool extension.
 *
 * When a user clicks "Learn word" on a spelling underline, the flagged word is
 * stored here and filtered out of future checks for that user (see `check.ts`).
 * This is the dynamic, per-user layer — no server rebuild needed, unlike the
 * baked-in dictionary additions in `deploy/dict/*` which are global.
 *
 * The extension owns its own table rather than editing loica's central
 * `db.server.ts`: an idempotent `CREATE TABLE IF NOT EXISTS` at module load is
 * the same pattern the core uses, and the `lt_` prefix namespaces it so it never
 * collides with a core table. `ON DELETE CASCADE` to `users` cleans a user's
 * words when the account is deleted.
 */
import { db } from "~/lib/db.server";

db.exec(`
  CREATE TABLE IF NOT EXISTS lt_learned_words (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    word       TEXT NOT NULL,
    lang       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, word, lang)
  )
`);

/**
 * Words a user has taught LanguageTool that apply when checking `lang`.
 *
 * A word learned under a specific language (e.g. "es") silences errors only in
 * that language; a word with an empty `lang` ('') is global. `lang` here is the
 * language LT reported for the check (its `resolvedLang`), and we compare it to
 * the stored value verbatim, so store and lookup must use the same code.
 *
 * Returned lowercased for case-insensitive matching against flagged text.
 */
export function getLearnedWords(userId: string, lang: string): Set<string> {
  const rows = db
    .prepare(
      "SELECT word FROM lt_learned_words WHERE user_id = ? AND (lang = ? OR lang = '')",
    )
    .all(userId, lang) as Array<{ word: string }>;
  return new Set(rows.map((r) => r.word.toLowerCase()));
}

/** Teach a word for a user. No-op if already known (idempotent upsert). */
export function addLearnedWord(userId: string, word: string, lang: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO lt_learned_words (user_id, word, lang) VALUES (?, ?, ?)",
  ).run(userId, word, lang);
}

/** Forget a previously learned word for a user. */
export function removeLearnedWord(userId: string, word: string, lang: string): void {
  db.prepare(
    "DELETE FROM lt_learned_words WHERE user_id = ? AND word = ? AND lang = ?",
  ).run(userId, word, lang);
}
