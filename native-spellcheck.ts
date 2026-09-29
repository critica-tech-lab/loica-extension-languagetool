/**
 * Value of the editor's `spellcheck` attribute.
 *
 * The browser underlines misspellings on its own, with its own dictionary, and
 * a word can end up underlined twice with different suggestions. Once
 * LanguageTool has answered, it is the only checker shown. Until then, and
 * whenever LanguageTool stops answering, the browser's stays on so the writer
 * is never left with no spellcheck at all.
 */
export function nativeSpellcheck(languagetoolWorking: boolean): "true" | "false" {
  return languagetoolWorking ? "false" : "true";
}
