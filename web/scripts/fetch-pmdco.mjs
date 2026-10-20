// Download PMDco 3.1.1 (pmdco-full.ttl) into web/.cache/ for the PMDco tests and the
// golden files. Same URL as PMDCO_URL in src/mermantics/ontology.py.
// Usage (from web/): npm run fetch-pmdco

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "3.1.1";
const URL = `https://raw.githubusercontent.com/materialdigital/core-ontology/v${VERSION}/pmdco-full.ttl`;
const target = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", `pmdco-full-${VERSION}.ttl`);

const existing = await stat(target).catch(() => null);
if (existing && existing.size > 0) {
  console.log(`already there: ${target}`);
} else {
  const response = await fetch(URL, { headers: { "User-Agent": "mermantics" } });
  if (!response.ok) throw new Error(`could not download ${URL}: ${response.status} ${response.statusText}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.part`, Buffer.from(await response.arrayBuffer()));
  await rename(`${target}.part`, target);
  console.log(`downloaded ${URL}\n        to ${target}`);
}
