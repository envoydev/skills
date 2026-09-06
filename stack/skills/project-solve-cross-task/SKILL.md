---
name: project-solve-cross-task
description: "The entry-point router for multi-agent engineering work - scope the task IN-SESSION (the generated awareness rules + a bounded serena pass), then ask session-or-agents up front (an invocation naming the mode is the answer) and route to the smallest safe execution mode: single-chat, one implementer, a single-stack design-build-verify trio, or a producer-first cross-domain run (dispatch recommended in the ask) where the producer designer's interface IS the contract and the integration-reviewer gates the assembled feature. Triggers on how should I build or route this work, plan the agents for this, this spans backend and frontend, or investigate-and-fix a bug across the stack; name the stack in the ask ('frontend only', 'just the API') to pin routing straight to it. This skill scopes and routes - it never designs or writes code, and it runs in the MAIN session only: a dispatched seat never re-fires it, its brief already carries its slice of the flow. NOT for greenfield (project-build-from-scratch) or a deliberate architecture re-capture (project-architecture-analyzer)."
disable-model-invocation: true
---

# Project Solve Cross-Task - the Team-Lead Router for Engineering Work

You are the Team Lead. You own the whole lifecycle: scope the work in-session, recommend the smallest safe execution mode (the run-start session-or-agents ask decides dispatch), order the domain runs by dependency direction, keep the progress ledger, pause affected lanes when the seam interface changes, and drive the final integration gate before commit. You route and orchestrate from the main session; you never do a seat's design, build, or verify work yourself.

The two things that must never be violated:

```text
Producer before consumer across domains. Sequential inside one domain.
Never commit on domain sign-off alone - the integration gate is mandatory for cross-domain work.
```

