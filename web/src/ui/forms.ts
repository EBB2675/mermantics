/**
 * The "Boxes and arrows" tab: a list of the diagram's boxes and arrows, and forms to add,
 * change and remove them.
 *
 * The forms never keep a copy of the diagram. They read the parsed text when they open and
 * write their result back as text changes (core/edit.ts), one editor transaction per save.
 */

import * as edit from "../core/edit.js";
import * as labels from "../core/labels.js";
import type { Diagram } from "../core/mermaid.js";
import type { Config, Edge, Node } from "../core/model.js";
import type { Term } from "../core/terms.js";
import { h } from "./dom.js";
import { icon, type IconName } from "./icons.js";
import { TermPicker, type Search } from "./termpicker.js";

export type Level = "error" | "warning";

export interface FormsHost {
  text(): string;
  diagram(): Diagram; // the parsed text()
  apply(changes: edit.Change[]): void;
  search: Search;
  lookup(ids: string[]): Promise<(Term | null)[]>;
  // Boxes and arrows with findings, if the last check is of the current text.
  levels(): { nodes: Map<string, Level>; edges: Map<number, Level> } | null;
  select(target: { nodeId: string } | { edgeIndex: number } | null): void;
  showLine(line: number): void;
  undo(): void;
  redo(): void;
}

// Style classes the form always offers, whether or not the diagram defines them.
const USUAL_KINDS = ["local", "vocab", "note"];

const CLASS_KINDS = ["class"];
const PROPERTY_KINDS = ["object property"];

function hasAny(css: Iterable<string>, classes: Set<string>): boolean {
  for (const c of css) if (classes.has(c)) return true;
  return false;
}

function nodeTitle(node: Node): string {
  return labels.title(node.label, node.id);
}

/** A button with an icon and, unless `iconOnly`, its text. */
function button(name: IconName, text: string, attrs: Record<string, string | boolean> = {}, iconOnly = false): HTMLButtonElement {
  const b = h("button", { type: "button", ...attrs, ...(iconOnly ? { "aria-label": text, title: attrs.title ?? text } : {}) },
              icon(name));
  if (!iconOnly) b.append(h("span", {}, text));
  return b;
}

/** Fill and border colours of each `classDef`, for the swatches next to the box types. */
function classColours(text: string): Map<string, { fill: string; stroke: string }> {
  const out = new Map<string, { fill: string; stroke: string }>();
  for (const line of text.split("\n")) {
    const m = /^\s*classDef\s+([\w,-]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const fill = /(?:^|[,;\s])fill:\s*([^,;\s]+)/.exec(m[2]!)?.[1] ?? "";
    const stroke = /(?:^|[,;\s])stroke:\s*([^,;\s]+)/.exec(m[2]!)?.[1] ?? "";
    for (const name of m[1]!.split(",")) if (name) out.set(name, { fill, stroke });
  }
  return out;
}

function field(label: string, control: HTMLElement, hint = ""): HTMLElement {
  return h("label", { class: "field" }, label ? h("span", { class: "field-label" }, label) : null, control,
           hint ? h("span", { class: "hint" }, hint) : null);
}

/** A textarea that grows with its lines (up to a limit). */
function autoGrow(area: HTMLTextAreaElement, min: number, max = 14): HTMLTextAreaElement {
  const fit = () => (area.rows = Math.min(max, Math.max(min, area.value.split("\n").length + 1)));
  area.addEventListener("input", fit);
  queueMicrotask(fit);
  return area;
}

function section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  return h("section", { class: "form-section" }, h("h4", {}, title), ...children);
}

function short(text: string, max = 110): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Shows what the ontology says about an ID: its label, or that it is missing or deprecated. */
function termStatus(host: FormsHost, curie: string, kinds: string[]): HTMLElement {
  const el = h("span", { class: "term-status" }, "…");
  void host.lookup([curie]).then(([term]) => {
    el.replaceChildren();
    if (!term) {
      el.append(h("span", { class: "tag tag-error" }, "not in the ontology"));
      return;
    }
    el.title = term.definition || term.iri;
    el.append(h("span", { class: "term-label" }, term.label));
    if (term.deprecated) el.append(h("span", { class: "tag tag-error" }, "deprecated"));
    if (!kinds.includes(term.kind)) el.append(h("span", { class: "tag tag-warning" }, `${term.kind}, not ${kinds[0]}`));
  });
  return el;
}

