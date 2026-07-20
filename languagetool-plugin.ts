/**
 * ProseMirror plugin that draws LanguageTool issues as inline wavy underlines
 * directly in the editor, with a click-to-fix popover.
 *
 * Runs in the host's ProseMirror instance: it imports `prosemirror-state` /
 * `prosemirror-view` bare, and vite's `resolve.dedupe` (see the host
 * `vite.config.ts`) forces a single PM copy so these classes match the editor's.
 *
 * Flow:
 *  1. On load + after each edit (debounced), serialise the doc to plain text and
 *     POST it to `/api/languagetool/:id`.
 *  2. Map each match's plain-text offset back to a ProseMirror position range.
 *  3. Render an inline `Decoration` per match (wavy underline, coloured by type).
 *  4. Clicking an underline opens a small popover with the message + suggestion
 *     buttons; a suggestion dispatches a replace transaction. Read-until-clicked
 *     — the doc is only edited when the user accepts a fix.
 *
 * Local-only under Yjs collab: decorations are editor-view state, never synced,
 * so each peer checks its own view independently.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

export const languagetoolPluginKey = new PluginKey<DecorationSet>("languagetool");

/** Debounce between the last keystroke and firing a check. */
const CHECK_DEBOUNCE_MS = 1200;

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

/** Colour an underline by LanguageTool issue type. */
function issueColor(issueType: string): string {
  if (issueType === "misspelling" || issueType === "typographical") return "#d64545"; // red
  if (issueType === "grammar") return "#e08a1e"; // amber
  return "#3b82c4"; // blue — style, register, etc.
}

/** English label from the (always-English) issueType — LT's `category` is
 *  localised to the checked language, so we don't use it in the UI. */
function issueLabel(issueType: string): string {
  const map: Record<string, string> = {
    misspelling: "Spelling",
    typographical: "Typography",
    grammar: "Grammar",
    style: "Style",
    punctuation: "Punctuation",
    whitespace: "Spacing",
    duplication: "Repetition",
    "non-conformance": "Style",
  };
  if (map[issueType]) return map[issueType];
  return issueType ? issueType[0].toUpperCase() + issueType.slice(1) : "Issue";
}

// ── plain-text serialisation + offset → PM position mapping ──────────────────

interface Seg {
  /** Start offset of this run within the serialised plain text. */
  textStart: number;
  /** PM position of the run's first character. */
  pmFrom: number;
  /** Character length of the run. */
  len: number;
}

/**
 * Serialise the doc to plain text and record, for each text run, the offset →
 * PM-position mapping. Block boundaries emit a "\n" separator (no PM position)
 * so LanguageTool sees sentence breaks; those synthetic chars are never targets
 * of a real match.
 */
function docToText(doc: PMNode): { text: string; segs: Seg[] } {
  const segs: Seg[] = [];
  let text = "";
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      segs.push({ textStart: text.length, pmFrom: pos, len: node.text.length });
      text += node.text;
      return false;
    }
    if (node.isBlock && text.length > 0 && !text.endsWith("\n")) {
      text += "\n";
    }
    return true;
  });
  return { text, segs };
}

/** Map a plain-text offset to a PM position, or null if it lands in a gap. */
function offsetToPos(segs: Seg[], offset: number): number | null {
  for (const s of segs) {
    if (offset >= s.textStart && offset < s.textStart + s.len) {
      return s.pmFrom + (offset - s.textStart);
    }
  }
  return null;
}

/** Turn LT matches into inline decorations against the current doc. */
function buildDecorations(doc: PMNode, segs: Seg[], matches: LTMatch[]): DecorationSet {
  // A stale offset map (doc edited mid-flight) could yield a position past the
  // doc end; PM throws "Position out of range" if a decoration exceeds it and
  // that would break the editor. Clamp every position to the current doc, and
  // wrap the build so a bad match can never throw into the editor loop.
  const max = doc.content.size;
  const decos: Decoration[] = [];
  for (const m of matches) {
    try {
      const rawFrom = offsetToPos(segs, m.offset);
      // Map the last character then +1 so the range covers the whole match.
      const rawLast = offsetToPos(segs, m.offset + Math.max(0, m.length - 1));
      if (rawFrom == null || rawLast == null) continue;
      const from = Math.max(0, Math.min(rawFrom, max));
      const to = Math.max(0, Math.min(rawLast + 1, max));
      if (to <= from) continue;
      const color = issueColor(m.issueType);
      decos.push(
        Decoration.inline(
          from,
          to,
          {
            class: "lt-issue",
            style: `text-decoration: underline; text-decoration-color: ${color}; text-decoration-thickness: 1.5px; text-underline-offset: 2px; cursor: pointer;`,
          },
          // Spec metadata — read back on click to build the popover.
          { ltMatch: m, ltFrom: from, ltTo: to },
        ),
      );
    } catch {
      // Skip a single bad match rather than lose the whole set.
    }
  }
  try {
    return DecorationSet.create(doc, decos);
  } catch {
    return DecorationSet.empty;
  }
}

// ── click-to-fix popover ─────────────────────────────────────────────────────

let activePopover: HTMLElement | null = null;

function closePopover() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("scroll", closePopover, true);
  }
}

function onDocMouseDown(e: MouseEvent) {
  if (activePopover && !activePopover.contains(e.target as Node)) closePopover();
}

