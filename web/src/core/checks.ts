/**
 * The checks, in the order they run.
 *
 * 1. ids          every ontology ID exists, is not deprecated, and is the right kind
 * 2. labels       the text written next to each ID matches the ontology label
 * 3. schema       (reasoner) no box becomes an impossible class
 * 4. domain-range relation arrows fit the property's domain and range
 * 5. vocabulary   vocabulary terms are kinds of the class that uses them
 * 6. data         (reasoner) one example per box, linked by every arrow, is consistent
 *
 * The reasoner checks (3 and 6) are not ported yet; `run` works like the CLI's --fast.
 */

import { DataFactory } from "n3";

import * as labels from "./labels.js";
import type { Diagram } from "./mermaid.js";
import { ERROR, NOTE, OK, WARNING, finding, type Config, type Edge, type Finding, type Location,
         type Node } from "./model.js";
import type { Ontology } from "./ontology.js";
import * as owlgen from "./owlgen.js";
import { sequenceRatio } from "./py.js";

const { namedNode } = DataFactory;

export interface ResultInfo {
  boxes: number;
  arrows: number;
  ontology_files: string[];
  reasoner: string | null;
}

export interface Result {
  findings: Finding[];
  info: ResultInfo;
}

export function count(result: Result, level: string): number {
  return result.findings.filter((f) => f.level === level).length;
}

export function hasErrors(result: Result): boolean {
  return count(result, ERROR) > 0;
}

function nodeWhere(node: Node): string {
  return `box '${labels.title(node.label, node.id)}' (line ${node.line})`;
}

function edgeWhere(edge: Edge): string {
  return `arrow ${edge.src} -> ${edge.dst} (line ${edge.line})`;
}

function nodeLoc(node: Node): Location {
  return { nodeId: node.id, line: node.line };
}

function edgeLoc(edge: Edge, edgeIndex: number): Location {
  return { edgeIndex, line: edge.line };
}

function a(kind: string): string {
  return ("aeiou".includes(kind.slice(0, 1)) ? "an " : "a ") + kind;
}

function closest(candidates: string[], target: string): string {
  let best = candidates[0]!;
  let bestRatio = -1;
  for (const c of candidates) {
    const ratio = sequenceRatio(c.toLowerCase(), target.toLowerCase());
    if (ratio > bestRatio) {
      best = c;
      bestRatio = ratio;
    }
  }
  return best;
}

function hasAny(css: Set<string>, classes: Set<string>): boolean {
  for (const c of css) if (classes.has(c)) return true;
  return false;
}

/** Relation arrows that take part in the checks: not those to or from a skipped box.
 * Yields [edge, edge index]. */
function* checkedRelations(diagram: Diagram, config: Config): Generator<[Edge, number]> {
  for (const [index, edge] of diagram.edges.entries()) {
    if (edge.kind !== "relation") continue;
    if ([edge.src, edge.dst].some((n) => hasAny(diagram.nodes.get(n)!.css, config.skipClasses))) continue;
    yield [edge, index];
  }
}

type Role = "alignment" | "extra" | "vocab-term" | "property";

interface Occurrence {
  where: string;
  raw: string;
  curie: string;
  role: Role;
  loc: Location;
}

/** Every ID in the diagram, with where it is and its role. */
function* occurrences(diagram: Diagram, config: Config): Generator<Occurrence> {
  for (const node of diagram.nodes.values()) {
    if (hasAny(node.css, config.skipClasses)) continue;
    const vocab = hasAny(node.css, config.vocabClasses);
    for (const [i, curie] of labels.findCuries(node.label).entries()) {
      const role: Role = vocab ? "vocab-term" : i === 0 ? "alignment" : "extra";
      yield { where: nodeWhere(node), raw: node.label, curie, role, loc: nodeLoc(node) };
    }
  }
  for (const [edge, index] of checkedRelations(diagram, config)) {
    for (const [i, curie] of labels.findCuries(edge.label).entries()) {
      yield { where: edgeWhere(edge), raw: edge.label, curie, role: i === 0 ? "property" : "extra",
              loc: edgeLoc(edge, index) };
    }
  }
}

// ---- 1. IDs ------------------------------------------------------------------------------