export class FormsPanel {
  private readonly filter: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly formBox: HTMLElement;
  private formOpen = false;

  constructor(private readonly root: HTMLElement, private readonly host: FormsHost, private readonly config: Config) {
    this.filter = h("input", { type: "search", placeholder: "Filter boxes and arrows", "aria-label": "Filter" });
    this.filter.addEventListener("input", () => this.renderList());
    const add = button("plus", "Box", { class: "primary", title: "Add a box" });
    add.addEventListener("click", () => this.openBox(null));
    const arrow = button("plus", "Arrow", { title: "Add an arrow" });
    arrow.addEventListener("click", () => this.openArrow(null));
    const undo = button("undo", "Undo", { class: "ghost", title: "Undo the last change (Ctrl+Z)" }, true);
    undo.addEventListener("click", () => host.undo());
    const redo = button("redo", "Redo", { class: "ghost", title: "Redo (Ctrl+Shift+Z)" }, true);
    redo.addEventListener("click", () => host.redo());
    this.list = h("div", { class: "forms-list" });
    this.formBox = h("div", { class: "forms-form", hidden: true });
    root.append(h("div", { class: "forms-bar" }, add, arrow,
                  h("label", { class: "search-field" }, icon("search"), this.filter), undo, redo),
                this.list, this.formBox);
  }

  /** The text changed: show the new list (an open form stays open). */
  refresh() {
    if (!this.formOpen) this.renderList();
  }

  /** Close any open form (a new diagram was loaded). */
  reset() {
    this.closeForm();
  }

  private isVocab(css: Iterable<string>): boolean {
    return hasAny(css, this.config.vocabClasses);
  }

  // ---- list ----------------------------------------------------------------------------------

  private renderList() {
    const d = this.host.diagram();
    const levels = this.host.levels();
    const q = this.filter.value.trim().toLowerCase();
    const matches = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
    const colours = classColours(this.host.text());
    const card = (level: Level | undefined, top: HTMLElement[], bottom: string, open: () => void) => {
      const b = h("button", { type: "button", class: `card ${level ? `has-${level}` : ""}` },
        h("span", { class: "card-top" }, ...top), bottom ? h("span", { class: "card-sub" }, bottom) : null);
      b.addEventListener("click", open);
      return h("li", {}, b);
    };
    const swatch = (css: Set<string>) => {
      const c = [...css].map((k) => colours.get(k)).find((x) => x);
      return h("span", { class: "swatch", style: c ? `background:${c.fill};border-color:${c.stroke || c.fill}` : null });
    };

    const boxes = h("ul", { class: "cards" });
    for (const node of d.nodes.values()) {
      if (!matches(nodeTitle(node), node.id, labels.plain(node.label))) continue;
      const curies = labels.findCuries(node.label);
      let sub: string;
      if (this.isVocab(node.css)) sub = `${curies.length} term${curies.length === 1 ? "" : "s"}`;
      else if (!node.defined) sub = "only in arrows, no box line yet";
      else if (curies.length) {
        const entry = edit.readBoxLabel(node.label, false)?.lines.find((l) => "curie" in l);
        sub = entry && "curie" in entry && entry.label ? `${entry.curie} · ${entry.label}` : curies[0]!;
      } else sub = "no ontology alignment";
      boxes.append(card(levels?.nodes.get(node.id), [
        swatch(node.css),
        h("span", { class: "card-name" }, nodeTitle(node)),
        ...[...node.css].map((c) => h("span", { class: "chip" }, c)),
      ], sub, () => this.openBox(node.id)));
    }

    const arrows = h("ul", { class: "cards" });
    d.edges.forEach((e, i) => {
      const src = d.nodes.get(e.src)!;
      const dst = d.nodes.get(e.dst)!;
      const name = labels.segments(e.label)[0] ?? "";
      if (!matches(nodeTitle(src), nodeTitle(dst), e.src, e.dst, labels.plain(e.label))) return;
      const curie = labels.findCuries(e.label)[0];
      const sub = e.kind === "inherit" ? "inheritance" : [name || "no label", curie].filter((x) => x).join(" · ");
      arrows.append(card(levels?.edges.get(i), [
        h("span", { class: "card-name" }, nodeTitle(src)),
        h("span", { class: `card-arrow ${e.kind}` }, icon("arrow")),
        h("span", { class: "card-name" }, nodeTitle(dst)),
      ], sub, () => this.openArrow(i)));
    });

    const heading = (title: string, n: number) => h("h3", { class: "list-head" }, title, h("span", { class: "count" }, String(n)));
    this.list.replaceChildren(
      heading("Boxes", boxes.children.length),
      boxes.children.length ? boxes : h("p", { class: "empty" }, q ? "No box matches." : "No boxes yet. Add one with + Box."),
      heading("Arrows", arrows.children.length),
      arrows.children.length ? arrows : h("p", { class: "empty" }, q ? "No arrow matches." : "No arrows yet."));
  }

