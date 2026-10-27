/**
 * A small parser for the parts of Mermaid flowcharts that describe a data model.
 *
 * It reads nodes (with their labels and style classes) and arrows. Everything else that
 * Mermaid allows in a flowchart (styling, comments, subgraphs, ...) is recognised and
 * skipped. Lines it does not understand are reported, never silently dropped.
 */

import { WARNING, finding, type Edge, type Finding, type Node } from "./model.js";
import { S, W, W_MEMBERS, lstrip, rstrip, splitlines, strip } from "./py.js";

const WORD = `[${W_MEMBERS}]+`; // Python \w+
const CSS = `[${W_MEMBERS}-]+`; // Python [\w-]+
const ID = `[A-Za-z_][${W_MEMBERS}-]*`;

// Statements that carry no model information.
const SKIP_RE = new RegExp(
  `^(?:%%.*|(?:flowchart|graph)(?:${S}+${WORD})?|classDef${S}.*|style${S}.*|linkStyle${S}.*|click${S}.*` +
  `|subgraph(?!${W}).*|end|direction${S}+${WORD}|accTitle${S}*:.*|accDescr(?!${W}).*)$`,
  "u",
);
const CLASS_STMT_RE = new RegExp(`^class${S}+(${ID}(?:${S}*,${S}*${ID})*)${S}+(${CSS})${S}*;?$`, "du");
const ID_RE_G = new RegExp(ID, "gu");

// Node shapes as [opening, closing] pairs. Longer markers first.
const SHAPES: [string, string][] = [
  ["[[", "]]"], ["[(", ")]"], ["([", "])"], ["((", "))"], ["{{", "}}"],
  ["[/", "/]"], ["[\\", "\\]"], ["[/", "\\]"], ["[\\", "/]"],
  [">", "]"], ["[", "]"], ["(", ")"], ["{", "}"],
];

const EDGE_RE = new RegExp(
  `^(?<src>${ID})(?::::(?<src_css>${CSS}))?${S}*` +
  "(?:" +
    `-\\.${S}*(?<l1>"[^"]*"|[^"]*?)${S}*\\.+->` + //       A -. label .-> B
    `|-\\.+->${S}*(?:\\|(?<l2>[^|]*)\\|)?` + //            A -.-> B  or  A -.->|label| B
    `|==${S}*(?<l3>"[^"]*"|[^"]*?)${S}*=+>` + //          A == label ==> B
    `|=+>${S}*(?:\\|(?<l4>[^|]*)\\|)?` + //               A ==> B   or  A ==>|label| B
    `|--${S}*(?<l5>"[^"]*"|[^"]*?)${S}*-+>` + //          A -- label --> B
    `|-{2,}>${S}*(?:\\|(?<l6>[^|]*)\\|)?` + //            A --> B   or  A -->|label| B
  `)${S}*(?<dst>${ID})(?::::(?<dst_css>${CSS}))?${S}*;?$`,
  "du",
);
const UNDIRECTED_RE = new RegExp(
  `^${ID}${S}*(?:-{3,}|-\\.+-|={3,})${S}*(?:\\|[^|]*\\|)?${S}*${ID}${S}*;?$`, "u");
const NODE_ID_RE = new RegExp(`^(${ID})${S}*`, "u");
const NODE_TAIL_RE = new RegExp(`^(?::::(${CSS}))?$`, "u");
const ARROW_CSS_RE = new RegExp(`^:::${CSS}`, "u");
const INHERIT_ARROW_RE = /^-{2,}>$/u;
const LABEL_GROUPS = ["l1", "l2", "l3", "l4", "l5", "l6"] as const;

export interface Diagram {
  nodes: Map<string, Node>;
  edges: Edge[];
  findings: Finding[];
}

/** [start, end) offsets in a line. */
export type Span = [number, number];

/** A node definition, with where its parts are in the (stripped) line. */
export interface NodeMatch {
  id: string;
  label: string;
  css: string | undefined;
  idSpan: Span;
  bodySpan: Span; // between the shape's brackets, quotes included
  closeEnd: number; // just after the closing bracket
  cssSpan: Span | null; // `:::name`
}

/** An arrow, with where its parts are in the (stripped) line. */
export interface EdgeMatch {
  src: string;
  dst: string;
  kind: Edge["kind"];
  label: string;
  arrow: string;
  srcCss: string | undefined; // `A:::name --> B`
  dstCss: string | undefined;
  srcSpan: Span;
  dstSpan: Span;
  connectorSpan: Span; // between the source (and its :::css) and the target
  labelSpan: Span | null; // the label as written, quotes included
  pipeLabel: boolean; // written as -->|label|
}

/** A `class A,B name` statement. */
export interface ClassMatch {
  ids: { id: string; span: Span }[];
  css: string;
}

function unquote(text: string): string {
  text = strip(text);
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') return text.slice(1, -1);
  return text;
}

/** Leading whitespace (as Python's strip sees it) in UTF-16 code units. */
function leading(text: string): number {
  return text.length - lstrip(text).length;
}

/** True for lines that carry no model information (comments, styles, headers, ...). */
export function isSkipped(line: string): boolean {
  return SKIP_RE.test(line);
}

export function matchClassStatement(line: string): ClassMatch | null {
  const m = CLASS_STMT_RE.exec(line);
  if (!m) return null;
  const start = m.indices![1]![0];
  const ids = [...m[1]!.matchAll(ID_RE_G)].map((im) => ({
    id: im[0], span: [start + im.index, start + im.index + im[0].length] as Span,
  }));
  return { ids, css: m[2]! };
}

