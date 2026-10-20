/**
 * Turning a parsed diagram into OWL: one class per box, and optionally one example
 * instance per box with one link per relation arrow.
 */

import { DataFactory, Writer } from "n3";
import type { NamedNode, Quad, Term } from "@rdfjs/types";

import * as labels from "./labels.js";
import type { Config, Edge, Node } from "./model.js";
import { OWL, RDF, RDFS, type Ontology } from "./ontology.js";

const { namedNode, literal, quad } = DataFactory;

/** The local OWL model plus the mappings the checks need. */
export interface LocalModel {
  quads: Quad[];
  classes: Map<string, NamedNode>; // node id -> local class
  alignments: Map<string, NamedNode>; // node id -> ontology class
  examples: Map<string, NamedNode>; // node id -> example individual
  properties: Map<number, NamedNode>; // edge index -> property
  parents: Map<string, string[]>; // node id -> parent node ids
}

/** Nodes that take part in reasoning (not skipped, not vocabularies). */
export function modelNodes(nodes: Map<string, Node>, config: Config): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const [k, n] of nodes) {
    const excluded = [...n.css].some((c) => config.skipClasses.has(c) || config.vocabClasses.has(c));
    if (!excluded) out.set(k, n);
  }
  return out;
}

/** [child, parent] for an inheritance arrow. */
export function inheritance(edge: Edge, config: Config): [string, string] {
  if (config.inheritDirection === "child-parent") return [edge.src, edge.dst];
  return [edge.dst, edge.src];
}

/** Quads are kept once each, like triples added to an rdflib Graph. */
class QuadSet {
  readonly quads: Quad[] = [];
  private readonly keys = new Set<string>();

  add(s: Term, p: Term, o: Term): void {
    const q = quad(s as NamedNode, p as NamedNode, o as NamedNode);
    const key = `${s.value}\u0000${p.value}\u0000${o.termType}\u0000${o.value}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.quads.push(q);
  }
}

export function build(nodes: Map<string, Node>, edges: Edge[], onto: Ontology, config: Config,
                      withExamples: boolean): LocalModel {
  const g = new QuadSet();
  const ns = (name: string) => namedNode(config.localNs + name);
  g.add(namedNode(config.localNs.replace(/[#/]+$/, "")), RDF.type, OWL.Ontology);
  const model: LocalModel = {
    quads: g.quads, classes: new Map(), alignments: new Map(), examples: new Map(),
    properties: new Map(), parents: new Map(),
  };
  const usable = modelNodes(nodes, config);

  for (const [nodeId, node] of usable) {
    const cls = ns(nodeId);
    model.classes.set(nodeId, cls);
    g.add(cls, RDF.type, OWL.Class);
    g.add(cls, RDFS.label, literal(labels.title(node.label, nodeId)));
    const curies = labels.findCuries(node.label);
    if (curies.length) {
      const target = namedNode(labels.curieToIri(curies[0]!, config.prefixes));
      if (onto.kind(target) === "class") {
        model.alignments.set(nodeId, target);
        // Declare it, so the file means the same thing when parsed on its own.
        g.add(target, RDF.type, OWL.Class);
        g.add(cls, RDFS.subClassOf, target);
      }
    }
  }

  for (const edge of edges) {
    if (edge.kind !== "inherit") continue;
    const [child, parent] = inheritance(edge, config);
    if (usable.has(child) && usable.has(parent)) {
      g.add(ns(child), RDFS.subClassOf, ns(parent));
      const list = model.parents.get(child);
      if (list) list.push(parent);
      else model.parents.set(child, [parent]);
    }
  }

  edges.forEach((edge, index) => {
    if (edge.kind !== "relation") return;
    const curies = labels.findCuries(edge.label);
    if (!curies.length) return;
    const prop = namedNode(labels.curieToIri(curies[0]!, config.prefixes));
    if (onto.kind(prop) === "object property") model.properties.set(index, prop);
  });

  if (withExamples) {
    for (const [nodeId, cls] of model.classes) {
      const ind = ns(`${nodeId}_example`);
      model.examples.set(nodeId, ind);
      g.add(ind, RDF.type, OWL.NamedIndividual);
      g.add(ind, RDF.type, cls);
      g.add(ind, RDFS.label, literal(`${labels.title(nodes.get(nodeId)!.label, nodeId)} (example)`));
    }
    for (const [index, prop] of model.properties) {
      const edge = edges[index]!;
      const src = model.examples.get(edge.src);
      const dst = model.examples.get(edge.dst);
      if (src && dst) {
        // Declare the property explicitly: when OWLAPI parses this file on its
        // own, an undeclared predicate can be read as an annotation property.
        g.add(prop, RDF.type, OWL.ObjectProperty);
        g.add(src, prop, dst);
      }
    }
  }
  return model;
}

/** The ontology class of a node, or of its nearest ancestor in the diagram. */
export function alignedAncestor(nodeId: string, model: LocalModel): NamedNode | null {
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const aligned = model.alignments.get(current);
    if (aligned) return aligned;
    queue.push(...(model.parents.get(current) ?? []));
  }
  return null;
}

/** The local model as Turtle, like the CLI's --emit-owl. */
export function toTurtle(model: LocalModel, config: Config): string {
  const writer = new Writer({
    prefixes: {
      diagram: config.localNs,
      owl: "http://www.w3.org/2002/07/owl#",
      rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      rdfs: "http://www.w3.org/2000/01/rdf-schema#",
    },
  });
  writer.addQuads(model.quads);
  let out = "";
  writer.end((error, result: string) => {
    if (error) throw error;
    out = result;
  });
  return out;
}
