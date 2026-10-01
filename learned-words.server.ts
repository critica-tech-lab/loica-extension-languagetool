/**
 * Per-user "learned words" for the LanguageTool extension.
 *
 * When a user clicks "Add to dictionary" on a spelling underline, the flagged
 * word is stored here and filtered out of future checks for that user (see
 * `check.ts`). This is the dynamic, per-user layer — no server rebuild needed,
 * unlike the baked-in dictionary additions in `deploy/dict/*` which are global.
 *
 * The extension owns its own table rather than editing loica's central
 * `db.server.ts`: an idempotent `CREATE TABLE IF NOT EXISTS` at module load is
 * the same pattern the core uses, and the `lt_` prefix namespaces it so it never
 * collides with a core table. `ON DELETE CASCADE` to `users` cleans a user's
 * words when the account is deleted.
 *
 * A word learned under a specific language (e.g. "es") silences errors only in
 * that language; a word with an empty `lang` ('') is global. `lang` is the
 * language LT reported for the check (its `resolvedLang`), compared verbatim, so
 * store and lookup must use the same code.
 *
 * The SQL lives in `learned-words-store.ts` so tests can run it without the app
 * database.
 */
import { db } from "~/lib/db.server";
import { createLearnedWordsStore } from "./learned-words-store";

export const { getLearnedWords, addLearnedWord, removeLearnedWord } = createLearnedWordsStore(db);
