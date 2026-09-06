---
name: project-solution-design
description: Use when you have a feature or change to build in a single chat and want to settle how it fits the existing code before writing any - the single-chat form of the solution-designer seat - orient, judge the fit, decompose into an ordered minimal plan. Trigger on analyse how to integrate this, how does this fit, design this feature, where does this belong, break this into tasks, plan this change. Not for a one-line edit; not the multi-agent flow with its own verifier and fan-out (that is project-solve-cross-task) - in-session it keeps the whole design in your context so you check each step; the run-start ask (or your named mode) decides the designer seat.
---

# Solution Design - how a change fits, then decomposed, in one chat

The design carries the quality: a build handles the traps its plan named and ships the ones it missed. This is the single-chat form of the solution-designer seat - it works out where a feature belongs in the code you already have and breaks it into an ordered plan, all in the current context so you can inspect and correct each step instead of reading a dispatched agent's final report. It plans; it does not write the code (that is the build step under the stack skill) and it does not audit its own plan (that is `project-verify-plan`).

## Design mode - this chat or the designer seat

Design inline in this chat, the method below, so you inspect each step. On an agents request, dispatch the `<stack>-solution-designer` seat instead - on its frontmatter model unless you name one - and take its returned plan; the seat runs this same method, isolated. Only one designer runs, there is no fan-out here. Dispatch nothing you were not asked to. When the invocation names no mode and no calling flow has already recorded one, ask ONE question before designing, via AskUserQuestion - this chat, or the designer seat? - and hold the answer; a mode the run already picked is inherited, never re-asked. Loaded INSIDE a dispatched designer seat, the dispatch IS that answer: run the method below there, no ask and no further dispatch (the seat has neither tool).

## When not

- Not for a change with an obvious single home - just make it.
- Not plan *audit* (`project-verify-plan`) or built-code review (`project-verify-code`) - those come after.

## The method - orient, judge, decompose

1. **Orient from the project docs, don't re-derive them.** Consult `<docs-path>/architecture/ARCHITECTURE.md` SCOPED, never whole: grep it for the modules the task touches plus a listing of `<docs-path>/architecture/references/`, then read the matching section ranges and the linked topic file for the area (measured: the whole-file pull is ~9.6k tokens and the single largest result of its sessions; the grep-plus-listing consult delivered the same orientation for ~1.3k - an 86% cut). Read `<docs-path>/PROJECT-CODE-STYLE.md` for the project's actual code style so the plan's code matches it. Absent those docs, take a bounded pass over the modules involved (directory listing, then `get_symbols_overview` per FILE that matters - it takes one file, never a directory - and never a whole-file read) - map the surface, don't read everything. Either way the `Oriented:` header cites the EVIDENCE - the ranges read, the symbol calls made - not a summary claim: the gate now verifies the citation against the session, and a claimed orientation with no matching reads is a MAJOR finding (measured: one plan's header claimed a full doc read plus a six-surface symbol pass; the session held neither).
2. **Load the house skill for the stack you're in, for its real trap list.** Your project's convention rules auto-attach it the moment you touch a matching file; load it explicitly if you're designing before touching code. Carry the stack's real traps, not a generic checklist, and follow that skill's own routing to its specialist siblings (the stack -> skill map lives in the project's convention rules and router skills, not restated here).
3. **Judge the fit - one verdict, tied to the forcing edge.** Extend an existing seam when the work lands inside a boundary whose dependency arrow already points the right way and that already carries the concern; refactor first when landing it as-is would open a cycle, invert a layer, or overload a shared grab-bag (name the exact edge); isolate a new boundary when it is a genuinely new concern with no existing home. Verify each dependency claim against located code, never a name.
4. **Decompose into an ordered, minimal plan.** Break the work into tasks that each own a clear slice, in dependency order, each naming the files it touches, the stack traps it must handle, the `file:symbol` anchors you located, and its `log_points` (the design rules below). The smallest plan that meets the requirement - nothing speculative added, nothing required left out. Where tasks may build in parallel, give every file two tasks would both edit - the route registry, a root config or DI composition root, a barrel or shared index - exactly one owning task, and forbid the rest from touching it, so concurrent work never collides on a shared file.

## The design rules - decided here, audited later

Three questions on every seam you draw: is this the right TIME for the abstraction, the right PLACE
for the code, and can it lie to a reader or hold a bad state? The plan answers them before an
implementer inherits the answer.

1. **YAGNI + rule of three.** Design the direct solution; the seam goes in at the third occurrence,
   split on what actually varied. An extension point the requirement has not asked for twice is
   indirection someone pays for now for flexibility that usually never arrives - a strategy
   interface with one implementation forever is the classic shape.
2. **High cohesion, low coupling - the placement test.** Everything a task owns changes for the same
   reason. A task boundary that splits one axis of change across two seats, or bundles two axes into
   one, is the wrong boundary - redraw it before the build starts, not after.
3. **Program to an interface at boundaries ONLY.** A seam belongs where one really exists: an
   external system, something the tests mock, something with two implementations or a credible
   second. An interface mirroring every class is ceremony, and a fat interface whose consumers use a
   fraction of it is the same failure from the other side.
4. **Illegal states unrepresentable where cheap, fail fast everywhere else.** Constructor validation,
   required fields, closed hierarchies for domain state, enums over strings; where the type system
   will not help, validate at the boundary and throw. Default to composition - inherit only for true
   substitutability, and a subtype that cannot stand in for its base is a design defect, not an
   implementation detail.
5. **Command-query separation.** A method either mutates or answers, never both.
6. **Least astonishment.** The name is the contract - a seam that does more than its name says means
   fixing one of the two, in the plan, before it ships.