export function checkIds(diagram: Diagram, onto: Ontology, config: Config): Finding[] {
  const out: Finding[] = [];
  let checked = 0;
  const distinct = new Set<string>();
  for (const { where, curie, role, loc } of occurrences(diagram, config)) {
    const iri = namedNode(labels.curieToIri(curie, config.prefixes));
    checked += 1;
    distinct.add(curie);
    if (!onto.exists(iri)) {
      out.push(finding(ERROR, "ids", `${curie} is not in the ontology`, where, iri.value, loc));
      continue;
    }
    const name = onto.label(iri);
    if (onto.deprecated(iri)) {
      out.push(finding(ERROR, "ids", `${curie} '${name}' is deprecated in the ontology`, where, "", loc));
      continue;
    }
    const kind = onto.kind(iri);
    if ((role === "alignment" || role === "vocab-term") && kind !== "class") {
      out.push(finding(ERROR, "ids", `${curie} '${name}' is ${a(kind)}, but a box's ID should be a class`, where, "", loc));
    } else if (role === "property") {
      if (kind === "class") {
        out.push(finding(ERROR, "ids", `${curie} '${name}' is a class, but an arrow's ID should be a property`, where, "", loc));
      } else if (kind !== "object property") {
        out.push(finding(WARNING, "ids", `${curie} '${name}' is ${a(kind)}, not an object property, so this arrow is left out of reasoning`, where, "", loc));
      }
    } else if (role === "extra") {
      out.push(finding(NOTE, "ids", `${curie} '${name}' is not the first ID here, so it is only checked for existence (the first ID is the one used)`, where, "", loc));
    }
  }

  for (const [edge, index] of checkedRelations(diagram, config)) {
    if (!labels.findCuries(edge.label).length) {
      const text = labels.plain(edge.label) || edge.arrow;
      out.push(finding(NOTE, "ids", `arrow has no ontology ID, not checked (${text})`, edgeWhere(edge), "",
                       edgeLoc(edge, index)));
    }
  }
  if (checked && !out.some((f) => f.level === ERROR)) {
    out.push(finding(OK, "ids", `all ${distinct.size} ontology IDs exist and none are deprecated ` +
                                `(${checked} uses in the diagram)`));
  }
  return out;
}

// ---- 2. labels ---------------------------------------------------------------------------

/** A label written on the same line as the ID that does not match is a warning.
 * If only the neighbouring lines are there and none of them match, the label was most
 * likely just not written down; that is a note. */
export function checkLabels(diagram: Diagram, onto: Ontology, config: Config): Finding[] {
  const out: Finding[] = [];
  let matched = 0;
  const seen = new Set<string>();
  for (const { where, raw, curie, loc } of occurrences(diagram, config)) {
    const iri = namedNode(labels.curieToIri(curie, config.prefixes));
    const key = `${where}\u0000${curie}`;
    if (!onto.exists(iri) || seen.has(key)) continue;
    seen.add(key);
    const names = onto.labels(iri);
    const [same, near] = labels.textNear(raw, curie);
    if (!names.length || !(same.length || near.length)) continue;
    if (labels.labelMatches(names, [...same, ...near])) {
      matched += 1;
    } else if (same.length) {
      const shown = closest(same, names[0]!);
      out.push(finding(WARNING, "labels",
                       `text next to ${curie} reads '${shown}', but the ontology calls it '${names[0]}'`, where, "", loc));
    } else {
      out.push(finding(NOTE, "labels",
                       `no label written next to ${curie} (the ontology calls it '${names[0]}')`, where, "", loc));
    }
  }
  if (matched) out.push(finding(OK, "labels", `${matched} labels match the ontology`));
  return out;
}

// ---- 4. domain and range -----------------------------------------------------------------

export function checkDomainRange(diagram: Diagram, model: owlgen.LocalModel, hierarchy: Ontology,
                                 basis: string): Finding[] {
  const out: Finding[] = [];
  let fits = 0;
  let arrows = 0;
  let unconstrained = 0;
  for (const [index, prop] of model.properties) {
    const edge = diagram.edges[index]!;
    if (!model.classes.has(edge.src) || !model.classes.has(edge.dst)) continue;
    const [domains, ranges] = hierarchy.propertyConstraints(prop);
    if (!domains.length && !ranges.length) {
      unconstrained += 1;
      continue;
    }
    arrows += 1;
    const propName = hierarchy.label(prop);
    const reported = new Set<string>();
    const sides = [["subject", edge.src, domains], ["object", edge.dst, ranges]] as const;
    for (const [side, nodeId, constraints] of sides) {
      const node = diagram.nodes.get(nodeId)!;
      const name = labels.title(node.label, nodeId);
      const supers = hierarchy.superclasses(model.classes.get(nodeId)!);
      for (const [expr, source] of constraints) {
        const verdict = hierarchy.satisfied(expr, supers);
        const wanted = hierarchy.describe(expr);
        if (verdict === true) {
          fits += 1;
          continue;
        }
        const key = `${side}\u0000${wanted}`;
        if (reported.has(key)) continue;
        reported.add(key);
        const via = source.equals(prop) ? "" : ` (inherited from '${hierarchy.label(source)}')`;
        if (verdict === false) {
          out.push(finding(
            WARNING, "domain-range",
            `'${propName}' expects its ${side} to be ${wanted}${via}, but '${name}' is not. ` +
            `OWL does not treat this as an error by itself: a reasoner would quietly ` +
            `conclude that '${name}' is one.`,
            edgeWhere(edge), "", edgeLoc(edge, index)));
        } else {
          out.push(finding(NOTE, "domain-range",
                           `could not check whether '${name}' fits ${wanted}${via}`, edgeWhere(edge), "",
                           edgeLoc(edge, index)));
        }
      }
    }
  }
  // "Could not check" notes block the OK too: the message claims that everything fits.
  if (fits && !out.length) {
    const what = arrows === 1 ? "the relation arrow fits its property's"
      : `all ${arrows} relation arrows fit their properties'`;
    out.push(finding(OK, "domain-range", `${what} domains and ranges (${fits} constraints checked, ${basis})`));
  }
  if (unconstrained) {
    const what = unconstrained === 1 ? "1 relation arrow uses a property"
      : `${unconstrained} relation arrows use properties`;
    out.push(finding(NOTE, "domain-range", `${what} without a domain or range, so there was nothing to check`));
  }
  return out;
}

