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
import { createStatsSender } from "./stats-client";
import { publishStatus } from "./status";
import { nativeSpellcheck } from "./native-spellcheck";

const STATUS_ID = "languagetool";

export const languagetoolPluginKey = new PluginKey<DecorationSet>("languagetool");

/**
 * "Add to dictionary" is off until there is a place to review and remove learned
 * words (a settings section); the undo toast only covers the first 6 seconds.
 */
const LEARN_WORDS_ENABLED = false;

/** Debounce between the last keystroke and firing a check. */
const CHECK_DEBOUNCE_MS = 500;

interface LTMatch {
  message: string;
  shortMessage: string;
  offset: number;
  length: number;
  replacements: string[];
  ruleId: string;
  category: string;
  issueType: string;
  /** Language code the match's text was checked in (set for auto-detected runs). */
  lang?: string;
}

/** Colour an underline by LanguageTool issue type. */
function issueKind(issueType: string): "spell" | "grammar" | "style" {
  if (issueType === "misspelling" || issueType === "typographical") return "spell";
  if (issueType === "grammar") return "grammar";
  return "style";
}

// Underline look: dotted line in Loica palette vars (scarlet / tawny /
// blue) so it follows the theme, plus a faint wash on hover. Injected once
// because inline styles cannot express :hover.
const STYLE_ID = "lt-issue-style";
const ISSUE_CSS = `
.lt-issue {
  text-decoration-line: underline;
  text-decoration-style: dotted;
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
  text-decoration-skip-ink: none;
  border-radius: var(--radius-xs, 4px);
  cursor: pointer;
  transition: background-color 120ms ease;
}
.lt-issue-spell { --lt-c: var(--color-scarlet, #AF3029); }
.lt-issue-grammar { --lt-c: var(--color-tawny, #DA702C); }
.lt-issue-style { --lt-c: var(--color-blue, #205EA6); }
.lt-issue { text-decoration-color: var(--lt-c); }
.lt-issue:hover { background-color: color-mix(in srgb, var(--lt-c) 14%, transparent); }

/* Compact spelling chip: [ suggestion | dismiss | more ] above the word. */
.lt-chip {
  position: fixed;
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: var(--bg, #fff);
  color: var(--fg, #111);
  border: 1px solid var(--border, #ccc);
  border-radius: 10px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.14); /* allow-hex */
  font-size: 13px;
}
.lt-chip button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  min-width: 26px;
  padding: 0 6px;
  border: none;
  border-radius: 7px;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.lt-chip button:hover { background: color-mix(in srgb, var(--fg, #111) 8%, transparent); }
.lt-chip .lt-chip-main { padding: 0 8px; font-weight: 500; }
.lt-chip .lt-chip-icon { opacity: 0.6; }
.lt-chip .lt-chip-icon:hover { opacity: 1; }
.lt-chip .lt-chip-empty { padding: 0 8px; opacity: 0.6; }
.lt-chip-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  display: flex;
  flex-direction: column;
  min-width: 160px;
  padding: 4px;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #ccc);
  border-radius: 10px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.14); /* allow-hex */
}
.lt-chip-menu button { justify-content: flex-start; white-space: nowrap; }
.lt-toast {
  position: fixed;
  left: 50%;
  bottom: 56px;
  transform: translateX(-50%);
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: min(420px, 92vw);
  padding: 8px 8px 8px 14px;
  background: var(--fg, #111);
  color: var(--bg, #fff);
  border-radius: 10px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2); /* allow-hex */
  font-size: 13px;
}
.lt-toast button {
  padding: 3px 10px;
  border: none;
  border-radius: 7px;
  background: color-mix(in srgb, var(--bg, #fff) 18%, transparent);
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.lt-toast button:hover { background: color-mix(in srgb, var(--bg, #fff) 30%, transparent); }
.lt-chip-menu hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--border, #ccc); }
`;

