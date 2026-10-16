"""Reading ontology IDs and the text written around them in diagram labels."""

from __future__ import annotations

import html
import re

from .model import OBO_BASE

# Matches OBO-style IDs such as PMD_0000933 or IAO_0000030. The prefix must start with
# an upper-case letter and the number must have 5 to 9 digits, so names like
# MAT_SIM_STRUCTURE or job_id are not picked up.
CURIE_RE = re.compile(r"\b([A-Z][A-Za-z]*)_(\d{5,9})\b")

_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
# Mermaid's own entity codes, e.g. #quot; or #35;
_MERMAID_ENTITY_RE = re.compile(r"#(\w+);")
_MERMAID_NAMED = {"quot": '"', "amp": "&", "lt": "<", "gt": ">", "nbsp": " "}

# A written label may continue after the ontology label with one of these, e.g.
# "is about, optional" still counts as "is about".
_LABEL_CONTINUATION = ",;(:"


def _mermaid_entity(match: re.Match) -> str:
    code = match.group(1)
    if code.isdigit():
        return chr(int(code))
    return _MERMAID_NAMED.get(code, match.group(0))


def segments(raw: str) -> list[str]:
    """Split a label into lines at <br>, strip other HTML tags and unescape entities."""
    text = _MERMAID_ENTITY_RE.sub(_mermaid_entity, raw)
    text = _BR_RE.sub("\n", text)
    text = _TAG_RE.sub("", text)
    text = html.unescape(text)
    return [part.strip() for part in text.split("\n")]


def plain(raw: str) -> str:
    """Label as one line of plain text."""
    return " ".join(s for s in segments(raw) if s)


def title(raw: str, fallback: str) -> str:
    """First non-empty line of a label (usually the bold class name)."""
    for seg in segments(raw):
        if seg:
            return seg
    return fallback


def find_curies(raw: str) -> list[str]:
    """All ontology IDs in a label, in order, without duplicates."""
    seen: list[str] = []
    for seg in segments(raw):
        for m in CURIE_RE.finditer(seg):
            curie = m.group(0)
            if curie not in seen:
                seen.append(curie)
    return seen


def curie_to_iri(curie: str, prefixes: dict[str, str]) -> str:
    prefix, number = curie.split("_", 1)
    base = prefixes.get(prefix)
    if base is not None:
        return base + number
    return f"{OBO_BASE}{prefix}_{number}"


def text_near(raw: str, curie: str) -> tuple[list[str], list[str]]:
    """Text written next to an ID, as (same line, neighbouring lines).

    Same line: the text after and before the ID on its own line. Text before the ID
    that ends with a colon ("MC:", "Local subclass of:") is a code or heading, not a
    label, and is left out.
    Neighbouring lines: the nearest non-empty line before and after it.
    """
    segs = segments(raw)
    same: list[str] = []
    near: list[str] = []
    for i, seg in enumerate(segs):
        if curie not in seg:
            continue
        before, after = seg.split(curie, 1)
        same.append(after)
        if not before.rstrip().endswith(":"):
            same.append(before)
        for j in range(i - 1, -1, -1):
            if segs[j]:
                near.append(segs[j])
                break
        for j in range(i + 1, len(segs)):
            if segs[j]:
                near.append(segs[j])
                break

    def clean(items: list[str]) -> list[str]:
        out: list[str] = []
        for c in items:
            c = c.strip()
            if normalise(c) and c not in out and not CURIE_RE.search(c):
                out.append(c)
        return out

    return clean(same), clean(near)


def normalise(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[\s_]+", " ", text)
    return text.strip(" :;,.-")


def label_matches(ontology_labels: list[str], candidates: list[str]) -> bool:
    """True if any written text equals an ontology label (ignoring case and spacing),
    or starts with it followed by , ; ( or :"""
    for label in ontology_labels:
        lab = normalise(label)
        if not lab:
            continue
        for cand in candidates:
            c = normalise(cand)
            if c == lab:
                return True
            if c.startswith(lab) and len(c) > len(lab):
                nxt = c[len(lab)]
                if nxt in _LABEL_CONTINUATION:
                    return True
    return False
