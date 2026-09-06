---
name: project-verify-plan
description: Use when you have an implementation plan or design in hand and want to audit it BEFORE writing code - a risk-coverage review that checks the plan names the non-obvious traps its stack will actually hit, matches the requirement's scope, covers the edge and safety cases, and stays minimal. The cheapest place to catch a design error, since a flawed plan built perfectly is still wrong. Pairs with writing-plans (which creates the plan) and precedes project-verify-code (which reviews the built code). Trigger on review this plan, is this design sound, does the plan miss anything, before I build.
---

# Verify Plan - a risk-coverage audit of a plan before you build

A plan built perfectly is still wrong if the plan was wrong - the design carries the quality: a build handles the traps its plan names and ships the ones it misses, and catching the miss here on the page is cheaper than any downstream gate (the code, the tests, project-verify-code). This reviews an EXISTING plan or design (yours, or one `superpowers:writing-plans` produced) for the defects that are expensive to discover later. It does not write or fix code; it flags gaps in the plan and hands them back.

## Audit mode - this chat or the verifier seat

Audit inline in this chat, the four passes below. On an agents request, dispatch the plan's stack `<stack>-verifier` seat to run the same four passes over the plan file - on its frontmatter model unless you name one - and take its punch-list. There is no dedicated plan-auditor seat; the verifier seat runs the audit. Only one seat, no fan-out; dispatch nothing you were not asked to. When the invocation names no mode and no calling flow has already recorded one, ask ONE question before auditing, via AskUserQuestion - this chat, or the verifier seat? - and hold the answer; a mode the run already picked is inherited, never re-asked - with ONE boundary: the cross-task orchestrator's plan gate always runs the four passes in-session whatever the run mode, because the plan is already in that session's context and its protocol says so (`project-solve-cross-task` and its trio protocol own that call; the inherited-mode dispatch applies to this skill's own single-chat chain).

## When to use / not

- Use it the moment a plan exists and before implementation starts - especially for anything with a boundary, state, auth, migration, or concurrency surface. The plan file is the whole input: a fresh session (or a different model) audits it as well as the chat that designed it - and independent eyes on the page are the point.
- Not code review - that is `project-verify-code`, after the build.
- Not plan *creation* - that is `superpowers:writing-plans` / `superpowers:brainstorming`. This audits a plan that already exists.

## The audit - five passes, in order

Load the plan's target stack skill FIRST, so you check against the right trap list, not a generic one.

