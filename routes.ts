import { route, type RouteConfigEntry } from "@react-router/dev/routes";

// Discovered by the glob in `app/extensions/routes.ts`. The route points at a
// thin shim under `app/routes/` (not directly at `check.ts`) because this
// extension is symlinked in from an out-of-root repo: React Router only runs
// its server/client split on route modules physically under `app/`, so the
// real action can't live here. The shim (`app/routes/api.languagetool.$id.ts`)
// re-exports `check.ts`'s `action`, keeping the server-only imports off the
// client. The shim source is `route-shim.ts` in this repo — see README.
export default [
  route("api/languagetool/:id", "routes/api.languagetool.$id.ts"),
] satisfies RouteConfigEntry[];
