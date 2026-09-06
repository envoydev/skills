---
description: Trigger patch - a content edit to any .md misses the doc skills' keyword triggers, so this glob routes it.
paths: ["**/*.md"]
---

Authoring or restructuring any .md (README, ADR, runbook) loads the `markdown-style` Skill - its own
keywords only catch explicit lint asks, so a content edit misses it. ADR / Mermaid-diagram / C4 work
also loads `docs-as-code` (same blind spot). Skip one-line tweaks.

**When this rule reaches you it is already too late for the write that triggered it.** A path-scoped
rule attaches ON a file touch, so it can never precede its own trigger - measured 9.9 s AFTER the edit
it governs, and 22 s after another. So: load the skill now, before the NEXT write to that file, and
treat the load as a precondition of the SKILL that owns the deliverable, not of this rule. A run that
works through the shell gets no attach at all until it uses a file tool (measured: 0 attaches over 123
`.md` write targets); `guard-read-whole-file.js` names this rule on the first shell touch instead.

**The generated docs root is NOT governed here.** Every document under `<docs-path>` belongs to the
capture skill that writes it, and that skill's own body states the shape and loads `markdown-style`
itself. Two owners pulling one file in opposite directions is worse than either alone.
