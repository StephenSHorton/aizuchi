"""Extract the two backtick-template SYSTEM_PROMPT_* constants from
prompts.ts and write them out as plain-text files. The TS source uses
\\` for inline-code backticks; we strip the backslash so the simulator
tokenizes the actual model-facing string."""

from __future__ import annotations

import os
import re

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SRC = os.path.join(REPO_ROOT, "src", "lib", "aizuchi", "prompts.ts")
DST = os.path.dirname(__file__)

with open(SRC, "r", encoding="utf-8") as f:
    text = f.read()


def extract(name: str) -> str:
    # Find: const NAME = `...`;  where backticks inside `...` are written as \`
    start_marker = f"const {name} = `"
    i = text.index(start_marker) + len(start_marker)
    out = []
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text) and text[i + 1] == "`":
            out.append("`")
            i += 2
            continue
        if ch == "`":
            # closing backtick of the template literal
            return "".join(out)
        out.append(ch)
        i += 1
    raise RuntimeError(f"could not find closing backtick for {name}")


for name, fname in [
    ("SYSTEM_PROMPT_ATTRIBUTION", "system_prompt_attribution.txt"),
    ("SYSTEM_PROMPT_SUBSTANCE", "system_prompt_substance.txt"),
]:
    body = extract(name)
    with open(os.path.join(DST, fname), "w", encoding="utf-8") as f:
        f.write(body)
    print(f"{name}: {len(body)} chars -> {fname}")
