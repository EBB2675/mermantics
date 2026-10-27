/**
 * Owns the ontology store and runs the checks, so the page never freezes while
 * parsing the ontology or checking a large diagram. Requests are handled one at a time,
 * in the order they arrive.
 */

import { DataFactory } from "n3";

import { checks, defaultConfig, mermaid, Ontology, report } from "../core/index.js";
import { OWL, RDF } from "../core/ontology.js";
import type { OntologyInfo, Request, Response } from "./protocol.js";

let onto: Ontology | null = null;
let queue: Promise<void> = Promise.resolve();

function post(message: Response) {
  self.postMessage(message);
}

const VERSION_INFO = DataFactory.namedNode("http://www.w3.org/2002/07/owl#versionInfo");

function versionOf(o: Ontology): string {
  for (const header of o.store.getSubjects(RDF.type, OWL.Ontology, null)) {
    for (const p of [VERSION_INFO, OWL.versionIRI]) {
      const value = o.store.getObjects(header, p, null)[0];
      if (value) return value.value;
    }
  }
  return "";
}

async function load(request: Extract<Request, { type: "load" }>): Promise<OntologyInfo> {
  const start = performance.now();
  let text = request.text;
  if (text === undefined) {
    const response = await fetch(request.url!);
    if (!response.ok) throw new Error(`could not download ${request.url}: ${response.status} ${response.statusText}`);
    text = await response.text();
  }
  // Only replace the current ontology once the new one has parsed.
  const loaded = Ontology.fromTurtle([{ name: request.name, text }]);
  onto = loaded;
  return { name: request.name, title: request.title, version: versionOf(loaded), triples: loaded.store.size,
           ms: performance.now() - start };
}

function check(request: Extract<Request, { type: "check" }>) {
  if (onto === null) throw new Error("no ontology loaded");
  const start = performance.now();
  const diagram = mermaid.parse(request.text);
  let turtle = "";
  const result = checks.run(diagram, onto, defaultConfig(), null, { emitOwl: (t) => (turtle = t) });
  return {
    result,
    summary: report.summaryLine(result),
    edges: diagram.edges.map(({ src, dst }) => ({ src, dst })),
    nodes: [...diagram.nodes.values()].filter((n) => n.defined).map(({ id, line }) => ({ id, line })),
    markdown: report.toMarkdown(result, request.diagramName),
    json: report.toJson(result, request.diagramName),
    turtle,
    ms: performance.now() - start,
  };
}

async function handle(request: Request) {
  try {
    if (request.type === "load") post({ type: "loaded", id: request.id, ontology: await load(request) });
    else post({ type: "checked", id: request.id, checked: check(request) });
  } catch (exc) {
    post({ type: "error", id: request.id, request: request.type, message: (exc as Error).message });
  }
}

self.onmessage = (event: MessageEvent<Request>) => {
  queue = queue.then(() => handle(event.data));
};