  // ---- forms ---------------------------------------------------------------------------------

  private show(form: HTMLElement) {
    this.formOpen = true;
    this.list.hidden = true;
    this.formBox.hidden = false;
    this.formBox.replaceChildren(form);
    form.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea")?.focus();
  }

  private closeForm() {
    this.formOpen = false;
    this.formBox.hidden = true;
    this.formBox.replaceChildren();
    this.list.hidden = false;
    this.renderList();
  }

  /** Save the changes, or show why not. */
  private save(error: HTMLElement, make: () => edit.Change[], then: () => void): void {
    try {
      const changes = make();
      this.host.apply(changes);
      this.closeForm();
      then();
    } catch (exc) {
      if (!(exc instanceof edit.EditError)) throw exc;
      error.textContent = exc.message;
      error.hidden = false;
    }
  }

  private nodeOptions(select: HTMLSelectElement, except: string[] = [], chosen = "") {
    select.replaceChildren(h("option", { value: "" }, "Choose a box…"));
    for (const node of this.host.diagram().nodes.values()) {
      if (except.includes(node.id)) continue;
      select.append(h("option", { value: node.id, selected: node.id === chosen }, `${nodeTitle(node)} (${node.id})`));
    }
  }

  private formShell(title: string, body: HTMLElement[], actions: HTMLElement[]): { form: HTMLFormElement; error: HTMLElement } {
    const error = h("p", { class: "form-error", hidden: true, role: "alert" });
    const back = button("back", "Boxes and arrows", { class: "back" });
    back.addEventListener("click", () => this.closeForm());
    const form = h("form", { class: "edit-form", novalidate: true },
      h("div", { class: "form-head" }, back, h("h3", {}, title)),
      h("div", { class: "form-body" }, ...body, error),
      h("div", { class: "form-actions" }, ...actions));
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) this.closeForm();
    });
    return { form, error };
  }

  /** Open the box form: for a new box (null) or one in the diagram. */
  openBox(id: string | null) {
    const text = this.host.text();
    const d = this.host.diagram();
    const node = id === null ? undefined : d.nodes.get(id);
    if (id !== null && !node) return;
    const info = id === null ? null : edit.boxInfo(text, id, this.config)!;
    new BoxForm(this, this.host, this.config, info, node ?? null);
    this.host.select(id === null ? null : { nodeId: id });
  }

  /** Open the arrow form: for a new arrow (null) or one in the diagram, by index. */
  openArrow(index: number | null, from = "") {
    const edge = index === null ? null : this.host.diagram().edges[index] ?? null;
    if (index !== null && !edge) return;
    new ArrowForm(this, this.host, this.config, index, edge, from);
    this.host.select(index === null ? null : { edgeIndex: index });
  }

  // Shared with the form classes below.
  readonly ui = {
    show: (form: HTMLElement) => this.show(form),
    close: () => this.closeForm(),
    save: (error: HTMLElement, make: () => edit.Change[], then: () => void) => this.save(error, make, then),
    shell: (title: string, body: HTMLElement[], actions: HTMLElement[]) => this.formShell(title, body, actions),
    nodeOptions: (select: HTMLSelectElement, except?: string[], chosen?: string) => this.nodeOptions(select, except, chosen),
    isVocab: (css: Iterable<string>) => this.isVocab(css),
  };
}

