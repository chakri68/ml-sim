// Tiny DOM builders. No framework — just typed wrappers over createElement.

type Child = Node | string | number | false | null | undefined;
type Props = Record<string, unknown>;

function appendChildren(node: Element, children: Child[]) {
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
}

function applyProps(node: HTMLElement, props: Props) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value as Record<string, string>);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props: Record<string, string | number> = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    node.setAttribute(key, String(value));
  }
  appendChildren(node, children);
  return node;
}

export function clear(node: Element) {
  node.replaceChildren();
}