// ---- 5. vocabularies ---------------------------------------------------------------------

function termName(raw: string, curie: string): string {
  for (const seg of labels.segments(raw)) {
    if (seg.includes(curie)) {
      const code = seg.slice(0, seg.indexOf(curie)).replace(/^[ :]+|[ :]+$/g, "");
      return code ? `${code} (${curie})` : curie;
    }
  }
  return curie;
}

export function checkVocabularies(diagram: Diagram, model: owlgen.LocalModel, hierarchy: Ontology,
                                  config: Config): Finding[] {
  const out: Finding[] = [];
  for (const [edge, index] of checkedRelations(diagram, config)) {
    const dst = diagram.nodes.get(edge.dst);
    if (dst === undefined || !hasAny(dst.css, config.vocabClasses)) continue;
    const src = diagram.nodes.get(edge.src)!;
    const srcName = labels.title(src.label, src.id);
    const vocabName = labels.title(dst.label, dst.id);
    const target = owlgen.alignedAncestor(edge.src, model);
    if (target === null) {
      out.push(finding(NOTE, "vocabulary",
                       `cannot check '${vocabName}': '${srcName}' has no ontology alignment`, edgeWhere(edge), "",
                       edgeLoc(edge, index)));
      continue;
    }
    const targetName = hierarchy.label(target);
    let good = 0;
    for (const curie of labels.findCuries(dst.label)) {
      const iri = namedNode(labels.curieToIri(curie, config.prefixes));
      if (!hierarchy.exists(iri)) continue;
      const term = termName(dst.label, curie);
      if (iri.equals(target)) {
        out.push(finding(NOTE, "vocabulary",
                         `${term} in '${vocabName}' is the same class as '${srcName}' itself ` +
                         `('${targetName}'), so it adds no information`, nodeWhere(dst), "", nodeLoc(dst)));
      } else if (hierarchy.superclasses(iri).has(target.value)) {
        good += 1;
      } else {
        out.push(finding(WARNING, "vocabulary",
                         `${term} '${hierarchy.label(iri)}' in '${vocabName}' is not a kind of ` +
                         `'${targetName}', the class of '${srcName}'`, nodeWhere(dst), "", nodeLoc(dst)));
      }
    }
    if (good) {
      const terms = good === 1 ? "1 term" : `${good} terms`;
      const verb = good === 1 ? "is a kind" : "are kinds";
      out.push(finding(OK, "vocabulary", `${terms} in '${vocabName}' ${verb} of '${targetName}'`, "", "",
                       nodeLoc(dst)));
    }
  }
  return out;
}

// ---- everything --------------------------------------------------------------------------

export interface RunOptions {
  /** Receives the generated OWL (classes and example data) as Turtle, like --emit-owl. */
  emitOwl?: (turtle: string) => void;
  progress?: (message: string) => void;
}

/** Run all checks. With `reasoner` null this is the CLI's --fast mode. */
export function run(diagram: Diagram, onto: Ontology, config: Config, reasoner: null,
                    options: RunOptions = {}): Result {
  const progress = options.progress ?? (() => {});
  const findings: Finding[] = [...diagram.findings];
  for (const iri of onto.unresolvedImports()) {
    findings.push(finding(NOTE, "ontology",
                          `the ontology imports ${iri}, which is not loaded, so its terms are missing from these checks`));
  }
  progress("checking IDs and labels");
  findings.push(...checkIds(diagram, onto, config));
  findings.push(...checkLabels(diagram, onto, config));

  const model = owlgen.build(diagram.nodes, diagram.edges, onto, config, true);
  options.emitOwl?.(owlgen.toTurtle(model, config));

  // No reasoner: use the hierarchy as written.
  const basis = "based on the asserted hierarchy, without a reasoner";
  progress("checking domains, ranges and vocabularies");
  onto.withLocalModel(model.quads, (hierarchy) => {
    findings.push(...checkDomainRange(diagram, model, hierarchy, basis));
    findings.push(...checkVocabularies(diagram, model, hierarchy, config));
  });

  return {
    findings,
    info: {
      boxes: owlgen.modelNodes(diagram.nodes, config).size,
      arrows: diagram.edges.length,
      ontology_files: [...onto.files],
      reasoner: reasoner,
    },
  };
}
