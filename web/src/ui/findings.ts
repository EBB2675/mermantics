/** The findings, grouped by check, with the same levels and messages as the command line tool. */

import type { Finding } from "../core/model.js";

// The order the checks run in; anything else goes after them.
const CHECKS: [string, string][] = [
  ["parse", "Reading the diagram"],
  ["ontology", "Ontology"],
  ["ids", "IDs"],
  ["labels", "Labels"],
  ["schema", "Schema"],
  ["domain-range", "Domain and range"],
  ["vocabulary", "Vocabularies"],
  ["data", "Example data"],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

export class FindingsPanel {
  private items: HTMLElement[] = [];

  constructor(private readonly root: HTMLElement, private readonly onSelect: (finding: Finding) => void) {}

  show(findings: Finding[], summary: string, passed: boolean) {
    this.root.replaceChildren();
    this.items = [];
    const head = el("p", `summary ${passed ? "passed" : "failed"}`, summary);
    this.root.append(head);

    const titles = new Map(CHECKS);
    const order = [...CHECKS.map(([c]) => c), ...new Set(findings.map((f) => f.check))];
    for (const check of new Set(order)) {
      const group = findings.filter((f) => f.check === check);
      if (!group.length) continue;
      const section = el("section", "check");
      section.append(el("h3", "", titles.get(check) ?? check));
      const list = el("ul");
      for (const f of group) list.append(this.item(f));
      section.append(list);
      this.root.append(section);
    }
  }

  showMessage(text: string) {
    this.root.replaceChildren(el("p", "summary", text));
    this.items = [];
  }

  private item(f: Finding): HTMLElement {
    const li = el("li", `finding level-${f.level}`);
    const locatable = f.nodeId !== undefined || f.edgeIndex !== undefined || f.line !== undefined;
    const main = el(locatable ? "button" : "div", "finding-main");
    main.append(el("span", "badge", f.level));
    const body = el("span", "finding-body");
    if (f.where) body.append(el("span", "where", f.where));
    body.append(el("span", "message", f.message));
    main.append(body);
    if (locatable) {
      main.addEventListener("click", () => {
        for (const other of this.items) other.classList.remove("selected");
        li.classList.add("selected");
        this.onSelect(f);
      });
    }
    li.append(main);
    if (f.details) {
      const details = el("details");
      details.append(el("summary", "", f.level === "error" ? "Why" : "Details"), el("pre", "", f.details));
      li.append(details);
    }
    this.items.push(li);
    return li;
  }
}
