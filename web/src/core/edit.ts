/**
 * Small edits to the diagram text, for the form editor.
 *
 * The Mermaid text is the only copy of the diagram. The functions here take the text and
 * return changes to it ({from, to, insert}, offsets into the original text, sorted and not
 * overlapping), so the page can apply them as one editor transaction. They only touch the
 * lines, or the parts of lines, that the edit is about: comments, blank lines, indentation,
 * styling and other boxes stay byte for byte as they were.
 *
 * Lines are found with the parser's own matchers, so an edit sees the diagram exactly as
 * the checks do.
 */

import * as labels from "./labels.js";
import { isSkipped, matchClassStatement, matchEdge, matchNode, stripFrontmatter, type ClassMatch,
         type EdgeMatch, type NodeMatch, type Span } from "./mermaid.js";
import type { Config } from "./model.js";
import { S, htmlUnescape, lineSpans, lstrip, splitlines, strip } from "./py.js";

export interface Change {
  from: number;
  to: number;
  insert: string;
}

export class EditError extends Error {}

/** Apply changes (sorted, not overlapping, as returned here) to the text they were made for. */
export function applyChanges(text: string, changes: Change[]): string {
  let out = "";
  let at = 0;
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + text.slice(at);
}

// ---- reading the text ----------------------------------------------------------------------

interface Line {
  number: number; // 1-based, as in Node.line and Edge.line
  from: number;
  to: number; // end of the content, before the line break
  next: number; // start of the next line
  offset: number; // where the stripped line starts; matcher spans are relative to it
  indent: string;
  body: string; // the line as the parser sees it (stripped)
}

const STYLE_REF_RE = new RegExp(`^(?:style|click)${S}+([A-Za-z_][\\p{L}\\p{N}_-]*)`, "du");
const HEADER_RE = /^(?:flowchart|graph)(?![\p{L}\p{N}_])/u;
const CLASSDEF_RE = new RegExp(`^classDef${S}+([\\p{L}\\p{N}_,-]+)`, "u");
const DEFAULT_INDENT = "    ";

/** The diagram's lines, sorted into the statements the edits care about. */
class Source {
  readonly lines: Line[];
  readonly defs = new Map<string, { line: Line; m: NodeMatch }[]>();
  readonly edges: { line: Line; m: EdgeMatch }[] = [];
  readonly classes: { line: Line; m: ClassMatch }[] = [];
  readonly styleRefs: { line: Line; id: string; span: Span }[] = [];
  readonly classDefs: { line: Line; names: string[] }[] = [];
  readonly bodyStart: number; // index of the first line after the frontmatter
  header: Line | null = null;
  lastModel: Line | null = null; // last box, arrow or class statement

  constructor(readonly text: string) {
    const spans = lineSpans(text);
    this.bodyStart = stripFrontmatter(splitlines(text));
    this.lines = spans.map(({ from, to, next }, i) => {
      const raw = text.slice(from, to);
      const lead = raw.length - lstrip(raw).length;
      return { number: i + 1, from, to, next, offset: from + lead, indent: raw.slice(0, lead), body: strip(raw) };
    });
    // Same order of tests as mermaid.parse, so the arrows come out in the same order.
    for (const line of this.lines.slice(this.bodyStart)) {
      const body = line.body;
      if (!body) continue;
      if (isSkipped(body)) {
        const ref = STYLE_REF_RE.exec(body);
        if (ref) this.styleRefs.push({ line, id: ref[1]!, span: ref.indices![1]! });
        const def = CLASSDEF_RE.exec(body);
        if (def) this.classDefs.push({ line, names: def[1]!.split(",").filter((n) => n) });
        if (!this.header && HEADER_RE.test(body)) this.header = line;
        continue;
      }
      const cls = matchClassStatement(body);
      if (cls) {
        this.classes.push({ line, m: cls });
        this.lastModel = line;
        continue;
      }
      const edge = matchEdge(body);
      if (edge) {
        this.edges.push({ line, m: edge });
        this.lastModel = line;
        continue;
      }
      const node = matchNode(body);
      if (node) {
        const list = this.defs.get(node.id) ?? [];
        list.push({ line, m: node });
        this.defs.set(node.id, list);
        this.lastModel = line;
      }
    }
  }

  line(number: number): Line {
    return this.lines[number - 1]!;
  }

  /** The definition the parser uses (the last one), if the box has one. */
  def(id: string): { line: Line; m: NodeMatch } | undefined {
    const list = this.defs.get(id);
    return list?.[list.length - 1];
  }