**Chained runs.** When THIS session already ran an orchestration cycle (a prior plan approval, APPROVAL stamp, or cycle/run ledger from this same session is in context), the run-start ask's recommended option is the fresh-session hand-off - the finished cycle's carried context compounds into every dispatch and re-send (measured: chained orchestrations grew one session's per-message context ~19x); proceed in-session only on the user's explicit pick.

## Two routing families

Decide the family from the ask first, because they start differently:

- **Feature / change** - the task builds or changes expected behavior. Route through clarify -> scope -> mode -> ordered domain pipelines -> integration gate.
- **Issue / bug / incident** - the task asks why something is broken, failing, flaky, slow, or crashing. Route through `references/issue-investigation.md`: diagnose before coding, always. Do not start a bug on the feature path.

## Clarify before you design (feature family)

Before you scope a feature or dispatch any designer, settle one thing: are the requirements clear enough to design against? If the ask is ambiguous, underspecified, or carries more than one reasonable reading, clarify FIRST. It is the cheapest place to catch a misread requirement - a couple of questions now, against unwinding a whole design-build-verify run built on the wrong plan.

Clarification is an orchestrator gate, never a seat. Only the main session can talk to the user; a dispatched sub-agent returns a report, it cannot interview. So the Team Lead runs it inline - the superpowers brainstorming discipline plus `AskUserQuestion` for the open decisions - and records the answers as the `requirements_source` the designers build on.

Gate it on ambiguity, not size or domain count. A crisply specified feature goes straight to scoping; only a vague one is clarified first. Clarify the requirement, not the implementation - the how (library, structure, naming, pattern) is the designer's call. The gate has a backstop at the seat: a designer that receives an ambiguous brief does NOT guess - it returns NEEDS_CONTEXT and you clarify before re-dispatch.

## Scope in-session - before any dispatch

Scoping is yours, not a seat's. Establish the task's true blast radius from what is already in context, plus a bounded look at the code:

1. **Read what is pre-loaded.** The generated awareness rules carry the map: `baseline-project-architecture` (project type, style, modules) and `baseline-project-related-context` (the sibling/sub-project entries with `relation` and `seam` - the dependency directions). Follow into `<docs-path>/architecture/ARCHITECTURE.md` for the area the task names.
2. **Locate, bounded.** Verify the touched symbols and their one-level callers with serena - **hard cap: 2 locating passes**. When a module's picture needs more than that, dispatch architecture-analyzer (sonnet/low) for a digest instead of reading on - the cheap seat absorbs the reads, you keep the judgment.
3. **Walk the seam catalog.** Read `references/seam-catalog.md` - it lists the stack-keyed traps that turn a 'local' task into a cross-domain one (a shared DTO edit, a migration, an app-wide singleton service, an event contract). A discovered shared-interface edit is itself the cross-domain signal, not just an obviously multi-stack ask.
4. **State the verdict:** the affected domains, the dependency direction between them (who produces, who consumes - from the related-context entries or the map), the risks the plan must absorb, and any open questions (back to the clarify gate). The verdict CARRIES the seam check: one line naming which catalog traps the task touches (or 'no catalog trap applies - <why>') - a verdict without that line skipped step 3, not summarized it (measured: one run locked a single-domain verdict with the catalog never read while adding a field to a shared DTO - the catalog's first trap; safe only because the change happened to be additive).

## Execution modes - the user picks: session or agents

When dispatch is available, the scoping verdict IS the mode ask - one atomic step, not a verdict followed by a decision you make: the message that states the verdict fires AskUserQuestion (run this in the current session, or dispatch the agent seats?, the smallest safe mode marked recommended) and ENDS THE TURN; where the tool is absent the same message ends with plain-text options. Delivering a verdict and continuing into design, build, or any edit without the recorded answer is a protocol violation - record the answer in the ledger as `mode: <answer> - "<user words>"` before anything past this line runs, and a headless or CI-style invocation changes nothing: the turn still ends at the ask (measured: two headless runs rolled through the mid-flow form of this ask straight to a finished feature - one shipped the runtime defect the gated flow exists to catch - while the same model honored the ask shaped as an unskippable step). An invocation that already names the mode (an agents opt-in, an explicit 'inline') IS the answer, never re-ask - record it and continue. No dispatch capability is the current session without asking. For cross-domain work recommend the dispatched producer-first flow in the ask - running both domains in one context reintroduces the token blowup and loses the integration gate's isolation - but the user's pick stands. Never dispatch a seat the user did not choose - dispatch is explicit-only, house-wide. A dispatched seat runs on its frontmatter model/effort pin unless the user names a model; fan-out defaults to 3 implementers at once, more only on the user's ask. The recommended slot follows the session's state, not habit: the smallest safe mode normally; past the chained-run trigger above or ~150k context per message, the fresh-session hand-off TAKES the recommended slot - and every ask this skill fires past that trigger carries the fresh-session option (the stop contract's construction check - this skill's own job per ask; the guard-stop-contract hook backs it only once, at a clean close past the trigger, never mid-flow). From the scoping verdict, pick the smallest mode in `references/execution-modes.md`:

| Mode | Flow |
|---|---|
| single_chat | main session only - tiny, clear, one-domain, no seam impact |
| implementer_only | main session -> one domain implementer -> main session verifies |
| domain_trio | one stack's designer -> implementer -> verifier (run per `references/domain-trio-protocol.md`) |
| fanout_domain_trio | one stack's designer -> up to 3 implementers at once (more on ask) -> verifier (same protocol) |
| cross_domain_light | producer designer -> producer + consumer implement/verify -> integration-reviewer - 2+ domains, routine seam |
| full_cross_domain | producer designer -> consumer designer validates the seam -> domain pipelines -> integration-reviewer - novel or risky seam: new public/versioned API, streaming or eventing, auth, migrations, deployment order |

**Honor a fresh-session answer.** When any ask's answer picks the fresh-session hand-off, the turn ends with a short ack plus the paste-ready resume block - nothing else: no 'one more step', no new work in this chat (measured: one run took a tool-held 'Fresh session' answer and continued 1h51m to 490k ctx). If the user keeps typing here afterwards, answer questions plainly, but route new WORK back to the hand-off once - then follow their explicit choice.

For any single-stack mode, Read `references/domain-trio-protocol.md` and drive that stack's seats from the main session per it - the plan gate, the parallel fan-out with per-task model overrides, the bounded verify loop (scoped re-briefs, two fix rounds maximum), and the status routing are that file, never re-improvised. A user hint that names the surface ('frontend only', 'just the API') pins the stack up front: scoping shrinks to the change-scope read that feeds the designer brief, and routing goes straight down the trio ladder. This skill owns everything above one stack: scoping, mode selection, the seam lifecycle, and the final gate. Escalate a mode the moment the guardrails in `references/execution-modes.md` trip.

## Cross-domain orchestration - producer first

When the mode is cross_domain_light or full_cross_domain:

```text
Requirements clarified, scope + dependency direction established (above)
  -> PRODUCER designer runs first (the upstream side per the dependency direction);
     the interface section of its plan IS the contract - record it in the ledger
  -> full_cross_domain only: CONSUMER designer validates the seam against its side's needs
     BEFORE anything is built - a misfit loops back to the producer designer at design cost
  -> producer + consumer verticals build (each internally sequential: implementers -> verifier;
     consumer implementers are briefed from the recorded interface)
  -> integration-reviewer gates the assembled whole  (final gate, mandatory)
  -> optional security-auditor if the risk requires
  -> commit only after the integration gate signs off
```

The producer designer's interface is recorded in the ledger before any consumer seat is briefed - routes, DTOs, error envelope, auth policy, whatever the seam carries. In light mode you brief the consumer implementers from it directly; in full mode the consumer designer checks it first. Either way the seam is written down once and every brief cites it.

**Gate every plan before it fans out.** For fan-out and cross-domain modes, audit each returned designer plan by INVOKING `project-verify-plan` (the Skill tool - load it, never replay its passes from memory: the passes evolve with the stack, your recollection does not) and running its four passes in-session - traps named for its stack, scope matches the requirement, edges and safety covered, minimal - before dispatching a single implementer. Record the audit in the ledger as four per-pass verdicts by name - `risk / scope / edges / soundness` - an audit entry that cannot list the four passes is an audit that did not run. The plan is already in your context, so the audit costs one bounded pass; a failed pass goes back to the designer as a scoped re-brief, never silently patched by you. Skip it below fan-out (single_chat / implementer_only) - there the audit can cost more than the build it protects.

**Plan review stop - the user reads the plan before anything builds.** Once the plan passes the audit (and, cross-domain, the contract is recorded), present the gated plan - tasks, contracts, risks, and the seam interface where one exists - and put the review through AskUserQuestion - approve-and-build vs changes-needed, free text via Other (plain-text options where the harness lacks the tool) - then END THE TURN. This is the user's window to read, edit, or redirect before implementers spend anything; build only on the approving answer. The stop is about the work, not the dispatch: an inline-mode run with a substantial change (a new feature, 3+ files) stops here identically - no hook guards inline edits, this ask IS the approval. The user can waive it - 'run without plan review', 'no stops', or equivalent, in the ask or at any stop - and then the run continues straight through with `plan_review: waived` recorded in the ledger, an honest record, never a silent skip. Opting into dispatch or naming an execution mode is NOT a waiver - and neither is an instruction to run the whole flow end-to-end, finish in one pass, or end with a completion token (a CI-style ask still stops here). Only words about the review are.

When you build each dispatch brief, keep it lean and capability-wired: each seat runs the Ponytail / terseness discipline for its role (`references/token-reduction.md`) and is pointed at the installed capability - house skill, context7, serena, the memory handoff note - that removes a guess or a re-read (`references/capability-reuse.md`). When frontend and backend live in different repositories, run one flow per repo joined by the same recorded interface and this same final gate - `references/repo-separation.md`.

### Example - one routed run

'Add CSV export to the orders page' - the ask is crisp (columns and filter named), so no clarification pass:

1. Scope in-session: the related-context entries say the Angular client consumes the ASP.NET API; the export touches both -> backend produces, frontend consumes, routine seam -> **cross_domain_light**.
2. Dispatch aspnet-solution-designer (producer). Its plan's interface section - the export route, csv response shape, error envelope, existing orders auth policy - is recorded in the ledger as the seam.
3. Run the aspnet vertical; brief the angular implementer(s) from the recorded interface and run the angular vertical (implementers -> verifier).
4. Both domain verifiers sign off -> dispatch integration-reviewer; it probes the seam (content type, empty-result shape, auth on the new route) and signs off.
5. Commit - authorized by the integration gate, not the domain sign-offs - and close out the ledger.

At close-out (any mode), add **doc-drift awareness** - one line at most, the user decides, never auto-run: a landed change that touched an architecture-critical surface (a schema/EF migration, a new module, a moved boundary, a new or revised seam - anything the contract protocol versioned this run - or a new external dependency) gets `/project-architecture-analyzer` named in the close report (update mode is diff-scoped and cheap); substantial new code + tests with an absent or pre-change-stamped coverage doc gets `/project-test-coverage-analyzer` the same way. The close also names what this run started to build, test, or verify and still has up - a Docker container or compose stack, seeded integration-test data, a dev server, a background watcher - and puts tear-down-vs-keep through AskUserQuestion in the same close (teardown recommended for the disposable; `none` said plainly; what the run did not start is never touched).

The close opens with a **pending sweep** - anything undecided or unlanded is named as its own line or ask option, never dropped at the session's end: an earlier ask still unanswered, unpushed commits (check the upstream), an undecided push, any gate still owed (a verifier not run, a review skipped - named in the user-facing text, never only in a private receipt), and any bug flagged this run but not fixed. A flagged-but-unfixed bug also goes into the ledger or task docs BEFORE any memory purge, so the purge cannot destroy its only record (measured: one purge did, and one plaintext-credential decision died at /exit). Doc-drift covers contradictions too: a decision this run made that contradicts an existing architecture or assessment entry routes the same one line (update mode), and the drift line lands in the user-facing close, never only an internal note.

## The seam is law

No seat may silently change the recorded interface. A local implementation detail can change and continue; a seam change - a route or DTO, an auth policy, a schema semantic, anything on the change list `references/contract-protocol.md` owns - must stop and emit BLOCKED_CONTRACT_CHANGE with a change request. On a seam change: pause only the affected lanes, revise the interface with the producer designer (or in-session when the delta is trivial), record v2 in the ledger, re-brief the affected seats, and verify against v2 only. Full protocol in `references/contract-protocol.md`.

## Progress ledger

Keep a durable ledger - a short file, not just in-context notes - so a mid-run compaction resumes without re-deriving what landed: the recorded interface and its version, each lane's phase and task statuses, the change history, and the final-gate status. Format and the structured status vocabulary every seat returns are in `references/agent-output-protocol.md`. The ledger also makes phase boundaries cheap restart points: on a large run, recommend resuming the next phase in a fresh session - measured, the orchestrator restarts at 21.5-59.4% of its carried context with nothing lost (never under 21%; quote the absolute numbers to the user, never a ratio), and carried-forward context is the run's single biggest token cost.

## Policies - the shared home every seat references

Route to these rather than restating them in each agent:

- `references/execution-modes.md` - the mode ladder and escalation guardrails for both families.
- `references/domain-trio-protocol.md` - the single-stack vertical: design -> parallel build -> bounded verify loop, status routing, memory hygiene. Read it whenever a single-stack mode is picked.
- `references/model-routing.md` - how task class and risk map to the seat and effort to dispatch; the static frontmatter pins are the defaults, this is when to escalate.
- `references/seam-catalog.md` - the stack-keyed traps the scoping pass walks: what turns a 'local' task cross-domain.
- `references/contract-protocol.md` - the recorded interface, versioning, the change protocol and BLOCKED_CONTRACT_CHANGE.
- `references/agent-output-protocol.md` - the structured status vocabulary per role, the progress-ledger format, the task-card and verification-report templates.
- `references/token-reduction.md` - the Ponytail and report-terseness policy: which discipline each role runs.
- `references/capability-reuse.md` - which installed capability (house skill, MCP, LSP plugin) each seat wires in and the guess, re-derivation, or pass it removes; the eager-context and redundant-read cost lever.
- `references/issue-investigation.md` - the bug/incident family: diagnose-before-coding, the fix-routing rules, the diagnosis and final-report templates.
- `references/repo-separation.md` - one flow per repo plus the shared recorded interface when frontend and backend live in different repos.

## Rules

- The mode is the user's run-start pick - the ask in 'Execution modes' above (explicit-only, frontmatter pins, the 3-implementer cap); cross-domain carries a dispatch recommendation inside the ask, not a default.
- The main session is the only orchestrator. Domain seats carry no Agent tool, so the fan-out stays flat; the sanctioned nested dispatch is the two diagnosers calling a read-only evidence-gatherer - and it does not run inside this flow.
- Scoping stays bounded: 2 locating passes in-session, then an architecture-analyzer digest - never a whole-module read in the orchestrator context.
- Do not duplicate agents to vary task size or model effort. One durable seat per role; `references/execution-modes.md` picks the mode and `references/model-routing.md` picks the effort.
- Never verify against a stale interface version, and never commit on a domain verifier's sign-off alone - the integration gate is the only thing that authorizes a cross-domain commit.
- Durable orientation lives in the docs under the project's docs root - the architecture map (`<docs-path>/architecture/ARCHITECTURE.md` + `<docs-path>/architecture/references/`) and the code-style doc (`<docs-path>/PROJECT-CODE-STYLE.md`); every seat reads them to orient instead of re-deriving the project, and serena memory is the transient inter-agent comms bus, not the durable store. The docs refresh deliberately, never inside this flow: the domain designers judge where a change fits by reading the map, and reconciling the docs after a structural change is a purposeful capture run (via the `project-architecture-analyzer` skill or the `project-architecture-quality-loop`).
- A causal claim about a dispatched seat's actions - to the user, or in a re-brief - is checked against the seat's `tools:` grant and its transcript first: a seat without a write tool did not mutate the tree, whatever the timeline suggests; when the real actor is unknown, say unresolved rather than assign it (measured: a read-only reviewer was blamed to the user for a tree mutation it structurally could not perform - the false attribution shipped as fact and cost real trust).
- Keep this skill scoping, routing, and orchestration only. Stack knowledge lives in the domain agents and the skills they load; the single-stack execution protocol is `references/domain-trio-protocol.md`.
