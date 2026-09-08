# Task Ticket

Task-type templates, task-specific rules, and examples. The shared rules (Language, Tracker dialect, Filing, Tone, Assumptions, Format / delivery) and the Title format live in `SKILL.md`.

A technical task is work that is not a bug or a user-facing feature. Supports the following task types - detect from context:
- **Refactor** - code quality, structure, or design improvements without behavior change
- **Performance** - profiling, optimization, or scaling work
- **Investigation / Spike** - research or exploration with a time-box and a deliverable (findings, decision, PoC)
- **Migration** - moving data, infrastructure, or code between systems
- **Upgrade** - dependency, framework, or platform version bumps
- **Cleanup / Tech Debt** - removing dead code, fixing inconsistencies, paying down known debt

## Title

Phrase as an action or goal.

Examples:
- `[OrderService] Refactor order processing pipeline to use strategy pattern`
- `[API] Investigate high p99 latency on GET /products endpoint`
- `[DB] Migrate user data from MS SQL to PostgreSQL`
- `[Auth] Upgrade IdentityServer from v6 to v7`

## Description templates

Adapt the structure based on task type. Use the relevant template below.

### Refactor / Cleanup / Upgrade / Migration

```
## Goal

[2-4 sentences. What happens today, in which situation, and what should happen instead - readable
 by someone who has never opened the code. Then the technical motivation: performance,
 maintainability, correctness, consistency, or risk reduction.]

## Scope

[Which areas, screens or flows are affected, named the way a tester finds them. Where the product
 already behaves the wanted way somewhere else, name that place in one line as the example to
 compare against, and what differs. No new file, class or method names - that is the
 implementation, and it is not decided here. Call out what is explicitly OUT of scope.]

## Acceptance Criteria

- [ ] [Criterion 1 - specific and verifiable]
- [ ] [Criterion 2]
- [ ] No behavior change for end users (add if applicable)
- [ ] Existing tests pass; new tests added where logic changed

## Notes

[Optional. Risks, dependencies, rollback plan, related tickets. Skip if nothing relevant.]
```

### Performance

```
## Goal

[What is slow, under what conditions, and what the impact is.
 Include baseline metrics if known (e.g., 'p99 = 3.2s under 500 concurrent users').]

## Baseline / Target

| Metric       | Current | Target  |
|-------------|---------|---------|
| [Metric 1]  | [value] | [value] |
| [Metric 2]  | [value] | [value] |

## Scope

[What areas are in scope for investigation/optimization. What is out of scope.]

## Acceptance Criteria

- [ ] Target metrics achieved under [defined load/conditions]
- [ ] No regression in correctness or other performance metrics
- [ ] Changes are covered by benchmarks or load test results

## Notes

[Optional. Profiling tools to use, environments, known suspects, related tickets.]
```

### Investigation / Spike

```
## Goal

[What question needs to be answered or what decision needs to be made.
 Be specific - vague spikes waste time.]

## Time-box

[Maximum time to spend: e.g., '2 days', '1 sprint'. Work stops when time-box ends.]

## Questions to Answer

1. [Specific question]
2. [Specific question]
3. [Specific question]

## Deliverable

[What the output looks like: a written summary, a PoC branch, a decision in the ticket comments, an ADR, etc.]

## Notes

[Optional. Constraints, prior research, links to relevant docs or tickets.]
```

## Task-specific rules

- **Task type detection**: Infer the type from the user's description. If ambiguous, pick the closest match and note the assumption in Notes.
- **Acceptance Criteria**: For refactor/cleanup/upgrade/migration - always include. For perf - include with metrics. For spikes - replace with Deliverable instead.
- **Behaviour over solution**: even on a deeply technical task, most of the text is what the software does now and what it must do instead - QA reads this ticket too. When the work extends something already built, Scope names that existing behaviour as the example and the delta from it ('same rule, without the quantity check'), never a file-by-file spec of new code. Writing up your own implementation plan as if the design were settled is the most common failure here - see the two Scope rules in `SKILL.md`.
- **Specificity**: Be technical and concrete. No vague goals like 'improve performance' without numbers, conditions, or a defined target.

## Examples

**Input (from user):**
> Need to refactor the payment service, it's a mess - everything is in one giant class.

**Output:**

