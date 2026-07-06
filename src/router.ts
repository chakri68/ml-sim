import { findConcept } from "./concepts/registry.ts";
import { renderHome } from "./pages/home.ts";
import { fadeIn } from "./lib/transition.ts";

const SITE_NAME = "ML Visualizations Lab";
const HOME_DESCRIPTION =
  "Interactive machine learning visualizations that turn ML concepts into experiments you can drag, break, and understand.";

// Keep the document title, meta description and canonical URL in sync with the
// active route. Crawlers that execute JS (and anyone bookmarking or sharing a
// concept) then see route-specific metadata instead of the static home values.
function setMeta(title: string, description: string) {
  document.title = title;

  const desc = document.querySelector<HTMLMetaElement>(
    'meta[name="description"]',
  );
  if (desc) desc.content = description;

  const canonical = document.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  );
  if (canonical) {
    const origin = canonical.href.split("#")[0].replace(/\/$/, "");
    canonical.href = location.hash
      ? `${origin}/${location.hash}`
      : `${origin}/`;
  }
}

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
        setMeta(`${concept.title} — ${SITE_NAME}`, concept.description);
        window.scrollTo(0, 0);
        fadeIn(outlet);
        return;
      }
    }
    cleanup = renderHome(outlet);
    setMeta(
      `${SITE_NAME} — Interactive Machine Learning, Visualized`,
      HOME_DESCRIPTION,
    );
    window.scrollTo(0, 0);
    fadeIn(outlet);
  }

  window.addEventListener("hashchange", resolve);
  resolve();
}
