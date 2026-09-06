---
name: project-verify-code
description: "Use when a build is assembled and you want to review it in THIS chat with no dispatch - the single-chat, no-agents form of the verifier seat, and the inline alternative to /code-review's fan-out. Loads the stack's trap-list skills, reruns build + tests, gates the code against its plan, RUNS the app on failable inputs (a test can pass under WebApplicationFactory while the live endpoint 500s), traces a changed wire contract to its consumers, and returns a ranked punch-list - all inline, dispatching nothing. Trigger on review the build, review this here, check the code without agents, review before done, verify the build. Not the plan audit (project-verify-plan, before code), not the dispatched verifier seat or /code-review's parallel angles - this is the review you run without spawning anything."
---

# Verify Code - review the assembled code in one chat, no dispatch

The review step, run inline. `project-solution-design` planned it, `project-verify-plan` audited the plan, `project-implementer` built it - this reviews the built code against that plan and the stack's real traps, and it does the whole review in your context: it dispatches nothing. It is the single-chat form of the `<stack>-verifier` seat and the deliberate alternative to `/code-review`, which always fans out to subagents. Same review protocol as the seat; you just keep it here.

## The choice this skill is

The flow's two house reviewers, pick by whether you want dispatch:

- **This skill (inline)** - deterministic cost, zero agents, the whole review stays in one context. Best when you want a predictable spend and no fan-out. The cost: its reads and build land in THIS chat's context, so in a long session that context carries forward - the price of no dispatch.
- **The `<stack>-verifier` seat** (dispatch it) - the same protocol in an isolated subagent, so its read volume never touches your chat, on its frontmatter model unless you name one. Best when the session is already long and you want the review's noise offloaded.