function openPopover(
  view: EditorView,
  match: LTMatch,
  from: number,
  to: number,
  clientX: number,
  clientY: number,
) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "lt-popover";
  Object.assign(pop.style, {
    position: "fixed",
    left: `${Math.min(clientX, window.innerWidth - 300)}px`,
    top: `${clientY + 12}px`,
    width: "min(280px, 90vw)",
    background: "var(--bg, #fff)",
    color: "var(--fg, #111)",
    border: "1px solid var(--border, #ccc)",
    borderRadius: "8px",
    boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
    padding: "10px 12px",
    zIndex: "2000",
    fontSize: "13px",
    lineHeight: "1.45",
  } as CSSStyleDeclaration);

  const cat = document.createElement("div");
  cat.textContent = issueLabel(match.issueType);
  Object.assign(cat.style, {
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    opacity: "0.55",
    marginBottom: "4px",
  } as CSSStyleDeclaration);
  pop.appendChild(cat);

  const msg = document.createElement("div");
  msg.textContent = match.message;
  msg.style.marginBottom = match.replacements.length ? "8px" : "0";
  pop.appendChild(msg);

  if (match.replacements.length) {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", flexWrap: "wrap", gap: "6px" } as CSSStyleDeclaration);
    for (const r of match.replacements) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = r;
      Object.assign(btn.style, {
        padding: "3px 10px",
        borderRadius: "999px",
        border: "1px solid var(--border, #ccc)",
        background: "var(--fg, #111)",
        color: "var(--bg, #fff)",
        fontSize: "12px",
        cursor: "pointer",
      } as CSSStyleDeclaration);
      btn.addEventListener("click", () => {
        // Replace the flagged range with the chosen suggestion.
        const tr = view.state.tr.insertText(r, from, to);
        view.dispatch(tr);
        closePopover();
        view.focus();
      });
      row.appendChild(btn);
    }
    pop.appendChild(row);
  }

  document.body.appendChild(pop);
  activePopover = pop;
  document.addEventListener("mousedown", onDocMouseDown, true);
  document.addEventListener("scroll", closePopover, true);
}

// ── the plugin ───────────────────────────────────────────────────────────────

/**
 * The share token for a publicly-viewed document, read off `/s/:token`. Members
 * viewing a document normally are on a different path and get `null` — they are
 * authorised by session instead.
 */
function shareTokenFromLocation(): string | null {
  const m = window.location.pathname.match(/^\/s\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export interface LanguageToolPluginOptions {
  /** Document id → POST target `/api/languagetool/:docId`. */
  docId: string;
  /** LanguageTool language code, or "auto" (default). */
  language?: string;
}

export function languagetoolPlugin(opts: LanguageToolPluginOptions): Plugin {
  const language = opts.language || "auto";
  // Latest serialisation, kept so a click can resolve the range even after the
  // decoration was built asynchronously.
  let lastSegs: Seg[] = [];

  return new Plugin<DecorationSet>({
    key: languagetoolPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr: Transaction, old: DecorationSet) {
        // apply() runs on every transaction — a throw here would break the
        // editor on the next keystroke, so it must never throw.
        try {
          const meta = tr.getMeta(languagetoolPluginKey) as DecorationSet | undefined;
          if (meta) return meta;
          // Remap existing decorations through the edit; drop those in changed ranges.
          return old.map(tr.mapping, tr.doc);
        } catch {
          return DecorationSet.empty;
        }
      },
    },
    props: {
      decorations(state: EditorState) {
        return languagetoolPluginKey.getState(state) ?? DecorationSet.empty;
      },
      handleClick(view: EditorView, pos: number, event: MouseEvent) {
        try {
          const set = languagetoolPluginKey.getState(view.state);
          if (!set) return false;
          const hit = set.find(pos, pos)[0];
          if (!hit) return false;
          const spec = hit.spec as { ltMatch?: LTMatch; ltFrom?: number; ltTo?: number };
          if (!spec.ltMatch) return false;
          openPopover(view, spec.ltMatch, spec.ltFrom!, spec.ltTo!, event.clientX, event.clientY);
          return true;
        } catch {
          return false; // never let a click handler throw into the editor
        }
      },
    },
    view(view: EditorView) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let seq = 0; // guards against out-of-order responses

      async function runCheck() {
        try {
          const { text, segs } = docToText(view.state.doc);
          lastSegs = segs;
          if (!text.trim()) {
            view.dispatch(view.state.tr.setMeta(languagetoolPluginKey, DecorationSet.empty));
            return;
          }
          const mySeq = ++seq;
          const res = await fetch(`/api/languagetool/${opts.docId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: text,
              language,
              shareToken: shareTokenFromLocation() || undefined,
            }),
          });
          if (!res.ok) return;
          const data = (await res.json()) as { matches?: LTMatch[] };
          if (mySeq !== seq) return; // a newer check superseded this one
          const decos = buildDecorations(view.state.doc, lastSegs, data.matches ?? []);
          view.dispatch(view.state.tr.setMeta(languagetoolPluginKey, decos));
        } catch {
          // Network/server error or serialisation issue — leave existing
          // decorations untouched; the next edit reschedules a check.
        }
      }

      function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(runCheck, CHECK_DEBOUNCE_MS);
      }

      // Initial check shortly after mount (let Yjs sync the doc in first).
      timer = setTimeout(runCheck, CHECK_DEBOUNCE_MS);

      return {
        update(_view: EditorView, prevState: EditorState) {
          if (!prevState.doc.eq(view.state.doc)) schedule();
        },
        destroy() {
          if (timer) clearTimeout(timer);
          closePopover();
        },
      };
    },
  });
}
