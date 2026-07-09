/**
 * Shim route source for the LanguageTool extension.
 *
 * Copy this to `app/routes/api.languagetool.$id.ts` in the host (the install
 * step does this; it's git-ignored there). React Router only runs its
 * server/client split on route modules physically under `app/`, and this
 * extension is symlinked in from an out-of-root repo — so the real `action`
 * (in `check.ts`, which imports server-only `~/lib/*`) can't be a route module
 * directly. This thin re-export IS a real file under `app/routes/`, so RR marks
 * it server-only and keeps `check.ts`'s imports off the client bundle.
 */
export { action } from "~/extensions/languagetool/check";