Both are the house review protocol; this skill just keeps it in your chat. `/code-review` (the CLI's broad parallel-angle sweep) is no longer a flow default - it always fans out and the stack can't tune it - but it stays available if you invoke it yourself for extra breadth.

## When not

- Not the plan audit - that is `project-verify-plan`, on the page before any code. This is after the build.
- Not for fixing what it finds - it flags and hands back (to `project-implementer` or your own edit); a verifier authors nothing.
- Not the parallel-angle sweep - if you want breadth or an isolated subagent, use `/code-review` or dispatch the `<stack>-verifier`. This one stays inline by design.

## The review - in order, all inline

Load the stack's house skill FIRST (the one your convention rules auto-attach for these file types; its router names the specialist siblings), so you check against ITS trap list, not a generic one. Dispatch nothing at any step.

1. **Build + tests, rerun and quoted.** Rerun `build` and the suite yourself this session - never trust a pasted or prior-run result. Quote the output.
2. **Plan conformance.** When a plan file exists, gate the code against it: every task present, nothing built outside a task's boundary, each `## Decisions` ledger entry honored (the built shape is the decided one, its why at the line), each task's `log_points` placed through the repo's logging seam (level and identifiers as the card says, nothing beyond them), each acceptance criterion DEMONSTRATED the way `superpowers:verification-before-completion` prescribes - by a run in this session, not assumed from reading the diff.
3. **Stack-trap audit.** Check the diff against the loaded skills' trap lists - the data-access, lifecycle, concurrency, and boundary traps that stack actually has. A named trap the code hits is a finding.
4. **Run it, and check nothing existing broke.** Probe error paths and edge cases the tests skipped by RUNNING the app on the new failable inputs (a malformed query param, a bad route value) - a test can pass under a test host while the live endpoint 500s. The probe starts at boot: exercise at least one REAL end-to-end call through the production composition root (the app's own DI/provider config), because test hosts and TestBeds wire their own - a missing app-level provider ships behind a fully green suite whose every spec self-provides it, and only a live boot with one real call catches that class (measured: an app-level missing HTTP provider survived 24 green specs exactly this way). Launch recipe: bind the port explicitly and verify it from the app's own log line before polling - .NET: `dotnet run --no-launch-profile --urls <url>` (launchSettings silently overrides `ASPNETCORE_URLS` and plain `--urls`; measured: a probe polled a dead port through its full ~23s timeout because the profile won); Angular: the dev server prints its bound port - poll that one. When the diff touches styles or templates (`.scss`/`.css`/`.html`), the probe includes ONE targeted visual check of the changed surface - a screenshot of the element/region through the browser-driving MCP, not a DOM assertion alone (measured: a DOM-only probe signed off a style diff and the user caught a CSS-only defect in the exact reviewed feature 92 seconds later). That MCP is per-project - the baseline comments out the servers a project does not need, so it can be absent from your tool list; absent it, the visual check is reported `live-probe: visual NOT RUN - no browser MCP`, never assumed from the DOM. Driving the probe through it: resolve interactive targets from a page snapshot's element refs before any click or form fill - never a guessed CSS/text selector (measured: 4 of 5 probe errors in one session were guessed selectors, re-guessed three times); and on a second consecutive miss of an element that was previously present, check the page URL/state before retrying - the page has usually navigated out from under you (measured: two identical misses traced to an unnoticed mid-probe logout, found only by a snapshot two blind retries later). When the probe trips a failure path, the log line the plan named for it appears - a failure the probe triggers that leaves no record is a finding. And audit REMOVED behavior: follow the changed symbols' existing callers and confirm the diff did not silently drop or change a behavior they depend on - a regression no task named. The green suite is evidence the tests pass, not that the behavior is right. And check the new tests can FAIL: for each new or changed test, name the assertion that pins the claimed behavior - an assertion that holds regardless (asserts on the wrong object, an always-true comparison, a missing negative case) is a finding; a real contract bug has shipped behind exactly such a vacuous pass.
5. **Wire-contract cross-consumer trace.** If the diff changed a public or wire contract (a response shape, an endpoint signature, an exported type), trace it to its consumers - including any sibling named in `.claude/rules/baseline-project-related-context.md` (or `<docs-path>/related-context/PROJECT-RELATED-CONTEXT.md`) when the project carries them (a standalone repo has neither - the trace then stays in-repo) - and flag a break where a consumer still expects the old shape.
6. **Reuse + the working set.** With build, tests, and quality green, one focused pass: reuse - did the diff rebuild something the codebase or framework already ships (a helper, a pattern, `IMemoryCache`, `System.Text.Json`) instead of calling it? - and the seven decision-level rules `project-solution-design` decides against, applied to the diff: an abstraction with no trigger (an interface with a single implementation, options nobody sets, dead flexibility) or the same decision now in three places; code placed where it changes for a different reason than its neighbours; a seam where no boundary exists; a known-bad value travelling past the boundary, or a subtype that cannot stand in for its base; a method that both mutates and answers; a name the behaviour outgrew; a pattern started from rather than refactored toward. Then the write-time bar the implementer builds to, on the diff: a comment that narrates the what or claims something false against the code, a why missing where a decision or workaround would baffle the next reader, a name outside the repo's vocabulary, a dead branch, a magic number, a handle never disposed. SOLID is the vocabulary of the finding, never its basis - name what breaks. A finding, never a block.

A factual claim in a finding or a fix rationale is verified before it is stated - 'unverified is never a pass' covers the review's own assertions too. 'X cannot do Y' gets a precedent check (one grep for an existing counter-example in the codebase) before it drives a fix; a value quoted from a doc or config is read from the source in the same turn, never recalled (measured: a false 'the result union can't carry this' claim shipped a worse fix plus a misleading comment for 6+ hours - a one-grep counter-example existed; a 'read from the validator' table cell was invented from memory and a user question exposed it).

## Output

**Four named fields, every run, each with a value.** A controlled measurement in one report step:
five NAMED fields were emitted 5 of 5 times, while the same step's prose condition was emitted 0 of
1 - so if it must happen every time, it is a field with a value, not a sentence about when to write
one. None of these four was emitted in the measured review, and the user asked 'have you fixed
everything?' 76 seconds later.

```
Build:      <the command and its verdict line, quoted>
Live-probe: <the quoted probe output, or NOT RUN - <reason>>
Findings:   <count by severity, or `none`>
Next run:   <what the next pass must cover, or `nothing owed`>
```

`none` and `nothing owed` are answers; an omitted line is not, and a NOT RUN live-probe is never a
pass (measured: one review reported 'sound after one fix' with build and tests quoted and no
live-probe line - the app could not boot its HTTP wiring).

Then the body: a ranked punch-list, most severe first - one line per finding: `severity | the defect (file:symbol) | the fix`. If the code is sound, say so plainly and name what you checked and ran. Every finding keyed to a file + symbol so a fix lands exactly there. Nothing you could not verify is reported as unverified - unverified is never a pass. Hand the list back; this skill does not apply fixes.

When the review is the pre-commit checkpoint (a commit is the next act) and the verdict is sound - or sound after fixes that landed and re-verified - write the gate receipt `<docs-path>/flow/COMMIT-GATE` with five lines - `VERIFIED <what was reviewed, one phrase>`, `authorized: "<the user's words asking for THIS commit, verbatim>"` (or `answered: <the chosen option label>` when they picked rather than typed), `head: <the sha reviewed>`, `spec: <N files>` and `live-probe: <what you ran, or NOT RUN - <reason>>`. The VERIFIED line proves the review ran, the authorized line proves the user asked (on auth/crypto/secrets/payment/data-access diffs only after the `/security-review` pass baseline-security requires). When the consent words do not exist yet - the review ran ahead of the ask - write the VERIFIED line now and append the authorized line at the commit turn, before the commit call; write the receipt as its OWN tool call, never inside the commit's compound command. The `guard-ungated-commit` hook blocks a non-trivial commit without all of them, and an INLINE review's Output may live in the receipt provided every required field is present. A punch-list with unresolved BLOCKER/MATERIAL findings writes no receipt.

## Example

Reviewing the records-list export build (the `project-implementer` example - three tasks: a query projection, a streamed export endpoint, an integration test) inline:

```text
build + test | rerun green - Passed: 22, Failed: 0 (quoted)
plan         | all 3 tasks present, none outside its boundary, cancellation threaded per the audit
run-it       | BLOCKER | GET /export?format=bad 500s on the live host, not 400 (file:symbol) | the suite's test passes under the test host - the binder throws before the filter; map the bad-request to 400
contract     | MATERIAL | /export response shape changed; the sibling web client still reads the old array (repo:file) | freeze the contract, move the consumer in lockstep
over-build   | MINOR | a format-strategy interface with one implementation (file:symbol) | inline it (yagni)
```

Verdict: one BLOCKER to fix (live 500), one cross-consumer break to decide, one nit - handed back, nothing dispatched.
