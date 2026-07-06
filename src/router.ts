import { findConcept } from "./concepts/registry.ts";
import { renderHome } from "./pages/home.ts";
import { fadeIn } from "./lib/transition.ts";

// Hash router. Each route renders into `outlet` and returns a cleanup fn that
// runs on the next navigation (cancels animation loops, drops listeners).
export function startRouter(outlet: HTMLElement) {
  let cleanup: (() => void) | null = null;

  function resolve() {
    cleanup?.();
    cleanup = null;

    const hash = location.hash.replace(/^#/, "");
    const match = hash.match(/^\/concepts\/([\w-]+)$/);

    if (match) {
      const concept = findConcept(match[1]);
      if (concept) {
        cleanup = concept.mount(outlet);
        window.scrollTo(0, 0);
        fadeIn(outlet);
        return;
      }
    }
    cleanup = renderHome(outlet);
    window.scrollTo(0, 0);
    fadeIn(outlet);
  }

  window.addEventListener("hashchange", resolve);
  resolve();
}