  ids(): Set<string> {
    const ids = new Set(this.defs.keys());
    for (const { m } of this.edges) ids.add(m.src).add(m.dst);
    return ids;
  }

  edge(index: number): { line: Line; m: EdgeMatch } {
    const edge = this.edges[index];
    if (!edge) throw new EditError(`there is no arrow number ${index + 1}`);
    return edge;
  }
}

/** Collects changes against one text and turns them into a sorted, non-overlapping list. */
class Edits {
  private readonly changes: Change[] = [];
  private readonly deleted = new Set<number>();

  constructor(private readonly src: Source) {}

  replace(line: Line, span: Span, insert: string) {
    const from = line.offset + span[0];
    const to = line.offset + span[1];
    if (this.src.text.slice(from, to) !== insert) this.changes.push({ from, to, insert });
  }

  deleteLine(line: Line) {
    this.deleted.add(line.number);
  }

  /** Insert whole lines after `line` (each item one line, without line breaks). */
  insertAfter(line: Line, items: string[]) {
    this.changes.push({ from: line.to, to: line.to, insert: items.map((t) => "\n" + t).join("") });
  }

  insertBefore(line: Line, items: string[]) {
    this.changes.push({ from: line.from, to: line.from, insert: items.map((t) => t + "\n").join("") });
  }

  insertAt(at: number, insert: string) {
    this.changes.push({ from: at, to: at, insert });
  }

  finish(): Change[] {
    const lines = this.src.lines;
    const ranges: Change[] = [];
    const numbers = [...this.deleted].sort((a, b) => a - b);
    for (let i = 0; i < numbers.length;) {
      let j = i;
      while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j++;
      const first = lines[numbers[i]! - 1]!;
      const last = lines[numbers[j]! - 1]!;
      // A run of lines at the very end without a final line break takes the break before it.
      const from = last.next === last.to && first.number > 1 ? lines[first.number - 2]!.to : first.from;
      ranges.push({ from, to: last.next, insert: "" });
      i = j + 1;
    }
    const inDeleted = (pos: number) => ranges.some((r) => r.from <= pos && pos < r.to);
    const kept = this.changes.filter((c) => {
      if (c.from === c.to) {
        if (inDeleted(c.from) && !ranges.some((r) => r.from === c.from)) {
          throw new EditError("internal error: insertion inside a deleted line");
        }
        return true;
      }
      return !inDeleted(c.from);
    });
    // Insertions at the same place are joined in the order they were made.
    const merged: Change[] = [];
    for (const c of kept) {
      const same = c.from === c.to ? merged.find((m) => m.from === c.from && m.to === c.from) : undefined;
      if (same) same.insert += c.insert;
      else merged.push({ ...c });
    }
    const all = [...merged, ...ranges].sort((a, b) => a.from - b.from || (a.to - a.from) - (b.to - b.from));
    for (let i = 1; i < all.length; i++) {
      if (all[i]!.from < all[i - 1]!.to) throw new EditError("internal error: overlapping changes");
    }
    return all;
  }
}

// ---- labels --------------------------------------------------------------------------------

const MERMAID_ENTITY_START_RE = /#(?=[\p{L}\p{N}_]+;)/gu;
const BR = "<br>";

/**
 * Write plain text so that the label parser (`labels.segments`) reads it back unchanged:
 * `<` and, where needed, `&` as HTML entities; `"` and a `#` that would start a Mermaid
 * entity code as Mermaid codes (`#quot;`, `#35;`). `pipe` also writes `|` as `#124;`, for
 * labels between pipes (`-->|label|`).
 */
