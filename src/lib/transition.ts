// Shared screen-transition helpers. Screens fade in when they're swapped into a
// container (route changes, loading screens, loading → content handoffs).

const reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

// Fade a freshly-swapped container's contents in. No-op under reduced motion.
// Uses the Web Animations API so repeated calls restart cleanly and the element
// rests at its natural state when done (no lingering inline styles).
//
// A small upward rise rides along with the opacity: on the near-black theme a
// pure fade of dark content is barely perceptible, so the translate is what
// actually reads as "a new screen arriving."
export function fadeIn(node: HTMLElement, duration = 420): void {
  if (reducedMotion) return;
  node.animate(
    [
      { opacity: 0, transform: "translateY(8px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
}