export function matchEdge(line: string): EdgeMatch | null {
  const m = EDGE_RE.exec(line);
  if (!m) return null;
  const g = m.groups!;
  const indices = m.indices!.groups!;
  const key = LABEL_GROUPS.find((k) => g[k]);
  const label = unquote(key ? g[key]! : "");
  const arrow = strip(line.slice(indices.src![1], indices.dst![0]));
  const arrowCore = strip(arrow.replace(ARROW_CSS_RE, ""));
  const kind = INHERIT_ARROW_RE.test(arrowCore) ? "inherit" : "relation";
  return {
    src: g.src!, dst: g.dst!, kind, label, arrow: arrowCore, srcCss: g.src_css, dstCss: g.dst_css,
    srcSpan: indices.src!, dstSpan: indices.dst!,
    connectorSpan: [(indices.src_css ?? indices.src!)[1], indices.dst![0]],
    labelSpan: key ? indices[key]! : null,
    pipeLabel: key === "l2" || key === "l4" || key === "l6",
  };
}

export function matchNode(line: string): NodeMatch | null {
  const m = NODE_ID_RE.exec(line);
  if (!m) return null;
  const nodeId = m[1]!;
  const offset = m[0].length;
  const rest = line.slice(offset);
  for (const [opening, closing] of SHAPES) {
    if (!rest.startsWith(opening)) continue;
    const end = rest.lastIndexOf(closing);
    if (end < opening.length) continue;
    const body = rest.slice(opening.length, end);
    const after = rest.slice(end + closing.length);
    const tail = strip(rstrip(strip(after), ";"));
    const tm = NODE_TAIL_RE.exec(tail);
    if (tm === null) continue;
    const closeEnd = offset + end + closing.length;
    const css = tm[1];
    const cssStart = closeEnd + leading(after);
    return {
      id: nodeId, label: unquote(body), css,
      idSpan: [0, nodeId.length],
      bodySpan: [offset + opening.length, offset + end],
      closeEnd,
      cssSpan: css === undefined ? null : [cssStart, cssStart + 3 + css.length],
    };
  }
  return null;
}

/** Return the index of the first line after a YAML frontmatter block (or 0). */
export function stripFrontmatter(lines: string[]): number {
  let i = 0;
  while (i < lines.length && !strip(lines[i]!)) i++;
  if (i < lines.length && strip(lines[i]!) === "---") {
    for (let j = i + 1; j < lines.length; j++) {
      if (strip(lines[j]!) === "---") return j + 1;
    }
  }
  return 0;
}

export function parse(text: string): Diagram {
  const diagram: Diagram = { nodes: new Map(), edges: [], findings: [] };
  const lines = splitlines(text);
  const start = stripFrontmatter(lines);
  const pendingCss: [string[], string, number][] = [];
  const edgeCss: [string, string][] = []; // `A:::cls --> B` styles the node A

  for (let index = start; index < lines.length; index++) {
    const number = index + 1;
    const line = strip(lines[index]!);
    if (!line || isSkipped(line)) continue;

    const stmt = matchClassStatement(line);
    if (stmt) {
      pendingCss.push([stmt.ids.map((x) => x.id), stmt.css, number]);
      continue;
    }

    const edge = matchEdge(line);
    if (edge) {
      const { src, dst, kind, label, arrow } = edge;
      diagram.edges.push({ src, dst, kind, label, line: number, arrow });
      if (edge.srcCss) edgeCss.push([src, edge.srcCss]);
      if (edge.dstCss) edgeCss.push([dst, edge.dstCss]);
      continue;
    }

    const node = matchNode(line);
    if (node) {
      const { id: nodeId, label, css } = node;
      const existing = diagram.nodes.get(nodeId);
      if (existing && existing.defined) {
        diagram.findings.push(finding(
          WARNING, "parse",
          `node '${nodeId}' is defined twice; the later definition (line ${number}) is used`,
          `line ${number}`, "", { nodeId, line: number }));
      }
      diagram.nodes.set(nodeId, { id: nodeId, label, line: number, css: new Set(css ? [css] : []), defined: true });
      continue;
    }

    if (UNDIRECTED_RE.test(line)) {
      diagram.findings.push(finding(
        WARNING, "parse",
        "arrow without a direction is ignored (use --> or -.-> so the meaning is clear)",
        `line ${number}`, line, { line: number }));
      continue;
    }

    diagram.findings.push(finding(
      WARNING, "parse", "line not understood, ignored", `line ${number}`, line, { line: number }));
  }

  for (const [ids, css, number] of pendingCss) {
    for (const nodeId of ids) {
      const node = diagram.nodes.get(nodeId);
      if (node) {
        node.css.add(css);
      } else {
        diagram.findings.push(finding(
          WARNING, "parse", `'class' statement names unknown node '${nodeId}'`,
          `line ${number}`, "", { line: number }));
      }
    }
  }

  diagram.edges.forEach((edge, edgeIndex) => {
    for (const nodeId of [edge.src, edge.dst]) {
      if (!diagram.nodes.has(nodeId)) {
        diagram.nodes.set(nodeId, { id: nodeId, label: nodeId, line: edge.line, css: new Set(), defined: false });
        diagram.findings.push(finding(
          WARNING, "parse",
          `node '${nodeId}' only appears in an arrow and has no label`,
          `line ${edge.line}`, "", { nodeId, edgeIndex, line: edge.line }));
      }
    }
  });
  for (const [nodeId, css] of edgeCss) {
    diagram.nodes.get(nodeId)!.css.add(css);
  }
  return diagram;
}
