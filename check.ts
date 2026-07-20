/**
 * POST /api/languagetool/:id — grammar/spell/style check text with a
 * self-hosted LanguageTool server. Read-only: never persists anything back to
 * the document. Auth mirrors the doc export routes (api.doc-pdf.$id.ts).
 *
 * This module IS the route module for `/api/languagetool/:id` (registered by
 * `./routes.ts`, discovered by the extension route aggregator). It exports only
 * `action`, so React Router treats it as a server-only resource route — no
 * client leak. The extension is vendored under `app/`, so no shim is needed.
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
import { getDocument, getDocumentByToken } from "~/lib/document.server";
import { getMembership } from "~/lib/workspace.server";
import { hasSharedAccess } from "~/lib/sharing.server";
import { stripFrontmatter } from "~/lib/templates";

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split(";").flatMap((part) => {
      const trimmed = part.trim();
      const eq = trimmed.indexOf("=");
      if (eq < 1) return [];
      return [[trimmed.slice(0, eq).trim(), decodeURIComponent(trimmed.slice(eq + 1).trim())]];
    }),
  );
}

/**
 * Grant access only to a workspace member, a folder-share recipient, or a caller
 * who actually presents a valid share token for *this* document.
 *
 * The earlier version treated "the document has a share token" as "no auth
 * needed", without the caller ever proving they held it — so knowing a document
 * id was enough to POST arbitrary text here anonymously, and expired or
 * password-protected links kept working. Resolving the token via
 * `getDocumentByToken` is the same path `routes/s.$token.tsx` uses, which also
 * enforces `share_expires_at`.
 */
async function authorizeDoc(
  request: Request,
  params: { id?: string },
  shareToken?: string,
) {
  const doc = getDocument(params.id!);
  if (!doc) throw new Response("Not found", { status: 404 });

  const user = getSessionUser(request);
  if (user) {
    const role = getMembership(doc.workspace_id, user.id, user.is_admin);
    const shared = doc.folder_id ? hasSharedAccess(doc.folder_id, user.id) : false;
    if (role || shared) return doc;
  }

  const token = shareToken?.trim();
  if (token) {
    const viaToken = getDocumentByToken(token);
    // Must resolve, and must resolve to *this* document — a valid token for some
    // other document is not access to this one.
    if (viaToken && viaToken.document.id === doc.id) {
      const passwordOk =
        !viaToken.hasPassword ||
        parseCookies(request.headers.get("Cookie") ?? "")[`__share_pwd_${token}`] === "1";
      if (passwordOk) return doc;
    }
  }

  throw new Response("Not found", { status: 404 });
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

/**
 * Guard the target URL. Document text is POSTed to this server, so it must not
 * leave the machine over plaintext: require https, except for a loopback host
 * (localhost / 127.0.0.1 / ::1) where http is fine for local dev. Throws with a
 * clear message otherwise so a misconfigured remote never leaks content.
 */
function assertSafeUrl(base: string): void {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`LANGUAGETOOL_URL is not a valid URL: ${base}`);
  }
  if (url.protocol === "https:") return;
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol === "http:" && isLoopback) return;
  throw new Error(
    `Refusing to send document text to ${base} over ${url.protocol.replace(":", "")}. ` +
      `Use https:// for a non-local LanguageTool server (http is only allowed for localhost).`,
  );
}

/** Check `text` with the LanguageTool server; return trimmed matches. */
async function checkText(
  text: string,
  language: string,
): Promise<{ matches: LTMatch[]; language: string }> {
  const base = (process.env.LANGUAGETOOL_URL || "http://localhost:8081").replace(/\/$/, "");
  assertSafeUrl(base);

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
  const { content, language, shareToken } = (await request.json()) as {
    content?: string;
    language?: string;
    shareToken?: string;
  };

  // The share token travels in the body, so parse before authorizing.
  const doc = await authorizeDoc(request, params, shareToken);

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