function ensureIssueStyle() {
  if (typeof document === "undefined") return;
  // Reuse the tag so a hot reload picks up edited CSS instead of keeping the old one.
  const el = document.getElementById(STYLE_ID) ?? document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = ISSUE_CSS;
  if (!el.isConnected) document.head.appendChild(el);
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

/** Identity of a dismissed issue: same rule on the same flagged text. */
function ignoreKey(m: LTMatch, text: string): string {
  return `${m.ruleId}:${text}`;
}

/** Turn LT matches into inline decorations against the current doc. */
function buildDecorations(
  doc: PMNode,
  segs: Seg[],
  matches: LTMatch[],
  ignored: Set<string>,
): DecorationSet {
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
      if (ignored.has(ignoreKey(m, doc.textBetween(from, to)))) continue;
      decos.push(
        Decoration.inline(
          from,
          to,
          { class: `lt-issue lt-issue-${issueKind(m.issueType)}` },
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

// Outcome counters for the open editor; null for anonymous share-link viewers.
let statsSender: ReturnType<typeof createStatsSender> | null = null;

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

interface LearnContext {
  /** Document id → POST target `/api/languagetool/:docId/words`. */
  docId: string;
  /** LanguageTool code the word applies to (LT's detected language). */
  lang: string;
  /** Re-run the check so the accepted word's underline clears immediately. */
  onLearned: () => void;
}

const ICON_DISMISS =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.25"/><path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5"/></svg>';
const ICON_MORE =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3.5" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="8" cy="12.5" r="1.25"/></svg>';

/** Gap between the chip and the flagged word. */
const CHIP_GAP_PX = 6;
/** Suggestions beyond the first that the "more" menu lists. */
const CHIP_MENU_REPLACEMENTS = 4;

function chipButton(className: string, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.setAttribute("aria-label", label);
  btn.title = label;
  return btn;
}

enum WordAction {
  Learn = "learn",
  Forget = "forget",
}

/** Teach or forget a personal dictionary word. True when the server accepted it. */
async function postWord(docId: string, word: string, lang: string, action: WordAction): Promise<boolean> {
  try {
    const res = await fetch(`/api/languagetool/${docId}/words`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word, lang, remove: action === WordAction.Forget }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** How long the undo toast stays before the word is kept for good. */
const UNDO_TOAST_MS = 6000;

let activeToast: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function closeToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  activeToast?.remove();
  activeToast = null;
}

/** Bottom toast "<message> · Undo". A newer toast replaces the previous one. */
function showUndoToast(message: string, onUndo: () => void) {
  closeToast();

  const toast = document.createElement("div");
  toast.className = "lt-toast";
  toast.setAttribute("role", "status");

  const text = document.createElement("span");
  text.textContent = message;

  const undo = document.createElement("button");
  undo.type = "button";
  undo.textContent = "Undo";
  undo.addEventListener("click", () => {
    closeToast();
    onUndo();
  });

  toast.append(text, undo);
  document.body.appendChild(toast);
  activeToast = toast;
  toastTimer = setTimeout(closeToast, UNDO_TOAST_MS);
}

/**
 * Compact spelling popover, Google Docs style:
 *
 *    ┌──────────────────────┐
 *    │ verdad   ⊗   ⋮       │   one click applies the best suggestion
 *    └──────────────────────┘
 *       berdad                 ⊗ dismisses, ⋮ lists the rest + dictionary
 */
function openSpellChip(
  view: EditorView,
  match: LTMatch,
  from: number,
  to: number,
  learn: LearnContext | null,
  onIgnore: () => void,
) {
  closePopover();
  const statLang = match.lang || learn?.lang;
  statsSender?.track("opened", statLang);
  const word = view.state.doc.textBetween(from, to);
  const [best, ...others] = match.replacements;

  const apply = (replacement: string) => {
    view.dispatch(view.state.tr.insertText(replacement, from, to));
    statsSender?.track("accepted", statLang);
    closePopover();
    view.focus();
  };

  const chip = document.createElement("div");
  chip.className = "lt-chip";

  if (best) {
    const main = chipButton("lt-chip-main", `Replace with ${best}`);
    main.textContent = best;
    main.addEventListener("click", () => apply(best));
    chip.appendChild(main);
  } else {
    const empty = document.createElement("span");
    empty.className = "lt-chip-empty";
    empty.textContent = "No suggestions";
    chip.appendChild(empty);
  }

  const dismiss = chipButton("lt-chip-icon", "Ignore this suggestion");
  dismiss.innerHTML = ICON_DISMISS;
  dismiss.addEventListener("click", () => {
    closePopover();
    onIgnore();
  });
  chip.appendChild(dismiss);

  const menuItems: HTMLElement[] = others.slice(0, CHIP_MENU_REPLACEMENTS).map((r) => {
    const item = chipButton("", `Replace with ${r}`);
    item.textContent = r;
    item.addEventListener("click", () => apply(r));
    return item;
  });
  if (learn) {
    if (menuItems.length) menuItems.push(document.createElement("hr"));
    const add = chipButton("", "Add to dictionary");
    add.textContent = `Add “${word}” to dictionary`;
    add.addEventListener("click", async () => {
      statsSender?.track("learned", statLang);
      closePopover();
      const lang = match.lang || learn.lang;
      const saved = await postWord(learn.docId, word, lang, WordAction.Learn);
      learn.onLearned();
      if (!saved) {
        // Non-fatal: the word just won't be remembered.
        return;
      }

      showUndoToast(`Added “${word}” to dictionary`, async () => {
        await postWord(learn.docId, word, lang, WordAction.Forget);
        learn.onLearned();
      });
    });
    menuItems.push(add);
  }

  if (menuItems.length) {
    const more = chipButton("lt-chip-icon", "More options");
    more.innerHTML = ICON_MORE;
    const menu = document.createElement("div");
    menu.className = "lt-chip-menu";
    menu.hidden = true;
    menu.append(...menuItems);
    more.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
    });
    chip.append(more, menu);
  }

  document.body.appendChild(chip);

  // Sit above the word; flip below when there is no room at the top.
  const coords = view.coordsAtPos(from);
  const chipRect = chip.getBoundingClientRect();
  const above = coords.top - chipRect.height - CHIP_GAP_PX;
  chip.style.top = `${above >= 0 ? above : coords.bottom + CHIP_GAP_PX}px`;
  chip.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - chipRect.width - 8))}px`;

  activePopover = chip;
  document.addEventListener("mousedown", onDocMouseDown, true);
  document.addEventListener("scroll", closePopover, true);
}

function openPopover(
  view: EditorView,
  match: LTMatch,
  from: number,
  to: number,
  clientX: number,
  clientY: number,
  learn: LearnContext | null,
  onIgnore: () => void,
) {
  if (issueKind(match.issueType) === "spell") {
    openSpellChip(view, match, from, to, learn, onIgnore);
    return;
  }
  closePopover();
  const statLang = match.lang || learn?.lang;
  statsSender?.track("opened", statLang);
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
        statsSender?.track("accepted", statLang);
        closePopover();
        view.focus();
      });
      row.appendChild(btn);
    }
    pop.appendChild(row);
  }

  // "Learn word" — only for spelling matches, and only when a logged-in user is
  // present (anonymous share-token viewers get `learn === null`). Teaches the
  // flagged token so it stops being underlined for this user.
  if (learn && match.issueType === "misspelling") {
    const word = view.state.doc.textBetween(from, to);
    const learnBtn = document.createElement("button");
    learnBtn.type = "button";
    learnBtn.textContent = `Add “${word}” to dictionary`;
    Object.assign(learnBtn.style, {
      display: "block",
      marginTop: "8px",
      padding: "3px 0",
      border: "none",
      background: "none",
      color: "var(--fg, #111)",
      opacity: "0.6",
      fontSize: "12px",
      cursor: "pointer",
      textAlign: "left",
    } as CSSStyleDeclaration);
    learnBtn.addEventListener("click", async () => {
      statsSender?.track("learned", statLang);
      closePopover();
      try {
        await fetch(`/api/languagetool/${learn.docId}/words`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ word, lang: match.lang || learn.lang }),
        });
      } catch {
        // Non-fatal: the word just won't be remembered. Re-check anyway.
      }
      learn.onLearned();
    });
    pop.appendChild(learnBtn);
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

/**
 * Remove issues whose text the transaction rewrote. `map` alone keeps a
 * decoration over text that replaced its range, so an accepted fix stayed
 * underlined until the next re-check. Touching an edit's edge doesn't count,
 * only real overlap.
 *
 *   "aa [berdad] cc"  --replace berdad->verdad-->  "aa verdad cc"   underline gone
 *   "aa [berdad] cc"  --replace "aa "---------->  "xx [berdad] cc"  underline kept
 */
function dropEdited(set: DecorationSet, tr: Transaction): DecorationSet {
  if (!tr.docChanged) {
    return set;
  }

  let result = set;
  tr.mapping.maps.forEach((map, i) => {
    const after = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const from = after.map(newStart, -1);
      const to = after.map(newEnd, 1);
      const edited = result.find(from, to).filter((d) => d.from < to && d.to > from);
      result = result.remove(edited);
    });
  });

  return result;
}

export function languagetoolPlugin(opts: LanguageToolPluginOptions): Plugin {
  const language = opts.language || "auto";
  ensureIssueStyle();
  // Latest serialisation, kept so a click can resolve the range even after the
  // decoration was built asynchronously.
  let lastSegs: Seg[] = [];
  // Language LT actually used for the last check (its detected code) — a learned
  // word is stored against this, not the "auto" request value.
  let lastLang = language;
  // Assigned by view() so a "Learn word" click can re-run the check and clear
  // the underline immediately.
  let recheck: (() => void) | null = null;
  // True once a check has succeeded and until one fails; while true the
  // browser's own spellcheck is switched off (see `native-spellcheck.ts`).
  let languagetoolWorking = false;
  // Issues the user dismissed with the chip's ⊗; filtered out of every re-check.
  const ignored = new Set<string>();

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
          return dropEdited(old.map(tr.mapping, tr.doc), tr);
        } catch {
          return DecorationSet.empty;
        }
      },
    },
    props: {
      decorations(state: EditorState) {
        return languagetoolPluginKey.getState(state) ?? DecorationSet.empty;
      },
      attributes() {
        return { spellcheck: nativeSpellcheck(languagetoolWorking) };
      },
      handleClick(view: EditorView, pos: number, event: MouseEvent) {
        try {
          const set = languagetoolPluginKey.getState(view.state);
          if (!set) return false;
          const hit = set.find(pos, pos)[0];
          if (!hit) return false;
          const spec = hit.spec as { ltMatch?: LTMatch; ltFrom?: number; ltTo?: number };
          if (!spec.ltMatch) return false;
          // No account behind an anonymous share view → no "Learn word" button.
          const learn: LearnContext | null = shareTokenFromLocation() || !LEARN_WORDS_ENABLED
            ? null
            : { docId: opts.docId, lang: lastLang, onLearned: () => recheck?.() };
          const match = spec.ltMatch;
          const onIgnore = () => {
            // Session-only: survives re-checks, forgotten on reload.
            ignored.add(ignoreKey(match, view.state.doc.textBetween(spec.ltFrom!, spec.ltTo!)));
            view.dispatch(view.state.tr.setMeta(languagetoolPluginKey, set.remove([hit])));
          };
          openPopover(view, match, spec.ltFrom!, spec.ltTo!, event.clientX, event.clientY, learn, onIgnore);
          return true;
        } catch {
          return false; // never let a click handler throw into the editor
        }
      },
    },
    view(view: EditorView) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let seq = 0; // guards against out-of-order responses
      statsSender = shareTokenFromLocation() ? null : createStatsSender(opts.docId);

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
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            showUnavailable(body?.error);
            return;
          }
          const data = (await res.json()) as { matches?: LTMatch[]; language?: string };
          if (mySeq !== seq) return; // a newer check superseded this one
          clearUnavailable();
          setWorking(true);
          if (data.language) lastLang = data.language;
          const decos = buildDecorations(view.state.doc, lastSegs, data.matches ?? [], ignored);
          view.dispatch(view.state.tr.setMeta(languagetoolPluginKey, decos));
        } catch {
          // Network/server error or serialisation issue — leave existing
          // decorations untouched; the next edit reschedules a check.
          showUnavailable();
        }
      }

      // Tell the user in the footer while checks fail, and clear it as soon as
      // one succeeds. Without this a broken LANGUAGETOOL_URL looks like a
      // document with no mistakes.
      let unavailable = false;

      // Switch the browser's spellcheck on or off. An empty transaction makes
      // ProseMirror re-read the `attributes` prop; it changes no document, so
      // it neither syncs to collaborators nor schedules another check.
      function setWorking(working: boolean) {
        if (languagetoolWorking === working) {
          return;
        }
        languagetoolWorking = working;
        view.dispatch(view.state.tr);
      }

      function showUnavailable(reason?: string) {
        setWorking(false);
        unavailable = true;
        publishStatus({
          id: STATUS_ID,
          text: "Spelling check unavailable",
          title: reason,
          tone: "error",
        });
      }
      function clearUnavailable() {
        if (!unavailable) {
          return;
        }
        unavailable = false;
        publishStatus({ id: STATUS_ID, text: null });
      }

      function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(runCheck, CHECK_DEBOUNCE_MS);
      }

      // Expose an immediate re-check for the "Learn word" action.
      recheck = () => { void runCheck(); };

      // Initial check shortly after mount (let Yjs sync the doc in first).
      timer = setTimeout(runCheck, CHECK_DEBOUNCE_MS);

      return {
        update(_view: EditorView, prevState: EditorState) {
          if (!prevState.doc.eq(view.state.doc)) schedule();
        },
        destroy() {
          if (timer) clearTimeout(timer);
          recheck = null;
          clearUnavailable();
          statsSender?.dispose();
          statsSender = null;
          closePopover();
          closeToast();
        },
      };
    },
  });
}
