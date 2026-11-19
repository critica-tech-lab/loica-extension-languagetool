import { test, expect, describe } from "bun:test";
import { schema } from "prosemirror-schema-basic";
import type { Node as PMNode } from "prosemirror-model";
import { affectedByCode, docToText, offsetToPos } from "../doc-text";

const code = schema.marks.code.create();
const strong = schema.marks.strong.create();

function para(...children: PMNode[]): PMNode {
  return schema.node("paragraph", null, children);
}

function doc(...blocks: PMNode[]): PMNode {
  return schema.node("doc", null, blocks);
}

describe("docToText", () => {
  test("code block produces no text and its own line break", () => {
    const d = doc(
      para(schema.text("before")),
      schema.node("code_block", null, [schema.text("npm install")]),
      para(schema.text("after")),
    );

    expect(docToText(d).text).toBe("before\nafter");
  });

  test("inline code becomes one placeholder", () => {
    const d = doc(para(schema.text("Run "), schema.text("npm install", [code]), schema.text(" now")));

    expect(docToText(d).text).toBe("Run code now");
  });

  test("placeholder has no segment", () => {
    const d = doc(para(schema.text("Run "), schema.text("npm install", [code]), schema.text(" now")));
    const { segs } = docToText(d);

    expect(offsetToPos(segs, 4)).toBeNull();
    expect(offsetToPos(segs, 0)).toBe(1);
  });

  test("text after inline code still maps to the right position", () => {
    const d = doc(para(schema.text("Run "), schema.text("npm install", [code]), schema.text(" now")));
    const { text, segs } = docToText(d);

    // " now" starts at PM position 16, so the "n" of "now" is at 17.
    expect(offsetToPos(segs, text.indexOf("now"))).toBe(17);
  });

  test("adjacent code nodes give one placeholder", () => {
    const d = doc(para(schema.text("a", [code]), schema.text("b", [code, strong])));

    expect(docToText(d).text).toBe("code");
  });

  test("code at paragraph start and end", () => {
    const start = doc(para(schema.text("x", [code]), schema.text(" tail")));
    const end = doc(para(schema.text("head "), schema.text("x", [code])));

    expect(docToText(start).text).toBe("code tail");
    expect(docToText(end).text).toBe("head code");
  });

  test("code-only document has no text and no segments", () => {
    const d = doc(schema.node("code_block", null, [schema.text("x")]));
    const { text, segs } = docToText(d);

    expect(text).toBe("");
    expect(segs).toEqual([]);
  });

  test("code ending one paragraph and starting the next keeps both placeholders", () => {
    const d = doc(para(schema.text("a", [code])), para(schema.text("b", [code])));

    expect(docToText(d).text).toBe("code\ncode");
  });

  test("plain prose is unchanged", () => {
    const d = doc(para(schema.text("Hello world")), para(schema.text("Second")));
    const { text, segs } = docToText(d);

    expect(text).toBe("Hello world\nSecond");
    expect(segs).toEqual([
      { textStart: 0, pmFrom: 1, len: 11 },
      { textStart: 12, pmFrom: 14, len: 6 },
    ]);
  });
});

describe("affectedByCode", () => {
  const grammar = (offset: number, length: number) => ({ offset, length, issueType: "grammar" });

  function codeDoc(...children: PMNode[]) {
    return docToText(doc(para(...children)));
  }

  test("grammar match right before the placeholder is affected", () => {
    // "an `object`" is sent as "an code": the a/an hint is an artefact.
    const { text, holes } = codeDoc(schema.text("an "), schema.text("object", [code]));

    expect(affectedByCode(text, holes, grammar(0, 2))).toBe(true);
  });

  test("grammar match right after the placeholder is affected", () => {
    const { text, holes } = codeDoc(schema.text("x", [code]), schema.text(" is broken"));

    expect(affectedByCode(text, holes, grammar(text.indexOf("is"), 2))).toBe(true);
  });

  test("match overlapping the placeholder is affected", () => {
    const { text, holes } = codeDoc(schema.text("run "), schema.text("x", [code]));

    expect(affectedByCode(text, holes, grammar(0, text.length))).toBe(true);
  });

  test("match away from the placeholder is not affected", () => {
    const { text, holes } = codeDoc(schema.text("Fix this now and run "), schema.text("x", [code]));

    expect(affectedByCode(text, holes, grammar(0, 3))).toBe(false);
  });

  test("a misspelling next to the placeholder is still reported", () => {
    const { text, holes } = codeDoc(schema.text("teh "), schema.text("x", [code]));

    expect(affectedByCode(text, holes, { offset: 0, length: 3, issueType: "misspelling" })).toBe(false);
  });

  test("no placeholders, nothing is affected", () => {
    const { text, holes } = codeDoc(schema.text("an object"));

    expect(holes).toEqual([]);
    expect(affectedByCode(text, holes, grammar(0, 2))).toBe(false);
  });
});
