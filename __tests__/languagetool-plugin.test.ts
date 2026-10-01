import { test, expect, describe } from "bun:test";
import { EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { languagetoolPlugin, languagetoolPluginKey } from "../languagetool-plugin";

/** "aa berdad cc" with a spelling decoration over "berdad" (positions 4..10). */
function stateWithIssue() {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("aa berdad cc")])]);
  let state = EditorState.create({ doc, plugins: [languagetoolPlugin({ docId: "d" })] });
  const set = DecorationSet.create(state.doc, [
    Decoration.inline(4, 10, { class: "lt-issue lt-issue-spell" }, { ltMatch: {} }),
  ]);
  state = state.apply(state.tr.setMeta(languagetoolPluginKey, set));
  return state;
}

function decoCount(state: EditorState): number {
  return languagetoolPluginKey.getState(state)!.find().length;
}

describe("issue underline after an edit", () => {
  test("is dropped once its text is replaced by the accepted fix", () => {
    const state = stateWithIssue();
    const next = state.apply(state.tr.insertText("verdad", 4, 10));
    expect(decoCount(next)).toBe(0);
  });

  test("survives an edit elsewhere and keeps tracking its text", () => {
    const state = stateWithIssue();
    const next = state.apply(state.tr.insertText("zz ", 1, 1));
    const [deco] = languagetoolPluginKey.getState(next)!.find();
    expect(next.doc.textBetween(deco.from, deco.to)).toBe("berdad");
  });

  test("does not drop a neighbouring issue that only touches the edit", () => {
    const state = stateWithIssue();
    // Replace "aa " (1..4), which ends exactly where the issue starts.
    const next = state.apply(state.tr.insertText("xx ", 1, 4));
    expect(decoCount(next)).toBe(1);
  });
});
