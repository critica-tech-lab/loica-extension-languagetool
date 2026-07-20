import { route, type RouteConfigEntry } from "@react-router/dev/routes";

// Discovered by the glob in `app/extensions/routes.ts`. Installed as a git
// submodule (see .gitmodules), so this file is physically under `app/` like
// any other extension — no shim needed (unlike the symlink install path
// described in this repo's README).
export default [
  route("api/languagetool/:id", "extensions/languagetool/check.ts"),
] satisfies RouteConfigEntry[];