1. **Risk coverage - the highest-leverage pass.** Check the plan's `Oriented:` header line first (`project-solution-design` writes it - what oriented the design, which house skills it loaded): a plan missing the line, or naming no house skill with no reason, is itself a MAJOR finding - the design ran blind. Check the CLAIM, not just the field: the line must cite its evidence (the doc range read, the symbol calls made), and where the audit runs in the same session the cited reads must actually exist in it - a filled-in header over reads that never happened passed this gate verbatim while zero orientation occurred (measured: 'ARCHITECTURE.md plus a bounded symbol pass over six surfaces' with no read of the doc anywhere in the session and one symbol call against six claimed). An unevidenced `Oriented:` line is the SAME MAJOR finding as a missing one. Stamp what you verified into the gate line: `Oriented: verified` or `Oriented: MISSING/unevidenced`, so a later scoped re-audit cannot silently inherit the gap (measured: two gate passes over one plan, neither flagged the absent header). Then: does the plan NAME the non-obvious failure modes this feature will hit? Do not carry a generic checklist - load the stack's house skill (the same one your project's convention rules auto-attach for its file types; its router names the specialist siblings) and check the plan against ITS trap list: the data-access, lifecycle, concurrency, and boundary traps that stack actually has. A trap the plan does not name is a trap the build inherits - flag each missing one and where in the plan it belongs.
2. **Scope match.** The plan covers exactly what was asked - nothing missing, nothing speculative added. A step for a requirement that is not there, or a missing step for one that is, is a finding.
3. **Existence.** Every thing the plan NAMES is checked to exist before the plan passes: a symbol,
   a file, a config key, a CSS or design token, an API the plan calls, a package version floor, a
   capability it assumes a tool or seat has. Check it - `find_symbol`, a read of the config, a
   context7 lookup for the external ones - and mark anything you could not confirm `unverified` in
   the finding, never in the plan's prose as fact. This pass exists because asserted existence is
   the most expensive defect class in the corpus: an invented CSS token plus two wrong test
   predictions cost 2,663,771 tokens to repair, and a false capability claim propagated through a
   DURABLE doc over six escalating hops (790,759 tokens of recovery) after being certified twice by
   a report that never checked it.
4. **Edges + safety.** Boundary, empty, and error cases are named, not assumed. Any auth / migration-order / data-loss / concurrency surface is called out WITH its safeguard. Silence on a safety-critical edge is a finding.
5. **Soundness.** The approach matches the repo's existing architecture (match it, never introduce a second), dependencies are ordered, and it is the smallest plan that meets the requirement - and its seams pass the design rules `project-solution-design` decides against: a task boundary that splits one axis of change across two tasks, an interface with one implementation and no credible second, a pattern with no trigger yet in the code, a task whose failure exits name no `log_points` (a silent failure designed in) - each a finding against the PLAN, with the breakage named, never a letter of SOLID alone.

## Output

**Six named fields, every run, each with a value** - a controlled measurement put named fields at
5 of 5 emitted against a prose condition at 0 of 1, so anything that must happen every time is a
field, not a sentence about when to write one:

```
Oriented:  verified | MISSING/unevidenced
Decisions: <N entries, each with its precedent> | ABSENT
Scope:     matches | <what is missing or speculative>
Existence: <N names checked, N unverified> | nothing named
Findings:  <count by severity, or `none`>
Gated:     passed | <N> gaps listed - <date>
```

`Decisions:` is a PASS CONDITION, not a note: a plan whose `## Decisions` ledger is absent is a
finding in its own right, because the build seats read that ledger for the precedents they must
build to (measured: 0 occurrences of the ledger in a plan that was then stamped `Gated: passed`).

Then the body: a short punch-list, not a rewrite. One line per finding: `severity | the gap | the fix to the PLAN` - and a finding that is a tradeoff or preference rather than an objective defect carries the extra tag `judgment`: the applier puts each judgment item through its own AskUserQuestion instead of folding it into a blanket 'fix all' approval (measured: an unmarked transport-channel switch rode a blanket 'go ahead', landed, and was reverted on a live user interrupt - 32% of that apply phase's edits spent applying-then-reversing it). If the plan is sound, say so plainly and name what you checked. When the plan lives in a file (`<docs-path>/superpowers/plans/` - `project-solution-design` writes it there), stamp the verdict into it - one line, `Gated: passed | <N> gaps listed - <date>` - so a compacted or fresh session knows the audit already happened. When the findings are then applied to the plan, land them in as few Edit calls as possible - one per task section, never one per line (measured: 28 single-hunk edits to one plan file in one apply pass, each at full session context). Then it is safe to build against; if not, fix the plan first - that is the whole point of doing this before code.

## Example

Auditing the `project-solution-design` export plan ('add data export to the records list' - three tasks: a query projection, a streamed export endpoint, an integration test), one finding per pass:

```text
1 risk      | MAJOR | no task names cancellation on the streamed export - a client abort leaks the open reader | thread the stack's cancellation mechanism through Tasks 1-2 (its skill's trap list)
2 scope     | MINOR | Task 2 adds an export-format option the requirement never asked for | drop it
3 edges     | MAJOR | empty result set unspecified - header-only output or an error?    | name the expected shape in Task 2; assert it in Task 3
4 soundness | pass  | extends the existing query seam, tasks in dependency order, smallest plan
```

Verdict: fix the plan (2 MAJOR), re-check the two lines, then build.
