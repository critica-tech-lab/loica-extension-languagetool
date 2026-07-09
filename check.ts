/**
 * POST /api/languagetool/:id — grammar/spell/style check text with a
 * self-hosted LanguageTool server. Read-only: never persists anything back to
 * the document. Auth mirrors the translate route (api.translate.$id.ts).
 *
 * This module exports the route `action`; a thin shim at
 * `app/routes/api.languagetool.$id.ts` re-exports it (a real resource route →
 * server-only, no client leak), matching the translation extension's shape.
 *
 * The inline editor plugin (`languagetool-plugin.ts`) POSTs the doc serialised
 * to PLAIN TEXT here (not markdown), so offsets map cleanly back to editor
 * positions and markdown syntax doesn't create false positives.
 *
 * Body: { content?: string, language?: string }
 *   content   plain text to check (falls back to the stored doc copy)
 *   language  LanguageTool code, e.g. "en-US", or "auto" (default) to detect
 * Returns: { matches: LTMatch[], language: string, checked: number }
 *
 * Config via env (optional):
 *   LANGUAGETOOL_URL  base url (default http://localhost:8081)
 */
import type { ActionFunctionArgs } from "react-router";
import { getSessionUser } from "~/lib/auth.server";
import { getDocument } from "~/lib/document.server";
import { getMembership } from "~/lib/workspace.server";
import { hasSharedAccess } from "~/lib/sharing.server";
import { stripFrontmatter } from "~/lib/templates";

async function authorizeDoc(request: Request, params: { id?: string }) {
  const doc = getDocument(params.id!);
  if (!doc) throw new Response("Not found", { status: 404 });

  const isPublic = !!(doc.public_token || doc.edit_token);
  if (!isPublic) {
    const user = getSessionUser(request);
    if (!user) throw new Response("Not found", { status: 404 });
    const role = getMembership(doc.workspace_id, user.id, user.is_admin);
    const shared = doc.folder_id ? hasSharedAccess(doc.folder_id, user.id) : false;
    if (!role && !shared) throw new Response("Not found", { status: 404 });
  }

  return doc;
}

/** One LanguageTool match, trimmed to the fields the UI renders. */
interface LTMatch {
  message: string;
  shortMessage: string;
  offset: number;
  length: number;
  replacements: string[];
  ruleId: string;
  category: string;
  issueType: string;
}

/** Check `text` with the LanguageTool server; return trimmed matches. */
async function checkText(
  text: string,
  language: string,
): Promise<{ matches: LTMatch[]; language: string }> {
  const base = (process.env.LANGUAGETOOL_URL || "http://localhost:8081").replace(/\/$/, "");

  // LanguageTool's /v2/check takes application/x-www-form-urlencoded.
  const form = new URLSearchParams();
  form.set("text", text);
  form.set("language", language);
  if (language === "auto") form.set("preferredVariants", "en-US,de-DE,pt-BR");

  let res: Response;
  try {
    res = await fetch(`${base}/v2/check`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (err) {
    throw new Error(
      `Could not reach LanguageTool at ${base}. Is the server running? (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LanguageTool returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    matches?: Array<{
      message?: string;
      shortMessage?: string;
      offset?: number;
      length?: number;
      replacements?: Array<{ value?: string }>;
      rule?: { id?: string; issueType?: string; category?: { name?: string } };
    }>;
    language?: { code?: string; detectedLanguage?: { code?: string } };
  };

  const matches: LTMatch[] = (data.matches ?? []).map((m) => ({
    message: m.message ?? "",
    shortMessage: m.shortMessage ?? "",
    offset: m.offset ?? 0,
    length: m.length ?? 0,
    replacements: (m.replacements ?? []).map((r) => r.value ?? "").filter(Boolean).slice(0, 8),
    ruleId: m.rule?.id ?? "",
    category: m.rule?.category?.name ?? "",
    issueType: m.rule?.issueType ?? "",
  }));

  const resolvedLang =
    data.language?.detectedLanguage?.code || data.language?.code || language;
  return { matches, language: resolvedLang };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const doc = await authorizeDoc(request, params);

  const { content, language } = (await request.json()) as {
    content?: string;
    language?: string;
  };

  // Frontmatter strip is a no-op for the plain text the editor sends, but keeps
  // the stored-doc fallback safe.
  const body = stripFrontmatter(content || doc.content || "");
  if (!body.trim()) {
    return Response.json({ error: "Nothing to check — the document is empty." }, { status: 400 });
  }

  const lang = (language || "auto").trim();
  try {
    const { matches, language: resolved } = await checkText(body, lang);
    return Response.json({ matches, language: resolved, checked: body.length });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Grammar check failed." },
      { status: 502 },
    );
  }
}
