/** A search field for ontology terms, with a list of matches below it. */

import type { SearchResult, Term } from "../core/terms.js";
import { h } from "./dom.js";

export type Search = (query: string, kinds: string[]) => Promise<SearchResult>;

const DELAY = 120;

export class TermPicker {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private terms: Term[] = [];
  private active = -1;
  private timer = 0;
  private searches = 0;

  constructor(private readonly options: {
    kinds: string[];
    placeholder: string;
    search: Search;
    onPick: (term: Term) => void;
  }) {
    this.input = h("input", { type: "search", placeholder: options.placeholder, autocomplete: "off",
                              "aria-label": options.placeholder });
    this.list = h("ul", { class: "picker-list", role: "listbox", hidden: true });
    this.el = h("div", { class: "picker" }, this.input, this.list);

    this.input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(), DELAY);
    });
    this.input.addEventListener("keydown", (event) => this.key(event));
    this.input.addEventListener("blur", () => setTimeout(() => this.close(), 150));
    this.input.addEventListener("focus", () => {
      if (this.terms.length) this.list.hidden = false;
    });
  }

  focus() {
    this.input.focus();
  }

  private async run() {
    const query = this.input.value.trim();
    const run = ++this.searches;
    if (!query) {
      this.show({ terms: [], total: 0 }, "");
      return;
    }
    const result = await this.options.search(query, this.options.kinds);
    if (run === this.searches) this.show(result, query);
  }

  private show(result: SearchResult, query: string) {
    this.terms = result.terms;
    this.active = this.terms.findIndex(usable);
    this.list.replaceChildren();
    if (!query) {
      this.list.hidden = true;
      return;
    }
    if (!this.terms.length) {
      this.list.append(h("li", { class: "picker-empty" }, "No matching terms"));
    }
    this.terms.forEach((term, i) => {
      const li = h("li", { role: "option", class: usable(term) ? "" : "unusable", title: term.definition || term.iri },
        h("span", { class: "term-id" }, term.id ?? "no ID"),
        h("span", { class: "term-label" }, term.label),
        h("span", { class: "term-kind" }, term.kind),
        term.deprecated ? h("span", { class: "tag tag-warning" }, "deprecated") : null,
        term.id === null ? h("span", { class: "tag" }, "cannot be written as an ID") : null);
      li.addEventListener("mousedown", (event) => {
        event.preventDefault();
        if (usable(term)) this.pick(i);
      });
      this.list.append(li);
    });
    if (result.total > this.terms.length) {
      this.list.append(h("li", { class: "picker-empty" }, `${result.total - this.terms.length} more; type more to narrow`));
    }
    this.mark();
    this.list.hidden = false;
  }

  private mark() {
    [...this.list.children].forEach((li, i) => li.classList.toggle("active", i === this.active));
    this.list.children[this.active]?.scrollIntoView({ block: "nearest" });
  }

  private move(step: number) {
    for (let i = this.active + step; i >= 0 && i < this.terms.length; i += step) {
      if (usable(this.terms[i]!)) {
        this.active = i;
        this.mark();
        return;
      }
    }
  }

  private key(event: KeyboardEvent) {
    if (event.key === "ArrowDown") this.move(1);
    else if (event.key === "ArrowUp") this.move(-1);
    else if (event.key === "Enter" && !this.list.hidden && this.active >= 0) this.pick(this.active);
    else if (event.key === "Escape" && !this.list.hidden) this.close();
    else return;
    event.preventDefault();
  }

  private pick(i: number) {
    const term = this.terms[i]!;
    this.input.value = "";
    this.close();
    this.terms = [];
    this.options.onPick(term);
  }

  private close() {
    this.list.hidden = true;
  }
}

function usable(term: Term): boolean {
  return term.id !== null;
}
