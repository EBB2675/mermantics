// The ports of Python standard library behaviour. Expected values come from Python 3.12.

import { expect, test } from "vitest";

import { htmlUnescape, sequenceRatio, splitlines, textwrapFill } from "../src/core/py.js";

test("sequenceRatio is difflib's ratio, including the autojunk rule for long strings", () => {
  expect(sequenceRatio("ab initio md or", "ab initio molecular dynamics simulation")).toBe(0.5185185185185185);
  expect(sequenceRatio("simulation", "molecular dynamics")).toBe(0.35714285714285715);
  expect(sequenceRatio("", "")).toBe(1.0);
  expect(sequenceRatio("x".repeat(250) + "abc", "x".repeat(240) + "abd")).toBe(0.9758064516129032);
});

test("htmlUnescape is html.unescape", () => {
  expect(htmlUnescape("&amp;&lt;&gt;")).toBe("&<>");
  expect(htmlUnescape("&auml;rger &notit; &amp")).toBe("ärger ¬it; &");
  expect(htmlUnescape("&#x41;&#66;&#128;&#0;&#xD800;")).toBe("AB€��");
  expect(htmlUnescape("&unknown; & x")).toBe("&unknown; & x");
});

test("textwrapFill is textwrap.fill, including hyphens, em-dashes and long words", () => {
  const text = "[ids] a well-known self-made thing -- with an em-dash and " +
               "averyveryverylongwordthatdoesnotfitanywhere at all";
  expect(textwrapFill(text, 30, "  - ", "    ")).toBe(
    "  - [ids] a well-known self-\n    made thing -- with an em-\n    dash and averyveryverylong\n" +
    "    wordthatdoesnotfitanywhere\n    at all");
  expect(textwrapFill("short", 30, "  - ", "    ")).toBe("  - short");
});

test("splitlines is str.splitlines", () => {
  expect(splitlines("a\r\nb\rc\x85d e\n")).toEqual(["a", "b", "c", "d", "e"]);
  expect(splitlines("")).toEqual([]);
  expect(splitlines("\n\n")).toEqual(["", ""]);
  expect(splitlines("x")).toEqual(["x"]);
});
