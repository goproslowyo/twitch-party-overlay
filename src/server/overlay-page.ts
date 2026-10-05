/**
 * The overlay page: Bun's HTML import bundles `src/overlay/index.html` with its `main.ts` and
 * `styles.css` — at first request in `bun run dev`, ahead of time under `bun build --compile` — and serves the bundle
 * (plus its hashed `/chunk-*.js` / `/chunk-*.css` assets) as a `Bun.serve` route on the overlay listener.
 *
 * This lives apart from overlay.ts on purpose: the client modules import types and small constants from overlay.ts,
 * and a module that imports an `.html` cannot be bundled for the browser ("No matching export in index.html").
 */
import type { HTMLBundle } from "bun";
import overlayPage from "../overlay/index.html";
import { PAGE_PATH } from "./overlay.ts";

export const overlayRoutes: Record<string, HTMLBundle> = { [PAGE_PATH]: overlayPage };
