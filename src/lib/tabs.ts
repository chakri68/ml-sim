// A small, framework-free tabbed side panel. Used by concept pages to put
// controls and notes/explanations into one switchable right-hand column, with a
// gentle slide-and-fade when the active tab changes. Tab contents are live DOM
// elements that persist across switches (they're moved in/out of the body, not
// rebuilt), so wired-up sliders/buttons keep their state and listeners.

import { el } from "./dom.ts";

const reducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

export type TabDef = {
  id: string;
  label: string;
  content: HTMLElement;
};

export type TabPanel = {
  el: HTMLElement;
  select(id: string): void;
};

export function createTabPanel(
  tabs: TabDef[],
  opts?: { initial?: string; ariaLabel?: string },
): TabPanel {
  const body = el("div", { class: "side-tab-body" });
  const tablist = el("div", {
    class: "side-tabs",
    role: "tablist",
    "aria-label": opts?.ariaLabel ?? "Panel",
  });

  const buttons: HTMLButtonElement[] = [];
  let activeIdx = Math.max(
    0,
    opts?.initial ? tabs.findIndex((t) => t.id === opts.initial) : 0,
  );

  function show(idx: number, animate: boolean) {
    const dir = idx > activeIdx ? 1 : -1;
    activeIdx = idx;
    buttons.forEach((b, i) => {
      const on = i === idx;
      b.classList.toggle("side-tab--on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    body.setAttribute("aria-labelledby", `tab-${tabs[idx].id}`);
    body.replaceChildren(tabs[idx].content);
    if (animate && !reducedMotion) {
      body.animate(
        [
          { opacity: 0, transform: `translateX(${dir * 14}px)` },
          { opacity: 1, transform: "translateX(0)" },
        ],
        { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
  }

  tabs.forEach((t, i) => {
    const btn = el(
      "button",
      {
        type: "button",
        class: "side-tab",
        role: "tab",
        id: `tab-${t.id}`,
        "aria-controls": "side-tab-body",
      },
      t.label,
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => show(i, true));
    buttons.push(btn);
    tablist.append(btn);
  });

  // Left/Right arrows move between tabs, matching the ARIA tablist pattern.
  tablist.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "ArrowRight" && key !== "ArrowLeft") return;
    event.preventDefault();
    const next =
      key === "ArrowRight"
        ? (activeIdx + 1) % tabs.length
        : (activeIdx - 1 + tabs.length) % tabs.length;
    show(next, true);
    buttons[next].focus();
  });

  body.setAttribute("role", "tabpanel");
  body.setAttribute("id", "side-tab-body");

  const root = el("div", { class: "side-panel" }, tablist, body);
  show(activeIdx, false);

  return {
    el: root,
    select(id: string) {
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx >= 0) show(idx, true);
    },
  };
}
