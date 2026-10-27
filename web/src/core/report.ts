/** Turning findings into a terminal report, Markdown or JSON. */

import { count, hasErrors, type Result } from "./checks.js";
import { ERROR, LEVELS, NOTE, OK, WARNING, findingAsDict, type Level } from "./model.js";
import { splitlines, textwrapFill } from "./py.js";

const HEADINGS: Record<Level, string> = { [ERROR]: "Errors", [WARNING]: "Warnings", [NOTE]: "Notes", [OK]: "Passed" };

function sorted(result: Result, level: Level) {
  return result.findings.filter((f) => f.level === level);
}

export function summaryLine(result: Result): string {
  const verdict = hasErrors(result) ? "FAILED" : "PASSED";
  return `${verdict}: ${count(result, ERROR)} errors, ${count(result, WARNING)} warnings, ` +
         `${count(result, NOTE)} notes`;
}

export function toText(result: Result, diagramName: string, quiet = false): string {
  const lines = [`Checked ${diagramName}: ${result.info.boxes} boxes, ${result.info.arrows} arrows`];
  const files = result.info.ontology_files;
  if (files.length) lines.push("Ontology: " + files.join(", "));
  lines.push("Reasoner: " + (result.info.reasoner || "not used (fast mode)"));
  for (const level of LEVELS) {
    if (quiet && (level === NOTE || level === OK)) continue;
    const items = sorted(result, level);
    if (!items.length) continue;
    lines.push("");
    lines.push(`${HEADINGS[level]} (${items.length})`);
    for (const f of items) {
      const where = f.where ? `${f.where}: ` : "";
      lines.push(textwrapFill(`[${f.check}] ${where}${f.message}`, 100, "  - ", "    "));
      if (f.details) lines.push(...splitlines(f.details).map((d) => "      " + d));
    }
  }
  lines.push("", summaryLine(result));
  return lines.join("\n");
}

export function toMarkdown(result: Result, diagramName: string): string {
  const lines = [`# Check of \`${diagramName}\``, "", `**${summaryLine(result)}**`, ""];
  lines.push(`- Boxes: ${result.info.boxes}, arrows: ${result.info.arrows}`);
  for (const f of result.info.ontology_files) lines.push(`- Ontology: \`${f}\``);
  lines.push(`- Reasoner: ${result.info.reasoner || "not used (fast mode)"}`);
  for (const level of LEVELS) {
    const items = sorted(result, level);
    if (!items.length) continue;
    lines.push("", `## ${HEADINGS[level]} (${items.length})`, "");
    for (const f of items) {
      const where = f.where ? `${f.where}: ` : "";
      lines.push(`- **${f.check}** ${where}${f.message}`);
      if (f.details) lines.push("", "  ```", ...splitlines(f.details).map((d) => "  " + d), "  ```");
    }
  }
  return lines.join("\n") + "\n";
}

/** The JSON report, byte for byte like Python's json.dumps(data, indent=2). */
export function toJson(result: Result, diagramName: string): string {
  const data = {
    diagram: diagramName,
    passed: !hasErrors(result),
    counts: Object.fromEntries(LEVELS.map((level) => [level, count(result, level)])),
    info: result.info,
    findings: result.findings.map(findingAsDict),
  };
  // Python escapes everything outside printable ASCII (ensure_ascii=True).
  return JSON.stringify(data, null, 2).replace(
    /[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
