/**
 * Parse the body of a `/v2/check` answer, or explain what went wrong.
 *
 * `LANGUAGETOOL_URL` can point at something that is not LanguageTool: another
 * service on the same port answers 200 with plain text or HTML, and a bare
 * `res.json()` then fails with "Unexpected token", which says nothing about
 * the cause. Name the URL and the setting instead.
 */
const SNIPPET_CHARS = 80;

export function parseLtBody(body: string, base: string): { matches: unknown[] } & Record<string, unknown> {
  const notLt = () =>
    new Error(
      `The server at ${base} did not answer like LanguageTool ` +
        `(it said: "${body.slice(0, SNIPPET_CHARS).replace(/\s+/g, " ")}"). ` +
        `Check LANGUAGETOOL_URL.`,
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw notLt();
  }

  const matches = (parsed as { matches?: unknown } | null)?.matches;
  if (!Array.isArray(matches)) {
    throw notLt();
  }
  return parsed as { matches: unknown[] } & Record<string, unknown>;
}
