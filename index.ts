/**
 * LanguageTool extension (client registry entry).
 *
 * Contributes an editor plugin (via the `editorPlugins` extension point) that
 * checks every document with a self-hosted LanguageTool server and draws issues
 * as inline wavy underlines, with a click-to-fix popover. It NEVER edits the
 * document on its own — the doc changes only when the user accepts a suggestion.
 *
 * Registered in `app/extensions/index.ts` (client) and mirrored in
 * `index.server.ts` (server, for the /api/languagetool route + enablement).
 */
import type { LoicaExtension, ExtensionEditorPluginContext } from "~/extensions/types";
import { LOICA_EXTENSION_API_VERSION } from "~/extensions/types";
import { languagetoolPlugin } from "./languagetool-plugin";

export const languagetoolExtension: LoicaExtension = {
  id: "languagetool",
  apiVersion: LOICA_EXTENSION_API_VERSION,
  version: "0.2.0",
  description:
    "Inline grammar, spelling and style checking with a self-hosted LanguageTool server. Underlines issues in the text; click to apply a fix.",
  // Off until an admin turns it on: it needs an external LanguageTool server.
  defaultEnabled: false,
  homepage: "https://languagetool.org",
  repository: "https://github.com/languagetool-org/languagetool",
  // Injected into the core editor when this extension is enabled.
  editorPlugins: (ctx: ExtensionEditorPluginContext) => [
    languagetoolPlugin({ docId: ctx.docId }),
  ],
};