7. **Patterns are refactored TOWARD, never started from.** Where the trigger is already in the code
   (the same change hitting three places, a switch growing per feature, a test that needs half the
   system), name the established pattern rather than inventing a bespoke shape - and absent a
   trigger, the simpler structure wins. A pattern the language absorbed (first-class functions,
   generics, pattern matching) is a keyword now, not a structure to build.

SOLID stays review VOCABULARY - 'this violates Liskov' is a precise, fast comment - never the
justification on a task card: a design decision whose only support is a letter of the acronym, with
no breakage named, has not been argued.

**Observability is designed at the seams, never sprinkled by the implementer.** Stamp each task
card with `log_points` - where a line goes, at what level, carrying which identifiers: the boundary
crossings the task owns (an inbound request, message or job run's start and outcome; an outbound call
to an external system; a persistence write), the decision points a reader would need to reconstruct
the path (a retry, a fallback, a rejected input, a state transition), and every failure exit. Level by
who acts: error means someone acts now, warning means degraded but handled, information means a
business-significant event, debug means investigation only. The message carries the join keys an
investigator needs - the correlation or trace id, the entity id - and never a secret, a token, a
payload, or personal data beyond the project's policy. A failure is logged ONCE, at the boundary that
handles it, never log-and-rethrow at each layer; a background job, a fire-and-forget or a swallowed
catch with no log point is a silent failure, and a design defect. Where the framework already emits
the event (request logging, client logging) the card says so instead of duplicating it. A task with
no failure exit of its own stamps `log_points: none - <reason>` - an absent field and a considered
none must never look alike. Every point goes through the repo's existing logging seam and message
convention - name the precedent on the card, never a second logger.

**Every judgment call lands on the plan with its precedent.** The plan carries a `## Decisions`
ledger - one line per call the design made where the requirement left two defensible shapes (a
library, a structure, a pattern, a placement, a name at a seam): `the choice - precedent: <file:symbol
or named rule>`, or `no precedent - <reason>` said explicitly and still decided; a plan with no such
call writes `## Decisions: none - <reason>`, so an absent ledger and a considered none never look
alike. The implementer inherits each answer and leaves its why at the line; the reviewer gates the
built code against the ledger. A choice the project already recorded - in its instructions file, the
architecture docs, the code-style doc - is a decision, never a defect to design around: judge the fit
against what the project deliberately chose, not against a convention it deliberately does not use. A
new file's home is a decision too: the folder the repo's best-organized module uses for that kind of
file, never a new `common` / `helpers` / `utils` dump folder. A how-to-build call is never left to the
build or bounced to the user.

## Output

An ordered task plan: the fit verdict and its forcing edge first, then one entry per task - what it does, the files, the traps to handle, the located anchors, the log points - in build order, then the `## Decisions` ledger (or its explicit none). The plan file opens with an `Oriented:` header line - the architecture doc read (or the bounded pass) from step 1 plus the house skill(s) loaded in step 2, or `none - <reason>`. It is a required field, not a nicety: `project-verify-plan` fails a plan without it, and if you cannot fill it those steps did not happen - do them now, a plan designed blind ships the traps it never saw. Write it to `<docs-path>/superpowers/plans/<feature>.md` before handing off - the FILE is the handoff artifact: it survives compaction and a fresh session, where the chat copy does not. A DISPATCHED designer seat has no Write tool: it returns the whole plan in its report, `Oriented:` line first, and the orchestrator writes the file from it. Then hand off: gate the plan with `project-verify-plan` before building, build each task with `project-implementer` under the stack skill, and review the built code with `project-verify-code` (`project-solve-task` drives this whole chain with a user gate between every step). For the plan FORMAT, load `superpowers:writing-plans` (a Skill call, not a recalled pairing) - and take its FORMAT only: any banner or execution advice it stamps into the plan is stripped before the file is written. Measured in five bundles: its `superpowers:writing-plans` banner landed in durable plan files recommending a dispatch method the run's own approved mode excluded, and the plan file outlives the session that made it, so the wrong advice is read by every later seat. The execution mode belongs to `project-solve-task`'s mode ask, never to the format skill - and when consulting a prior plan as a format reference, scope the read: the header plus one task entry, never the whole file, and never another ticket's plan as a substitute for the format authority (measured: with nothing loading the format, one run whole-read an unrelated 275-line ticket plan - the session's largest result and biggest context spike). This skill adds the house architecture-fit and stack-trap layer a generic plan is silent on. An external claim in the plan - a vendor API's behavior, a package's capability, a rate limit - is verified via context7 or the vendor doc and cited, or marked `unverified`; never recall stated as fact.

## Example

Brief: 'Add data export to the records list.'

Plan (single-chat output):
- **Fit - extend an existing seam.** The records module already owns the read paths and an export is another read projection, so no new boundary. Forcing edge: the export must not pull the full object graph, so it reads through the existing query-projection seam, never the raw persistence surface.
- **Task 1** - add the export projection to the query seam and its implementation. Trap: stream the rows, never materialize the full set (the stack skill's unbounded-result trap). Anchor: the located query seam (`file:symbol`).
- **Task 2** - add the export entry point returning a streamed response. Trap: map to a transfer shape at the edge, never the persistence entity (the stack skill's boundary trap). Anchor: the located edge (`file:symbol`). Log points: the export's outcome at the entry point - information with the row count and the request's correlation id, error with the exception on a mid-stream failure; the framework's request log already covers the start, so nothing at the projection seam.
- **Task 3** - an integration test asserting the header row, one data row, and the success status. Anchor: the located test suite.
- **Decisions** - the export streams through the framework's own writer, not a new package - precedent: the existing report download (`file:symbol`). No row ceiling: no precedent - decided, the projection already streams.

Then gate with `project-verify-plan`, build each task with `project-implementer` under the stack's house skills, and review with `project-verify-code`.
