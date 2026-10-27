// Download PMDco 3.1.1 (pmdco-full.ttl) into web/.cache/ for the PMDco tests and the
// golden files, and copy it to public/ontology/ so the web page can load it.
// Same URL as PMDCO_URL in src/mermantics/ontology.py.
// Usage (from web/): npm run fetch-pmdco (also runs before npm run dev and npm run build)

import { copyFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "3.1.1";
const URL = `https://raw.githubusercontent.com/materialdigital/core-ontology/v${VERSION}/pmdco-full.ttl`;
const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(web, ".cache", `pmdco-full-${VERSION}.ttl`);
const site = join(web, "public", "ontology", `pmdco-full-${VERSION}.ttl`);

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

await mkdir(dirname(site), { recursive: true });
await copyFile(target, site);
console.log(`copied to ${site}`);
