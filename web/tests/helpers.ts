import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ontology } from "../src/core/index.js";

export const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = join(WEB, "..", "tests", "fixtures");
export const GOLDEN = join(WEB, "tests", "golden");

/** PMDco tests are slow and skipped unless PMDCO=1 (like the Python pmdco marker).
 * The file comes from PMDCO_FILE or `npm run fetch-pmdco`. */
export const PMDCO_ENABLED = !!process.env.PMDCO;
export const PMDCO_FILE = process.env.PMDCO_FILE ?? join(WEB, ".cache", "pmdco-full-3.1.1.ttl");

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/** Load an ontology file; `name` is what reports show for it. */
export function loadOntology(path: string, name: string = path): Ontology {
  return Ontology.fromTurtle([{ name, text: readFileSync(path, "utf8") }]);
}

export function loadTiny(): Ontology {
  return loadOntology(join(FIXTURES, "tiny.ttl"));
}
