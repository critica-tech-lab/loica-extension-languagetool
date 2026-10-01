/**
 * SQL for per-user learned words, over any SQLite handle that has `exec` and
 * `prepare`. Kept apart from `learned-words.server.ts` (which binds it to the
 * app database) so tests can run it on an in-memory database.
 */
interface Statement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteHandle {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
}

export function createLearnedWordsStore(db: SqliteHandle) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lt_learned_words (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      word       TEXT NOT NULL,
      lang       TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, word, lang)
    )
  `);

  return {
    /** Lowercased words that apply when checking `lang` (or every language). */
    getLearnedWords(userId: string, lang: string): Set<string> {
      const rows = db
        .prepare("SELECT word FROM lt_learned_words WHERE user_id = ? AND (lang = ? OR lang = '')")
        .all(userId, lang) as Array<{ word: string }>;
      return new Set(rows.map((r) => r.word.toLowerCase()));
    },

    /** Teach a word for a user. No-op if already known (idempotent upsert). */
    addLearnedWord(userId: string, word: string, lang: string): void {
      db.prepare("INSERT OR IGNORE INTO lt_learned_words (user_id, word, lang) VALUES (?, ?, ?)").run(
        userId,
        word,
        lang,
      );
    },

    /**
     * Forget a learned word. Case-insensitive, like the lookup: "Berdad" learned
     * from a capitalised sentence start is removed by "berdad" too.
     */
    removeLearnedWord(userId: string, word: string, lang: string): void {
      db.prepare("DELETE FROM lt_learned_words WHERE user_id = ? AND lower(word) = lower(?) AND lang = ?").run(
        userId,
        word,
        lang,
      );
    },
  };
}
