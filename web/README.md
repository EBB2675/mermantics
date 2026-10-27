# mermantics web

The web version of mermantics: the same checks as the Python tool, ported to TypeScript,
running entirely in the browser. It is published at **https://ebb2675.github.io/mermantics/**.

For now it runs the fast checks (IDs, labels, domain and range, vocabularies), the same as
`mermantics --fast`. The reasoner checks (schema and example data) are not ported yet.

## Run it

Needs Node 22.12 or newer.

```bash
cd web
npm install
npm run dev        # http://localhost:5173/
```

`npm run dev` and `npm run build` first download PMDco 3.1.1 into `.cache/` (once) and copy
it to `public/ontology/`, so the page can load it. Neither copy is committed.

## Test

```bash
npm test             # fast tests
PMDCO=1 npm test     # also the tests that load PMDco (from .cache/, or PMDCO_FILE=...)
npm run typecheck
```

The parity tests compare the TypeScript checks with JSON output of the Python CLI, saved in
`tests/golden/`. `npm run golden:fast` makes those files again (it needs the Python package
installed in `web/.venv`, see `scripts/make-golden-fast.sh`).

## Build

```bash
npm run build      # into dist/, for the path /mermantics/
npm run preview    # serve dist/ locally to try the build
```

`dist/` is a plain static site: no server code and no special headers. Pushing to `main`
builds and deploys it with `.github/workflows/pages.yml` (only when `web/`, `assets/` or the
workflow change).

## Layout

| Folder | What is in it |
|---|---|
| `src/core/` | The checker, ported module by module from `src/mermantics/`. Pure TypeScript with no DOM, so it runs in Node (tests) and in the browser. Also `edit.ts` (text edits for the forms) and `terms.ts` (ontology term search). |
| `src/worker/` | A Web Worker that holds the ontology and runs the checks and term searches, so the page never freezes. |
| `src/ui/` | The page: editor, forms, preview and findings. Plain TypeScript, no framework. |
| `examples/` | The example diagrams in the page's Examples menu. |
| `scripts/` | Downloading PMDco and making the golden files. |
| `tests/` | vitest tests. |

The Mermaid text is always the only copy of the diagram: the forms read it and write small
edits back into it.
