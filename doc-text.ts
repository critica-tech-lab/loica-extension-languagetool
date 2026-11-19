/**
 * Plain-text serialisation of the editor doc, plus the offset -> PM position
 * mapping used to put LanguageTool's matches back on the right characters.
 *
 * Code is not prose, so it is not sent for checking. A code block vanishes (its
 * block break stays); inline code becomes one placeholder word, so a sentence
 * like "Run `npm install` now" still reads as a sentence:
 *
 *   "Run " + `npm install` + " now"   ->   "Run code now"
 *
 * The placeholder has no segment, so a match on it maps to no position and is
 * dropped, like the "\n" block separators.
 */
import type { Node as PMNode } from "prosemirror-model";

export const CODE_BLOCK_NODE = "code_block";
export const CODE_MARK = "code";
export const CODE_PLACEHOLDER = "code";

const BLOCK_BREAK = "\n";
const MISSPELLING = "misspelling";

/** Where a placeholder sits in the serialised text. */
export interface Hole {
  start: number;
  end: number;
}

export interface Seg {
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
export function docToText(doc: PMNode): { text: string; segs: Seg[]; holes: Hole[] } {
  const segs: Seg[] = [];
  const holes: Hole[] = [];
  let text = "";
  // True while walking a run of code-marked text, so it adds one placeholder.
  let inCode = false;

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (node.marks.some((mark) => mark.type.name === CODE_MARK)) {
        if (!inCode) {
          holes.push({ start: text.length, end: text.length + CODE_PLACEHOLDER.length });
          text += CODE_PLACEHOLDER;
        }
        inCode = true;
        return false;
      }

      inCode = false;
      segs.push({ textStart: text.length, pmFrom: pos, len: node.text.length });
      text += node.text;
      return false;
    }

    if (node.isBlock) {
      inCode = false;
      if (text.length > 0 && !text.endsWith(BLOCK_BREAK)) {
        text += BLOCK_BREAK;
      }
    }
    return node.type.name !== CODE_BLOCK_NODE;
  });
  return { text, segs, holes };
}

/**
 * True for a non-spelling match that overlaps or sits right next to a
 * placeholder. The placeholder stands in for code of unknown shape, so a
 * grammar hint there is an artefact: "an `object`" is sent as "an code" and
 * would be told to use "a". Spelling is unaffected by neighbours and stays.
 */
export function affectedByCode(
  text: string,
  holes: Hole[],
  match: { offset: number; length: number; issueType: string },
): boolean {
  if (match.issueType === MISSPELLING) {
    return false;
  }

  const end = match.offset + match.length;
  return holes.some((hole) => {
    if (match.offset < hole.end && end > hole.start) {
      return true;
    }
    if (end <= hole.start) {
      return text.slice(end, hole.start).trim() === "";
    }
    return text.slice(hole.end, match.offset).trim() === "";
  });
}

/** Map a plain-text offset to a PM position, or null if it lands in a gap. */
export function offsetToPos(segs: Seg[], offset: number): number | null {
  for (const s of segs) {
    if (offset >= s.textStart && offset < s.textStart + s.len) {
      return s.pmFrom + (offset - s.textStart);
    }
  }
  return null;
}
