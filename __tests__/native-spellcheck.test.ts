import { test, expect, describe } from "bun:test";
import { nativeSpellcheck } from "../native-spellcheck";

describe("nativeSpellcheck", () => {
  test("browser spellcheck stays on until LanguageTool has answered", () => {
    expect(nativeSpellcheck(false)).toBe("true");
  });

  test("it turns off while LanguageTool is working", () => {
    expect(nativeSpellcheck(true)).toBe("false");
  });
});
