/**
 * POST /api/languagetool/:id/words — teach or forget a personal spelling word.
 *
 * Words are per-user (see `learned-words.server.ts`), so this route only needs a
 * logged-in user — the `:id` keeps the URL under the extension's namespace but
 * the document isn't otherwise involved. Anonymous share-token viewers have no
 * account and are rejected; the client hides the "Learn word" button for them.
 *
 * Body: { word: string, lang?: string, remove?: boolean }
 *   word    the token to learn/forget (trimmed; must be non-empty, single token)
 *   lang    LanguageTool language code the word applies to (e.g. "es"); ""/absent
 *           means all languages
 *   remove  true to forget instead of learn
 * Returns: { ok: true }
 */
import type { ActionFunctionArgs } from "react-router";
import { getSessionUser } from "~/lib/auth.server";
import { addLearnedWord, removeLearnedWord } from "./learned-words.server";

export async function action({ request }: ActionFunctionArgs) {
  const user = getSessionUser(request);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const { word, lang, remove } = (await request.json()) as {
    word?: string;
    lang?: string;
    remove?: boolean;
  };

  const trimmed = (word ?? "").trim();
  // A learned word is a single spelling token — reject blanks and anything with
  // whitespace so this can't be used to stuff arbitrary phrases into the table.
  if (!trimmed || /\s/.test(trimmed)) {
    return Response.json({ error: "A single word is required." }, { status: 400 });
  }
  if (trimmed.length > 100) {
    return Response.json({ error: "Word too long." }, { status: 400 });
  }

  const code = (lang ?? "").trim();
  if (remove) removeLearnedWord(user.id, trimmed, code);
  else addLearnedWord(user.id, trimmed, code);

  return Response.json({ ok: true });
}
