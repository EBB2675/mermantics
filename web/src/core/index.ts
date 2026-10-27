// The ported checker. Pure TypeScript with no DOM access, so it runs in Node and in the browser.

export * as checks from "./checks.js";
export * as labels from "./labels.js";
export * as mermaid from "./mermaid.js";
export * as owlgen from "./owlgen.js";
export * as report from "./report.js";
export * from "./model.js";
export { Ontology, OntologyError, type OntologySource } from "./ontology.js";