**Title:**
`[PaymentService] Refactor monolithic PaymentService class into focused components`

**Description:**
```
## Goal

The current PaymentService class handles provider integration, validation, retry logic, and logging in a single class (~800 lines).
This makes it difficult to test, extend, or change providers independently.
Goal is to split responsibilities into focused, testable components without changing external behavior.

## Scope

**In scope:**
- `PaymentService.cs` and direct dependencies
- Extraction of: provider adapter(s), retry policy, validation logic
- Unit test coverage for extracted components

**Out of scope:**
- Changing payment provider integrations
- UI or API contract changes

## Acceptance Criteria

- [ ] No single class exceeds ~200 lines of meaningful logic
- [ ] Each extracted component has its own unit tests
- [ ] All existing integration tests pass without modification
- [ ] No behavior change observable from the API layer

## Notes

- Coordinate with QA before merging - payment flow regression tests should be run manually.
```

**Input (from user):**
> Let's investigate why the product search is so slow. Users are complaining.

**Output:**

**Title:**
`[Search] Investigate high latency on product search endpoint`

**Description:**
```
## Goal

Users are reporting slow product search. The root cause is unknown - needs profiling and analysis
before any optimization work begins.

## Baseline / Target

| Metric   | Current        | Target   |
|----------|---------------|----------|
| p95      | Unknown        | < 500ms  |
| p99      | Unknown        | < 1s     |

Baseline to be established during investigation.

## Scope

**In scope:** GET /api/products/search endpoint and its dependencies (DB queries, filters, caching layer)
**Out of scope:** UI-side changes, other endpoints

## Acceptance Criteria

- [ ] Baseline metrics captured under realistic load
- [ ] Root cause(s) identified and documented
- [ ] Recommendations written up with estimated impact per fix

## Notes

- Check for missing indexes on product search columns first - low-effort, high-impact candidate.
- Use Application Insights / slow query log for initial profiling.
```

**Input (from user):**
> The license gate is only wired up for the Reporting module - we need it on the other eight modules too.

**Output:**

**Title:**
`[Licensing] Extend the license module gate to the eight remaining modules`

**Description:**
```
## Goal

A module licence has a validity window, and once it lapses the module should stop being usable. Today only Reporting behaves that way: opening it with a lapsed licence offers to extend the trial, or blocks the module when no trial activation is left. The other eight modules - Administration, Base Data, Field Journal, Fields, Import, Nutrition, Plant Protection and Settings - stay fully usable with an expired licence, so the licence is effectively unenforced everywhere except Reporting.

## Scope

The eight modules above, entered from the menu or by pasting the URL directly. Reporting is the example to compare against: the same dialog, the same blocking overlay, the same wording. The one difference is the rule behind it - these eight are judged on the licence dates and the trial only, with no quantity or area limit involved.

**Out of scope:** Reporting's own behaviour, which does not change; enforcement on the server side; new wording or translations.

## Acceptance Criteria

- [ ] With a lapsed licence and a trial activation still available, entering any of the eight modules offers to extend, exactly as Reporting does
- [ ] Confirming the extension makes the module usable again and moves the trial end date out by one month, visible in the licence overview
- [ ] With a lapsed licence and no trial left, the module is blocked and shows the same overlay Reporting shows, icon included
- [ ] The licence overview and the user profile stay reachable even when the Settings licence has lapsed - otherwise there is no way back in
- [ ] A licence marked as not checked, an active trial, or a past campaign year each leave the module fully usable
- [ ] Entering two modules quickly one after the other never shows one module's result on the other
- [ ] Users with the support role keep their existing bypass

## Notes

- Reaching the extend dialog for a lapsed licence may not work as it does for Reporting today - worth checking early, since it is the case the dialog exists for.
- The trial offer is gated per module by a flag in the module configuration; confirm it is set for the eight before assuming the extend path is reachable at all.
```

Note what the Scope does NOT do: it names no file, class or method, and nothing that does not exist yet. It describes the behaviour, points at the one module that already has it, and states the delta. Every criterion is something QA can trigger on a running system. The two unproven findings sit in Notes as checks, not instructions. Ticket writing stops at the boundary of the design.

The worked example above is illustrative, not a default stack - the same stack-agnostic rule as `bug.md`: adapt tool and stack names to the project the ticket is for.
