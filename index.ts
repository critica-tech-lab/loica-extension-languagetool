/**
 * LanguageTool extension (client registry entry).
 *
 * Contributes an editor plugin (via the `editorPlugins` extension point) that
 * checks every document with a self-hosted LanguageTool server and draws issues
 * as inline wavy underlines, with a click-to-fix popover. It NEVER edits the
 * document on its own — the doc changes only when the user accepts a suggestion.
 *
 * Auto-discovered by the client registry (`app/extensions/index.ts`) via its
 * build-time glob — this file just needs to `export default` a `LoicaExtension`.
 * The server half is in `index.server.ts` (discovered the same way).
 */
import type { LoicaExtension, ExtensionEditorPluginContext } from "~/extensions/types";
import { LOICA_EXTENSION_API_VERSION } from "~/extensions/types";
import { languagetoolPlugin } from "./languagetool-plugin";

const languagetoolExtension: LoicaExtension = {
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

export default languagetoolExtension;
