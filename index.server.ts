/**
 * LanguageTool extension (server registry entry).
 *
 * The client half (`index.ts`) contributes the inline editor plugin. This
 * server half exists so the extension appears in `serverExtensions` — which
 * drives `getEnabledExtensionIdSet()` and therefore gates the client plugin via
 * `useEnabledExtensionIds()`. Without it the underlines would never render.
 *
 * The actual check work lives in the `/api/languagetool/:id` route
 * (`check.ts`), which calls a self-hosted LanguageTool server.
 */
import type { LoicaExtension } from "~/extensions/types";
import { LOICA_EXTENSION_API_VERSION } from "~/extensions/types";

const languagetoolServerExtension: LoicaExtension = {
  id: "languagetool",
  apiVersion: LOICA_EXTENSION_API_VERSION,
  version: "0.2.0",
  description:
    "Inline grammar, spelling and style checking with a self-hosted LanguageTool server. Underlines issues in the text; click to apply a fix.",
  defaultEnabled: false,
};

export default languagetoolServerExtension;