// ---- box form ----------------------------------------------------------------------------------

type Entry = { code: string; curie: string; label: string };

class BoxForm {
  private mode: "fields" | "raw" = "fields";
  private name = "";
  private bold = true;
  private rows: edit.LabelLine[] = []; // all lines after the name
  private raw = "";
  private kind: string | null;
  private parents: string[];
  private idEdited = false;
  private readonly content = h("div", { class: "box-content" });
  private readonly idInput: HTMLInputElement;
  private readonly nameField: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly parentsBox = h("div", { class: "parents" });

  constructor(private readonly panel: FormsPanel, private readonly host: FormsHost, private readonly config: Config,
              private readonly info: edit.BoxInfo | null, node: Node | null) {
    const text = host.text();
    this.kind = info ? info.kind : "local";
    this.parents = info ? [...info.parents] : [];
    this.load(info ? info.label : "<b></b>");

    this.nameInput = h("input", { type: "text", value: this.name, placeholder: "e.g. Simulation", required: true });
    this.nameInput.addEventListener("input", () => {
      this.name = this.nameInput.value;
      if (!info && !this.idEdited) this.idInput.value = this.name.trim() ? edit.newNodeId(this.name, host.text()) : "";
    });
    this.nameField = field("Name", this.nameInput);

    this.idInput = h("input", { type: "text", value: info?.id ?? "", spellcheck: false, class: "mono" });
    this.idInput.addEventListener("input", () => (this.idEdited = true));

    const kinds = [...new Set([...edit.styleClasses(text), ...USUAL_KINDS, ...(this.kind ? [this.kind] : [])])];
    const colours = classColours(text);
    const kindHelp = h("span", { class: "hint" });
    const other = info?.otherClasses ?? [];
    const describe = () => {
      const k = this.kind;
      let help = !k ? "No box type: drawn in the default style, checked like any box."
        : config.vocabClasses.has(k) ? "A vocabulary: its terms are checked to be kinds of the box that points at it."
        : config.skipClasses.has(k) ? "A note or legend: the checks ignore this box."
        : "Sets the colour only; the box is checked like any other.";
      if (other.length) help += ` Also styled ${other.join(", ")} elsewhere in the text.`;
      kindHelp.textContent = help;
    };
    const pills = h("div", { class: "pills", role: "radiogroup", "aria-label": "Box type" });
    for (const k of ["", ...kinds]) {
      const c = colours.get(k);
      const radio = h("input", { type: "radio", name: "box-kind", value: k, checked: (this.kind ?? "") === k });
      radio.addEventListener("change", () => {
        const label = this.label();
        this.kind = k || null;
        this.load(label);
        this.render();
        describe();
      });
      pills.append(h("label", { class: "pill" }, radio,
        h("span", { class: "swatch", style: c ? `background:${c.fill};border-color:${c.stroke || c.fill}` : null }),
        k || "none"));
    }
    describe();

    const actions: HTMLElement[] = [h("button", { type: "submit", class: "primary" }, info ? "Save" : "Add box")];
    const cancel = h("button", { type: "button", class: "ghost" }, "Cancel");
    cancel.addEventListener("click", () => panel.ui.close());
    actions.push(cancel, h("span", { class: "grow" }));
    if (info) {
      const arrow = button("arrow", "Arrow from this box", { class: "ghost", title: "Add an arrow starting at this box" }, true);
      arrow.addEventListener("click", () => panel.openArrow(null, info.id));
      actions.push(arrow);
      if (info.line !== null) {
        const show = button("code", `Show in text (line ${info.line})`, { class: "ghost" }, true);
        show.addEventListener("click", () => host.showLine(info.line!));
        actions.push(show);
      }
      const remove = button("trash", "Delete box", { class: "ghost danger" }, true);
      remove.addEventListener("click", () => this.remove());
      actions.push(remove);
    }

    const title = info ? (node ? nodeTitle(node) : info.id) : "New box";
    const { form, error } = panel.ui.shell(title, [
      section("Label", this.nameField, this.content),
      section("Box type", pills, kindHelp),
      section("Parents", h("div", { class: "field" }, this.parentsBox,
        h("span", { class: "hint" }, "Each parent is a solid inheritance arrow to this box."))),
      section("Box id", field("", this.idInput, "Used in the arrows. Changing it renames the box everywhere.")),
    ], actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit(error);
    });
    this.render();
    panel.ui.show(form);
  }

  private get vocab(): boolean {
    return this.panel.ui.isVocab([...(this.kind ? [this.kind] : []), ...(this.info?.otherClasses ?? [])]);
  }

  /** Read a raw label into the fields, or keep it raw if they cannot hold it. */
  private load(label: string) {
    const fields = edit.readBoxLabel(label, this.vocab);
    if (fields) {
      this.mode = "fields";
      this.name = fields.name;
      this.bold = fields.bold;
      this.rows = fields.lines;
    } else {
      this.mode = "raw";
      this.raw = label;
    }
  }

  private label(): string {
    if (this.mode === "raw") return this.raw;
    return edit.writeBoxLabel({ name: this.name.trim(), bold: this.bold, lines: this.rows });
  }

  private render() {
    this.nameField.hidden = this.mode === "raw";
    if (this.nameInput) this.nameInput.value = this.name;
    if (this.mode === "raw") this.renderRaw();
    else if (this.vocab) this.renderVocab();
    else this.renderBox();
    this.renderParents();
  }

  private toRaw(): HTMLElement {
    const button = h("button", { type: "button", class: "link" }, "Edit the whole label as text");
    button.addEventListener("click", () => {
      this.raw = this.label();
      this.mode = "raw";
      this.render();
    });
    return button;
  }

  private renderRaw() {
    const area = h("textarea", { rows: 5, spellcheck: false, class: "mono" });
    area.value = this.raw;
    area.addEventListener("input", () => (this.raw = area.value));
    const back = h("button", { type: "button", class: "link" }, "Use the form fields");
    back.addEventListener("click", () => {
      if (edit.readBoxLabel(this.raw, this.vocab)) {
        this.load(this.raw);
        this.render();
      } else {
        alert("The form fields cannot hold this label exactly (other HTML, or IDs inside text lines). Keep editing it as text.");
      }
    });
    this.content.replaceChildren(
      field("Label as written in the diagram", area,
            "The form fields cannot hold this label exactly, so it is shown as written. Use <br> for a new line."),
      back);
  }

  /** A box: one alignment ID, written right after the name, and free text lines. */
  private renderBox() {
    const at = this.rows.findIndex((r) => "curie" in r);
    const entry = at >= 0 ? this.rows[at] as Entry : null;
    const textLines = () => this.rows.filter((r): r is { text: string } => "text" in r);

    const picker = new TermPicker({
      kinds: CLASS_KINDS, placeholder: entry ? "Change: search classes by label or ID" : "Search classes by label or ID",
      search: this.host.search,
      onPick: (term) => {
        const picked: Entry = { code: entry?.code ?? "", curie: term.id!, label: term.label };
        if (at >= 0) this.rows[at] = picked;
        else this.rows.unshift(picked);
        this.render();
      },
    });

    const alignment = h("div", { class: "alignment" });
    if (entry) {
      const written = h("input", { type: "text", value: entry.label, "aria-label": "Text next to the ID" });
      written.addEventListener("input", () => (entry.label = written.value.trim()));
      const remove = h("button", { type: "button", class: "link" }, "Remove");
      remove.addEventListener("click", () => {
        this.rows.splice(at, 1);
        this.render();
      });
      alignment.append(
        h("div", { class: "current-term" }, h("span", { class: "term-id" }, entry.curie),
          termStatus(this.host, entry.curie, CLASS_KINDS), remove),
        field("Text next to the ID", written, "The ontology label, so the label check passes."));
    }
    alignment.append(picker.el);

    const area = autoGrow(h("textarea", { rows: 3, placeholder: "e.g. walltime, n_cores, job_id" }), 3);
    area.value = textLines().map((l) => l.text).join("\n");
    area.addEventListener("input", () => {
      const texts = area.value === "" ? [] : area.value.split("\n").map((t) => ({ text: t.trim() }));
      const current = this.rows.findIndex((r) => "curie" in r);
      const kept = current >= 0 ? this.rows[current]! : null;
      this.rows = texts;
      if (kept) this.rows.splice(Math.min(current, texts.length), 0, kept);
    });

    this.content.replaceChildren(
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Ontology alignment"), alignment),
      field("Other lines", area, "One line per line in the box. Blank lines are kept."),
      this.toRaw());
  }

  /** A vocabulary: lines of `code: ID label`, and text lines, in order. */
  private renderVocab() {
    const list = h("ol", { class: "rows" });
    const move = (i: number, step: number) => {
      const j = i + step;
      if (j < 0 || j >= this.rows.length) return;
      [this.rows[i], this.rows[j]] = [this.rows[j]!, this.rows[i]!];
      this.render();
    };
    this.rows.forEach((row, i) => {
      const controls = [["↑", -1], ["↓", 1]].map(([sym, step]) => {
        const b = h("button", { type: "button", class: "icon", "aria-label": step === -1 ? "Move up" : "Move down" }, String(sym));
        b.addEventListener("click", () => move(i, Number(step)));
        return b;
      });
      const del = h("button", { type: "button", class: "icon", "aria-label": "Remove line" }, "×");
      del.addEventListener("click", () => {
        this.rows.splice(i, 1);
        this.render();
      });
      if ("curie" in row) {
        const code = h("input", { type: "text", value: row.code, placeholder: "code", class: "code mono", "aria-label": "Code" });
        code.addEventListener("input", () => (row.code = code.value.trim()));
        const written = h("input", { type: "text", value: row.label, "aria-label": "Term label" });
        written.addEventListener("input", () => (row.label = written.value.trim()));
        list.append(h("li", { class: "row entry" },
          h("div", { class: "row-main" }, code, h("span", { class: "term-id" }, row.curie), written, ...controls, del),
          h("div", { class: "row-sub" }, "Ontology: ", termStatus(this.host, row.curie, CLASS_KINDS))));
      } else {
        const t = h("input", { type: "text", value: row.text, placeholder: "text line (empty for a gap)", "aria-label": "Text line" });
        t.addEventListener("input", () => (row.text = t.value.trim()));
        list.append(h("li", { class: "row text" }, h("div", { class: "row-main" }, t, ...controls, del)));
      }
    });
    const picker = new TermPicker({
      kinds: CLASS_KINDS, placeholder: "Add a term: search classes by label or ID", search: this.host.search,
      onPick: (term) => {
        this.rows.push({ code: "", curie: term.id!, label: term.label });
        this.render();
      },
    });
    const addText = h("button", { type: "button", class: "link" }, "+ Text line");
    addText.addEventListener("click", () => {
      this.rows.push({ text: "" });
      this.render();
    });
    this.content.replaceChildren(
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Vocabulary entries"),
        list, picker.el, addText,
        h("span", { class: "hint" }, "Each term is written as `code: ID label`, e.g. MC: PMD_0000862 Monte Carlo simulation.")),
      this.toRaw());
  }

  private renderParents() {
    const d = this.host.diagram();
    const self = this.info?.id;
    const chips = this.parents.map((p) => {
      const node = d.nodes.get(p);
      const x = button("x", `Remove parent ${p}`, { class: "chip-x" }, true);
      x.addEventListener("click", () => {
        this.parents = this.parents.filter((q) => q !== p);
        this.renderParents();
      });
      return h("span", { class: "chip parent" }, node ? nodeTitle(node) : p, x);
    });
    const add = h("select", { "aria-label": "Add a parent" });
    this.panel.ui.nodeOptions(add, [...this.parents, ...(self ? [self] : [])]);
    add.options[0]!.textContent = "+ Add a parent…";
    add.addEventListener("change", () => {
      if (add.value) this.parents.push(add.value);
      this.renderParents();
    });
    this.parentsBox.replaceChildren(...chips, add);
  }

  private submit(error: HTMLElement) {
    const id = this.idInput.value.trim();
    if (this.mode === "fields" && !this.name.trim()) {
      error.textContent = "Give the box a name.";
      error.hidden = false;
      return;
    }
    const spec: edit.BoxSpec = { id, label: this.label(), kind: this.kind, parents: this.parents };
    const original = this.info?.id ?? null;
    this.panel.ui.save(error, () => {
      if (!id) throw new edit.EditError("Give the box an id.");
      if (original === null) return edit.addBox(this.host.text(), spec, this.config);
      if (!edit.boxInfo(this.host.text(), original, this.config)) {
        throw new edit.EditError(`The box '${original}' is no longer in the diagram.`);
      }
      return edit.updateBox(this.host.text(), original, spec, this.config);
    }, () => this.host.select({ nodeId: id }));
  }

  private remove() {
    const id = this.info!.id;
    const removal = edit.removeBox(this.host.text(), id);
    const lines = removal.lines.map((l) => `  line ${l.number}${l.removed ? "" : " (only the id is removed)"}: ${short(l.text)}`);
    if (!confirm(`Delete box '${id}'? This changes these lines:\n\n${lines.join("\n")}`)) return;
    this.host.apply(removal.changes);
    this.panel.ui.close();
  }
}