export function escapeText(text: string, pipe = false): string {
  let out = htmlUnescape(text) === text ? text : text.replace(/&/g, "&amp;");
  out = out.replace(/</g, "&lt;");
  out = out.replace(MERMAID_ENTITY_START_RE, "#35;");
  out = out.replace(/"/g, "#quot;");
  if (pipe) out = out.replace(/\|/g, "#124;");
  return out;
}

/** Make any label text safe to put between the quotes of a box or arrow. */
export function quoteSafe(raw: string): string {
  return raw.replace(/"/g, "#quot;").replace(/\r\n|[\n\r]/g, BR);
}

/** One label part as plain text, or null if it is more than one line once read. */
function readPart(part: string): string | null {
  const segs = labels.segments(part);
  return segs.length === 1 ? segs[0]! : null;
}

/** A line of a box label: plain text, or an ID with the text around it (`MC: PMD_0000862 Monte Carlo`). */
export type LabelLine = { text: string } | { code: string; curie: string; label: string };

export interface BoxFields {
  name: string;
  bold: boolean; // the name is written as <b>name</b>
  lines: LabelLine[];
}

export interface ArrowFields {
  name: string; // the relation as written, e.g. "has specified input" or "calculation_type"
  curie: string; // the property ID, or ""
  lines: string[];
}

function readEntry(text: string): LabelLine | null {
  const m = labels.CURIE_RE.exec(text);
  if (!m) return { text };
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + m[0].length);
  if (labels.CURIE_RE.test(after)) return null;
  let code = "";
  if (before) {
    if (!before.endsWith(": ")) return null;
    code = before.slice(0, -2);
  }
  if (after && !after.startsWith(" ")) return null;
  return { code, curie: m[0], label: after.slice(1) };
}

function writeLine(line: LabelLine): string {
  if ("text" in line) return escapeText(line.text);
  return escapeText((line.code ? `${line.code}: ` : "") + line.curie + (line.label ? ` ${line.label}` : ""));
}

export function writeBoxLabel(fields: BoxFields): string {
  const name = escapeText(fields.name);
  return [fields.bold ? `<b>${name}</b>` : name, ...fields.lines.map(writeLine)].join(BR);
}

/**
 * Read a box label into form fields: a name and lines of text or IDs. Returns null if the
 * fields cannot write the label back exactly (other HTML, an ID inside a text line, more
 * than one ID in a box that is not a vocabulary, ...); the form then edits the raw label.
 */
export function readBoxLabel(raw: string, vocab: boolean): BoxFields | null {
  const parts = raw.split(BR);
  const head = /^<b>(.*)<\/b>$/su.exec(parts[0]!);
  const name = readPart(head ? head[1]! : parts[0]!);
  if (name === null || labels.CURIE_RE.test(name)) return null;
  const lines: LabelLine[] = [];
  for (const part of parts.slice(1)) {
    const text = readPart(part);
    const line = text === null ? null : readEntry(text);
    if (line === null) return null;
    lines.push(line);
  }
  if (!vocab && lines.filter((l) => "curie" in l).length > 1) return null;
  const fields = { name, bold: head !== null, lines };
  return writeBoxLabel(fields) === raw ? fields : null;
}

export function writeArrowLabel(fields: ArrowFields): string {
  const parts = [fields.name, fields.curie, ...fields.lines].filter((p) => p !== "");
  return parts.map((p) => escapeText(p)).join(BR);
}

/** Read an arrow label: `name<br>ID<br>more lines`, or null if it does not fit that. */
export function readArrowLabel(raw: string): ArrowFields | null {
  const texts: string[] = [];
  for (const part of raw === "" ? [] : raw.split(BR)) {
    const text = readPart(part);
    if (text === null) return null;
    texts.push(text);
  }
  const bare = (t: string | undefined) => t !== undefined && labels.CURIE_RE.exec(t)?.[0] === t;
  const name = texts[0] !== undefined && !bare(texts[0]) ? texts.shift()! : "";
  const curie = bare(texts[0]) ? texts.shift()! : "";
  if ([name, ...texts].some((t) => labels.CURIE_RE.test(t))) return null;
  const fields = { name, curie, lines: texts };
  return writeArrowLabel(fields) === raw ? fields : null;
}

// ---- node ids ------------------------------------------------------------------------------

const ID_RE = /^[A-Za-z_][\p{L}\p{N}_-]*$/u;
// Words Mermaid reads as keywords, so they cannot be box ids.
const RESERVED = new Set(["end", "graph", "flowchart", "subgraph", "style", "linkstyle", "classdef", "class",
                          "click", "call", "href", "direction", "default", "interpolate", "acctitle", "accdescr"]);

export function isValidId(id: string): boolean {
  return ID_RE.test(id) && !RESERVED.has(id.toLowerCase());
}

/** A box id made from its name ("simulated system" -> "SimulatedSystem"), not yet used in the text. */
export function newNodeId(name: string, text: string): string {
  const words = name.normalize("NFKD").replace(/\p{M}/gu, "").split(/[^A-Za-z0-9]+/).filter((w) => w);
  let base = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("") || "Box";
  if (/^[0-9]/.test(base)) base = `N${base}`;
  if (RESERVED.has(base.toLowerCase())) base += "Box";
  const taken = new Source(text).ids();
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
  return id;
}

// ---- reading boxes and arrows for the forms ------------------------------------------------

export interface BoxInfo {
  id: string;
  label: string; // raw, as between the quotes
  kind: string | null; // the inline style class (`:::local`)
  // Style classes set elsewhere (class statements, `A:::x --> B`); the form cannot change these.
  otherClasses: string[];
  parents: string[];
  line: number | null; // the definition line, or null if the box only appears in arrows
}

function isChild(m: EdgeMatch, id: string, config: Config): boolean {
  return m.kind === "inherit" && (config.inheritDirection === "parent-child" ? m.dst : m.src) === id;
}

function parentOf(m: EdgeMatch, config: Config): string {
  return config.inheritDirection === "parent-child" ? m.src : m.dst;
}

function parentsIn(src: Source, id: string, config: Config): string[] {
  const out: string[] = [];
  for (const { m } of src.edges) {
    if (isChild(m, id, config) && !out.includes(parentOf(m, config))) out.push(parentOf(m, config));
  }
  return out;
}

export function boxInfo(text: string, id: string, config: Config): BoxInfo | null {
  const src = new Source(text);
  if (!src.ids().has(id)) return null;
  const def = src.def(id);
  const other = new Set<string>();
  for (const { m } of src.classes) if (m.ids.some((x) => x.id === id)) other.add(m.css);
  for (const { m } of src.edges) {
    if (m.src === id && m.srcCss) other.add(m.srcCss);
    if (m.dst === id && m.dstCss) other.add(m.dstCss);
  }
  return {
    id,
    label: def ? def.m.label : id,
    kind: def?.m.css ?? null,
    otherClasses: [...other],
    parents: parentsIn(src, id, config),
    line: def ? def.line.number : null,
  };
}

/** The style classes defined with `classDef`, in order. */
export function styleClasses(text: string): string[] {
  const out: string[] = [];
  for (const { names } of new Source(text).classDefs) {
    for (const name of names) if (!out.includes(name)) out.push(name);
  }
  return out;
}

// ---- writing boxes and arrows --------------------------------------------------------------

export interface BoxSpec {
  id: string;
  label: string; // raw label; quotes and line breaks are made safe
  kind: string | null; // inline style class
  parents: string[];
}

export type ArrowKind = "inherit" | "relation";

export interface ArrowSpec {
  src: string;
  dst: string;
  kind: ArrowKind;
  label: string; // raw label; ignored for inheritance arrows
}

function boxLine(id: string, label: string, kind: string | null): string {
  return `${id}["${quoteSafe(label)}"]` + (kind ? `:::${kind}` : "");
}

function inheritLine(parent: string, child: string, config: Config): string {
  return config.inheritDirection === "parent-child" ? `${parent} --> ${child}` : `${child} --> ${parent}`;
}

type Family = "dotted" | "thick" | "solid";

function family(arrow: string): Family {
  return arrow.startsWith("-.") ? "dotted" : arrow.startsWith("=") ? "thick" : "solid";
}

/** The arrow between the two box ids, with spaces around it. */
function connector(kind: ArrowKind, label: string, fam: Family = "dotted"): string {
  if (kind === "inherit") return " --> ";
  const quoted = `"${quoteSafe(label)}"`;
  if (fam === "thick") return label ? ` == ${quoted} ==> ` : " ==> ";
  if (fam === "solid" && label) return ` -- ${quoted} --> `;
  return label ? ` -. ${quoted} .-> ` : " -.-> ";
}

function checkId(id: string, src: Source, except: string | null = null) {
  if (!isValidId(id)) {
    throw new EditError(`'${id}' cannot be a box id: use letters, digits, _ and -, starting with a letter or _`);
  }
  if (id !== except && src.ids().has(id)) throw new EditError(`there is already a box '${id}'`);
}

/** Add whole lines where new model lines go: after the last box, arrow or class statement. */
function insertModelLines(src: Source, edits: Edits, items: string[], blankBefore: boolean) {
  const anchor = src.lastModel;
  if (anchor) {
    edits.insertAfter(anchor, [...(blankBefore ? [""] : []), ...items.map((t) => anchor.indent + t)]);
    return;
  }
  const classDef = src.classDefs[0]?.line;
  if (classDef) {
    edits.insertBefore(classDef, [...items.map((t) => classDef.indent + t), ""]);
  } else if (src.header) {
    edits.insertAfter(src.header, ["", ...items.map((t) => DEFAULT_INDENT + t)]);
  } else {
    const first = src.lines[src.bodyStart];
    const block = ["flowchart TB", ...items.map((t) => DEFAULT_INDENT + t)].map((t) => t + "\n").join("");
    edits.insertAt(first ? first.from : src.text.length,
                   (!first && src.text && !/[\n\r]$/.test(src.text) ? "\n" : "") + block);
  }
}

export function addBox(text: string, spec: BoxSpec, config: Config): Change[] {
  const src = new Source(text);
  checkId(spec.id, src);
  const edits = new Edits(src);
  const parents = spec.parents.filter((p, i) => p !== spec.id && spec.parents.indexOf(p) === i);
  insertModelLines(src, edits, [boxLine(spec.id, spec.label, spec.kind),
                                ...parents.map((p) => inheritLine(p, spec.id, config))], true);
  return edits.finish();
}

function renameEdits(src: Source, edits: Edits, from: string, to: string) {
  for (const { line, m } of src.defs.get(from) ?? []) edits.replace(line, m.idSpan, to);
  for (const { line, m } of src.edges) {
    if (m.src === from) edits.replace(line, m.srcSpan, to);
    if (m.dst === from) edits.replace(line, m.dstSpan, to);
  }
  for (const { line, m } of src.classes) {
    for (const x of m.ids) if (x.id === from) edits.replace(line, x.span, to);
  }
  for (const ref of src.styleRefs) if (ref.id === from) edits.replace(ref.line, ref.span, to);
}

/** Change parents of `id` (written as `newId`): drop inheritance arrows to removed parents,
 * add arrows to new ones after the box's last inheritance arrow (or its definition). */
function parentEdits(src: Source, edits: Edits, id: string, newId: string, parents: string[], config: Config,
                     anchor: Line | null): string[] {
  const wanted = parents.filter((p, i) => p !== id && p !== newId && parents.indexOf(p) === i);
  const current = parentsIn(src, id, config);
  let last = anchor;
  for (const { line, m } of src.edges) {
    if (!isChild(m, id, config)) continue;
    if (wanted.includes(parentOf(m, config))) last = line;
    else edits.deleteLine(line);
  }
  const added = wanted.filter((p) => !current.includes(p)).map((p) => inheritLine(p, newId, config));
  if (added.length && last) edits.insertAfter(last, added.map((t) => last.indent + t));
  return last ? [] : added;
}

/**
 * Change a box: its id (renamed everywhere it is used), label, inline style class and
 * parents. Parts that are unchanged are not touched.
 */
export function updateBox(text: string, id: string, spec: BoxSpec, config: Config): Change[] {
  const src = new Source(text);
  if (!src.ids().has(id)) throw new EditError(`there is no box '${id}'`);
  if (spec.id !== id) {
    checkId(spec.id, src, id);
  }
  const edits = new Edits(src);
  if (spec.id !== id) renameEdits(src, edits, id, spec.id);
  const def = src.def(id);
  if (def) {
    const { line, m } = def;
    if (m.label !== spec.label) edits.replace(line, m.bodySpan, `"${quoteSafe(spec.label)}"`);
    if ((m.css ?? null) !== spec.kind) {
      edits.replace(line, m.cssSpan ?? [m.closeEnd, m.closeEnd], spec.kind ? `:::${spec.kind}` : "");
    }
  }
  const pending = parentEdits(src, edits, id, spec.id, spec.parents, config, def?.line ?? null);
  if (!def) {
    // The box only appears in arrows: write a definition before the first of them.
    const first = src.edges.find(({ m }) => m.src === id || m.dst === id)!.line;
    edits.insertBefore(first, [boxLine(spec.id, spec.label, spec.kind), ...pending].map((t) => first.indent + t));
  }
  return edits.finish();
}

export function setParents(text: string, id: string, parents: string[], config: Config): Change[] {
  const info = boxInfo(text, id, config);
  if (!info) throw new EditError(`there is no box '${id}'`);
  return updateBox(text, id, { id, label: info.label, kind: info.kind, parents }, config);
}

export interface Removal {
  changes: Change[];
  // The lines that are removed or changed, for a confirm dialog.
  lines: { number: number; text: string; removed: boolean }[];
}

/** Remove a box with its definition lines, its arrows and its class and style statements. */
export function removeBox(text: string, id: string): Removal {
  const src = new Source(text);
  if (!src.ids().has(id)) throw new EditError(`there is no box '${id}'`);
  const edits = new Edits(src);
  const touched = new Map<number, boolean>();
  const drop = (line: Line) => {
    edits.deleteLine(line);
    touched.set(line.number, true);
  };
  for (const { line } of src.defs.get(id) ?? []) drop(line);
  for (const { line, m } of src.edges) if (m.src === id || m.dst === id) drop(line);
  for (const ref of src.styleRefs) if (ref.id === id) drop(ref.line);
  for (const { line, m } of src.classes) {
    if (!m.ids.some((x) => x.id === id)) continue;
    if (m.ids.every((x) => x.id === id)) {
      drop(line);
      continue;
    }
    // `class A, B, C x` -> `class A, C x`, keeping the separator as written.
    const list: Span = [m.ids[0]!.span[0], m.ids[m.ids.length - 1]!.span[1]];
    const sep = line.body.slice(m.ids[0]!.span[1], m.ids[1]!.span[0]);
    edits.replace(line, list, m.ids.filter((x) => x.id !== id).map((x) => x.id).join(sep));
    if (!touched.has(line.number)) touched.set(line.number, false);
  }
  return {
    changes: edits.finish(),
    lines: [...touched].sort((a, b) => a[0] - b[0])
      .map(([number, removed]) => ({ number, text: src.line(number).body, removed })),
  };
}

function checkEnds(spec: ArrowSpec) {
  for (const id of [spec.src, spec.dst]) {
    if (!isValidId(id)) throw new EditError(`'${id}' is not a box id`);
  }
}

/** Add an arrow after the last arrow in the text. */
export function addArrow(text: string, spec: ArrowSpec): Change[] {
  checkEnds(spec);
  const src = new Source(text);
  const edits = new Edits(src);
  const line = `${spec.src}${connector(spec.kind, spec.kind === "relation" ? spec.label : "")}${spec.dst}`;
  const lastEdge = src.edges[src.edges.length - 1]?.line;
  if (lastEdge) edits.insertAfter(lastEdge, [lastEdge.indent + line]);
  else insertModelLines(src, edits, [line], true);
  return edits.finish();
}

/** Change an arrow (by its index in Diagram.edges). Unchanged parts are not touched. */
export function updateArrow(text: string, index: number, spec: ArrowSpec): Change[] {
  checkEnds(spec);
  const src = new Source(text);
  const { line, m } = src.edge(index);
  const edits = new Edits(src);
  edits.replace(line, m.srcSpan, spec.src);
  edits.replace(line, m.dstSpan, spec.dst);
  const label = spec.kind === "relation" ? spec.label : "";
  if (spec.kind !== m.kind || label !== m.label) {
    if (spec.kind === m.kind && m.labelSpan && label) {
      edits.replace(line, m.labelSpan, `"${m.pipeLabel ? quoteSafe(label).replace(/\|/g, "#124;") : quoteSafe(label)}"`);
    } else {
      edits.replace(line, m.connectorSpan, connector(spec.kind, label, spec.kind === m.kind ? family(m.arrow) : "dotted"));
    }
  }
  return edits.finish();
}

export function removeArrow(text: string, index: number): Change[] {
  const src = new Source(text);
  const edits = new Edits(src);
  edits.deleteLine(src.edge(index).line);
  return edits.finish();
}

// ---- new diagram ---------------------------------------------------------------------------

/** The style classes of tests/fixtures/simulation-data-model.mmd. */
export const CLASS_DEFS = [
  "classDef base fill:#e5e7eb,stroke:#6b7280,stroke-width:2px,color:#111827",
  "classDef upper fill:#ffffff,stroke:#9ca3af,stroke-width:2px,color:#374151",
  "classDef local fill:#dbeafe,stroke:#1d4ed8,stroke-width:2px,color:#0f172a",
  "classDef section fill:#ecfdf5,stroke:#059669,stroke-dasharray:4 2,color:#0f172a",
  "classDef vocab fill:#f5f3ff,stroke:#7c3aed,color:#0f172a",
  "classDef note fill:#ffffff,stroke:#9ca3af,color:#374151",
];

export const TEMPLATE = [
  "flowchart TB",
  "",
  "%% Boxes: Id[\"<b>Name</b><br>PMD_0000933 simulation process\"]:::local",
  "%% Solid arrows (Parent --> Child) are inheritance, dotted arrows are relations.",
  "",
  ...CLASS_DEFS.map((d) => DEFAULT_INDENT + d),
  "",
].join("\n");