// ---- arrow form --------------------------------------------------------------------------------

class ArrowForm {
  private kind: Edge["kind"];
  private mode: "fields" | "raw" = "fields";
  private fields: edit.ArrowFields = { name: "", curie: "", lines: [] };
  private raw = "";
  private readonly ends = h("div", { class: "ends" });
  private readonly relation = h("section", { class: "form-section relation" });
  private readonly srcSelect = h("select", { "aria-label": "From" });
  private readonly dstSelect = h("select", { "aria-label": "To" });

  constructor(private readonly panel: FormsPanel, private readonly host: FormsHost, private readonly config: Config,
              private readonly index: number | null, private readonly edge: Edge | null, from: string) {
    this.kind = edge?.kind ?? "relation";
    this.load(edge?.label ?? "");
    panel.ui.nodeOptions(this.srcSelect, [], edge?.src ?? from);
    panel.ui.nodeOptions(this.dstSelect, [], edge?.dst ?? "");

    const kindRadios = h("div", { class: "segmented", role: "radiogroup", "aria-label": "Arrow type" });
    for (const [value, text] of [["relation", "Relation · dotted"], ["inherit", "Inheritance · solid"]] as const) {
      const radio = h("input", { type: "radio", name: "arrow-kind", value, checked: this.kind === value });
      radio.addEventListener("change", () => {
        this.kind = value;
        this.render();
      });
      kindRadios.append(h("label", {}, radio, h("span", {}, text)));
    }

    const actions: HTMLElement[] = [h("button", { type: "submit", class: "primary" }, edge ? "Save" : "Add arrow")];
    const cancel = h("button", { type: "button", class: "ghost" }, "Cancel");
    cancel.addEventListener("click", () => panel.ui.close());
    actions.push(cancel, h("span", { class: "grow" }));
    if (edge) {
      const show = button("code", `Show in text (line ${edge.line})`, { class: "ghost" }, true);
      show.addEventListener("click", () => host.showLine(edge.line));
      const remove = button("trash", "Delete arrow", { class: "ghost danger" }, true);
      remove.addEventListener("click", () => this.remove());
      actions.push(show, remove);
    }

    const d = host.diagram();
    const title = edge ? `${nodeTitle(d.nodes.get(edge.src)!)} → ${nodeTitle(d.nodes.get(edge.dst)!)}` : "New arrow";
    const { form, error } = panel.ui.shell(title,
      [section("Type", kindRadios), section("Boxes", this.ends), this.relation], actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit(error);
    });
    this.render();
    panel.ui.show(form);
  }

  private load(label: string) {
    const fields = edit.readArrowLabel(label);
    if (fields) {
      this.mode = "fields";
      this.fields = fields;
    } else {
      this.mode = "raw";
      this.raw = label;
    }
  }

  private label(): string {
    return this.mode === "raw" ? this.raw : edit.writeArrowLabel(this.fields);
  }

  private render() {
    const parentFirst = this.config.inheritDirection === "parent-child";
    const [srcName, dstName] = this.kind === "inherit" ? (parentFirst ? ["Parent", "Child"] : ["Child", "Parent"])
      : ["From", "To"];
    this.ends.replaceChildren(field(srcName, this.srcSelect), field(dstName, this.dstSelect));
    this.relation.hidden = this.kind === "inherit";
    if (this.kind === "inherit") return;
    if (this.mode === "raw") this.renderRaw();
    else this.renderFields();
  }

  private renderRaw() {
    const area = h("textarea", { rows: 3, spellcheck: false, class: "mono" });
    area.value = this.raw;
    area.addEventListener("input", () => (this.raw = area.value));
    this.relation.replaceChildren(h("h4", {}, "Relation"), field("Label as written in the diagram", area,
      "The form fields cannot hold this label exactly, so it is shown as written. Use <br> for a new line."));
  }

  private renderFields() {
    const f = this.fields;
    const name = h("input", { type: "text", value: f.name, placeholder: "e.g. has specified input" });
    name.addEventListener("input", () => (f.name = name.value.trim()));
    const picker = new TermPicker({
      kinds: PROPERTY_KINDS, placeholder: "Search object properties by label or ID", search: this.host.search,
      onPick: (term) => {
        f.curie = term.id!;
        f.name = term.label;
        this.render();
      },
    });
    const id = h("div", { class: "alignment" });
    if (f.curie) {
      const remove = h("button", { type: "button", class: "link" }, "Remove ID");
      remove.addEventListener("click", () => {
        f.curie = "";
        this.render();
      });
      id.append(h("div", { class: "current-term" }, h("span", { class: "term-id" }, f.curie),
        termStatus(this.host, f.curie, PROPERTY_KINDS), remove));
    }
    id.append(picker.el);
    const more = autoGrow(h("textarea", { rows: 2, placeholder: "e.g. input system" }), 2);
    more.value = f.lines.join("\n");
    more.addEventListener("input", () => {
      f.lines = more.value === "" ? [] : more.value.split("\n").map((t) => t.trim()).filter((t) => t);
    });
    const raw = h("button", { type: "button", class: "link" }, "Edit the whole label as text");
    raw.addEventListener("click", () => {
      this.raw = this.label();
      this.mode = "raw";
      this.render();
    });
    this.relation.replaceChildren(
      h("h4", {}, "Relation"),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Ontology property"), id,
        h("span", { class: "hint" }, "Optional. Without an ID the arrow is a plain field, like calculation_type.")),
      field("Relation name", name, "Written above the ID; the property's label, so the label check passes."),
      field("Other lines", more),
      raw);
  }

  private submit(error: HTMLElement) {
    const spec: edit.ArrowSpec = { src: this.srcSelect.value, dst: this.dstSelect.value, kind: this.kind,
                                   label: this.kind === "inherit" ? "" : this.label() };
    this.panel.ui.save(error, () => {
      if (!spec.src || !spec.dst) throw new edit.EditError("Choose the boxes at both ends.");
      const text = this.host.text();
      if (this.index === null) return edit.addArrow(text, spec);
      const now = this.host.diagram().edges[this.index];
      const e = this.edge!;
      if (!now || now.src !== e.src || now.dst !== e.dst || now.label !== e.label || now.kind !== e.kind) {
        throw new edit.EditError("The diagram changed since this arrow was opened. Close the form and open the arrow again.");
      }
      return edit.updateArrow(text, this.index, spec);
    }, () => {
      const d = this.host.diagram();
      const index = this.index ?? d.edges.length - 1;
      this.host.select({ edgeIndex: index });
    });
  }

  private remove() {
    const e = this.edge!;
    const line = this.host.text().split("\n")[e.line - 1]?.trim() ?? "";
    if (!confirm(`Delete this arrow?\n\n  line ${e.line}: ${short(line)}`)) return;
    this.host.apply(edit.removeArrow(this.host.text(), this.index!));
    this.panel.ui.close();
  }
}
