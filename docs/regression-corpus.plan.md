# Regression plan - what would have caught the 203-session audit

Written after the 203-bundle audit landed 8 blockers and 13 material clusters in 11 commits
(`d2d5352..344df55`, v0.2.55). The question this answers: which of those 21 findings can be made
mechanical, and which will always need a human reading real sessions.

## Verdict on 'add more tests'

**240 tests and 30 lint checks were green while all 21 findings were live.** Writing more tests of
the same kind buys nothing. Three reasons the suite missed them, each pointing at a different fix:

1. **Same author, same sitting, same mental model.** A test written beside its hook encodes the
   hook's assumptions - including the wrong ones. Every fixture in `scripts/guard-hooks.test.js` is
   a hand-invented command.
2. **No real payloads.** Real sessions produce shapes nobody invents: an interpreter write that
   routes around the file tools, an absolute docs root, a session cleaning its own temp scratch.
3. **Nothing measures a gate's field behaviour.** B1's gate could not fire in six independent ways
   at once and the suite stayed green, because no test asks 'does this gate ever fire on real
   traffic'.

So the plan is **corpus-first**, not test-count-first.

## What is already on disk

Measured across the four consuming projects' 794 collected transcripts (662 with content) - the
same bundles the audit read, already gitignored under `docs/session-investigation/`:

| Payload shape | Count | Replays through |
|---|---:|---|
| `Bash` tool_input | 21,888 | read-whole-file, catastrophic-rm, protected-force-push, ungated-commit, cross-project-write |
| `Read` tool_input | 5,427 | read-whole-file |
| `Edit` + `Write` tool_input | 1,903 | cross-project-write |
| assistant answers > 200 chars | 2,633 | stop-contract (Stop), answer-length (Stop) |
| typed user prompts (approx) | ~4,757 | answer-length, fresh-session-start (UserPromptSubmit) |
| `AskUserQuestion` tool_input | 674 | stop-contract (PreToolUse injection) |
| `Agent` tool_input | 463 | unapproved-dispatch |
| `Skill` tool_input | 342 | fresh-session-start |

**~38,000 replays, zero collection cost.** The corpus exists; only the harness is missing. Both
Stop hooks take `transcript_path` and read the file themselves, so a Stop replay is a prefix of a
real transcript written to a temp path - exactly the shape a live Stop sees.

## Tier 1 - the golden corpus replay

The centrepiece. Local pre-release gate, **not CI** - the corpus is 497MB of private transcripts
and can never be pushed. CI keeps the existing 240 tests plus Tier 2.

**1a. Verdict snapshot (approval test).** Replay every payload through every guard it reaches;
record `exit` per payload. The tracked artifact is `meta/corpus-verdicts.json`, keyed by
**sha256 of the payload**, value `{hook, exit}` - hashes only, so a public repo carries no command
text, no path and no secret. A diff names hashes; you look them up in the local corpus. A verdict
that moves without a code reason is the finding. This is the false-positive detector: B2, M4's
fixture bugs and M10 are all 'a guard started blocking honest work'.

**1b. Liveness and block rate.** SHIPPED - `scripts/corpus-replay.js`, `npm run corpus`. Two numbers per gate: how many corpus payloads it blocks, and the
rate. **A gate at 0% on 30,000 real payloads is dead** - that is B1, and it is the single check
that would have caught the campaign's worst finding. An unexplained rate jump is a false-positive
engine. Cross-check the corpus rate against the field rate `analyze-usage.js --hook-blocks` tallies
from `<docs-path>/hook-blocks/`: the two should agree, and a divergence means the replay harness
has drifted from how the hooks actually run.

**1c. Config matrix.** Run 1a under each config the field actually produces - relative vs absolute
`CLAUDE_STACK_DOCS_PATH`, project vs global scope, a Git Bash mount path, each context-window tier.
B4 was one row of this matrix.

**1d. Secret-shape sweep.** Scan the corpus for credential shapes and report every hit no hook
reacted to. B3 was seven such incidents with no mechanism anywhere; the sweep turns 'we found seven'
into a number that must not grow.

**1e. Denial-text self-consistency.** Extract every command a guard's own denial text prescribes as
the escape, and replay it through the full guard set. **A denial whose prescribed escape is itself
blocked is B7.** Cheap, and it stays correct as the denial texts are edited.

## Tier 2 - lint invariants (CI-safe, no corpus)

**2a. Measured-claim registry.** Every empirical number in a tracked artifact - a ratio, a token
count, a latency - carries a marker naming what measured it and when, pinned in
`meta/shared-rules.json` the way multi-home rules already are. Lint fails on an unpinned number and
on a pin older than N releases. This is the catcher for M13's refuted 'roughly a tenth' ratio, which
survived in two skills after eleven measurements put it at 21.5-59.4%.

**2b. Wiring completeness.** Assert the structural rules the audit had to discover by hand: a hook
whose value is an INJECTION is wired to `SessionStart` too (M2); every wired matcher a hook branches
on appears in both installer twins; every retired name is in the matching `RETIRED_*` list.

**2c. Negative-control receipt.** The discipline 'every new test must be shown to FAIL against the
pre-change code' is currently session practice and **written down nowhere** (verified: no tracked
file mentions it). Put it in `baseline-quality-gates.md` and mechanize the cheap half - a test file
touched in a commit whose gate receipt names no negative control is flagged.

## Tier 3 - drift probes (cadence, not CI)

Claims about the outside world - a CLI flag, a docs URL, an MCP behaviour, a shell's exit status -
cannot be tested offline. M6 and M11 are this class. **Extend the existing 21-sentinel harness suite
under `~/Claude/agent-bench/sentinels`** rather than building a second mechanism; add one sentinel
per outside-world claim the audit had to re-measure, and run it after every Claude Code upgrade.

## Tier 4 - what stays audit-only

Be honest that a floor exists. **A missing gate is invisible to every test** - B8 (nothing gated a
push, and four audited sessions pushed clean through every guard) can only be found by someone
asking what is not guarded. Same for the design-level clusters: M1's shared helper, M3's injection
mechanism, M7's named-field-beats-prose. The lever here is not a test, it is **making the audit
cheaper**: have the per-session audit prompt emit a machine-readable finding row so Phase 2's
clustering computes instead of being re-read.

## Scorecard - the 21 findings against the tiers

| Finding | Caught by |
|---|---|
| B1 dead fresh-session gate | **1b** liveness |
| B2 false positive teaches a bypass | **1a** snapshot |
| B3 credentials, no mechanism | **1d** secret sweep |
| B4 absolute docs path breaks gates | **1c** config matrix |
| B5 write guard blind to interpreter writes | 1a, partial - the payload is in the corpus, but only a human reading the diff calls the ALLOW wrong |
| B6 Stop guard deadlocks the clarify turn | **1a** on Stop payloads |
| B7 denial's escape is a violation | **1e**; its false cost claim by **2a** |
| B8 nothing gates a push | **nothing** - audit only |
| M2 injection hook not SessionStart-wired | **2b** |
| M4 receipt contract | **1a** |
| M5 convention rules off under bashFirst | **1b** liveness |
| M6 five navigation one-liners absent | **3** probe |
| M8 existence asserted, never checked | shipped as lint check 30 |
| M9 analyzer's 18 defects | 1a analogue, partial - a number snapshot catches regressions; the originals needed hand-counting |
| M10 false positives on own scratch | **1a** |
| M11 `/security-review` unusable | **3** probe |
| M12 guided commands and capture skills | mixed |
| M13 refuted ratio still live | **2a** |
| M1, M3, M7 | n/a - new mechanisms, nothing to regress against |

**12 of the 18 real defects get a mechanical catcher, 2 partial, 4 stay audit-only.**

## Status

**1b is landed.** `scripts/corpus-replay.js` extracts every hook-reachable payload from a corpus of
collected transcripts, dedupes it, replays it through the shipped guards exactly as the harness
spawns them, and reports fire count and rate per route. `scripts/corpus-replay.test.js` covers the
harness itself over a synthetic corpus - CI-safe, no session data - including the check that its
route table still matches what `scripts/os/claude-stack.sh` wires, so a new matcher cannot be added
and silently never measured.

Four design points worth keeping:

- **Replay in the payload's own project.** Each transcript row carries `cwd`, so every payload is
  replayed with `CLAUDE_PROJECT_DIR` set to the project it really ran in. Replaying another
  project's absolute paths against this repo's root would make the cross-project guard block almost
  everything - a fabricated rate, not a measurement.
- **Scratch isolation is mandatory, and pinned by a test.** The guards write session state and a
  block row under `<docs-path>/hook-blocks/`. Pointed at a real project, a 120k-payload replay would
  forge a field ledger out of history. `CLAUDE_STACK_DOCS_PATH` and `CLAUDE_CONFIG_DIR` both go to
  scratch; an empty config dir also stops a real account `settings.json` model id from moving a
  context threshold under the run.
- **A Stop replay is a prefix of the real transcript.** Both Stop hooks take `transcript_path` and
  read the file, so the replay writes the bytes up to the answer being judged - what a live Stop saw.
  Sampled at 10 points per transcript; every prefix of every transcript is gigabytes of I/O for a
  signal that saturates long before that.
- **An always-on injector is not a false positive.** `guard-answer-length` injects the budget on
  every prompt by design. Reading its 100% as a rate would send a maintainer to fix a working hook,
  so the route carries an `always` flag and reports 'by design'.

### First full run - 118,371 replays, 366s

| route | replayed | fired | rate | verdict |
|---|---:|---:|---:|---|
| guard-answer-length::Stop | 1016 | 189 | 18.60% | review |
| guard-answer-length::UserPromptSubmit | 891 | 891 | 100% | by design (always injects) |
| guard-catastrophic-rm::Bash | 21538 | 2 | 0.01% | live |
| guard-cross-project-write::Bash | 21538 | 72 | 0.33% | live |
| guard-cross-project-write::Edit | 1596 | 42 | 2.63% | live |
| guard-cross-project-write::Write | 296 | 11 | 3.72% | live |
| guard-fresh-session-start::Skill | 238 | 35 | 14.71% | review |
| guard-fresh-session-start::UserPromptSubmit | 891 | 6 | 0.67% | live |
| guard-protected-force-push::Bash | 21538 | 0 | 0% | unexercised (declared) |
| guard-read-whole-file::Bash | 21538 | 259 | 1.20% | live |
| guard-read-whole-file::Read | 3606 | 590 | 16.36% | review |
| guard-stop-contract::AskUserQuestion | 674 | 388 | 57.57% | review |
| guard-stop-contract::Stop | 1016 | 476 | 46.85% | review |
| guard-unapproved-dispatch::Agent | 457 | 121 | 26.48% | review |
| guard-ungated-commit::Bash | 21538 | 7 | 0.03% | live |

**No gate is dead.** One route is silent - `guard-protected-force-push`, 0 of 21,538 Bash payloads -
and that is the corpus saying nobody force-pushed to a protected branch in 203 sessions, not a
broken gate: it fires in its own unit coverage. Silence has those two causes and they are not the
same finding, so a silent route must be declared in the harness's `UNEXERCISED` map with its
reason and its proof-of-firing; an undeclared silence fails the run.

**The run's first job was to find its own bugs, and it did.** Two, both now pinned by tests with
negative controls:

- **Blind gates.** `transcript_path` was passed only on Stop routes, but three guards size the
  session's context off the transcript. `guard-fresh-session-start` therefore read DEAD on both its
  routes - the harness never gave it what it reads. With the transcript it fires 35 of 238.
- **Stop points were not turn ends.** Every assistant paragraph over 200 chars counted as a Stop, so
  the gate was judging mid-turn prose - prose that legitimately ends on a question with work still
  pending, which is exactly what it blocks.

**The open question the run raises:** `guard-stop-contract` is the most active gate by a wide
margin. Sampling its denials over 207 turn ends puts the reasons at 'done, next action pending,
stated as fact' and 'ends on a decision-shaped question in prose' in roughly equal share, then the
new credential check, then the fresh-session offer - all legitimate firings, none a harness
artifact. But the corpus ran under OLDER hook versions, so this measures how the POST-audit contract
would have behaved on historical traffic, and a gate that would stop nearly half of all turn ends
needs a deliberate decision that this is the intended bar. Rate also climbs with turn depth: the
first three turn ends of a session sample at 18.8%, the 10-point spread at 46.85%.

Cross-check built in: the run also tallies the real `hook-blocks` ledgers collected with the
bundles. That ledger is small - it shipped in v0.2.54, so most bundles predate it - but it is
ground truth, and a route the replay calls dead that the field shows firing means the harness has
drifted, not that the gate is dead.

## Order of work

Strictly by catch-per-hour:

1. **1b liveness** - a few hours, catches the campaign's worst finding, needs no snapshot format.
2. **1a verdict snapshot** - a day, the harness every other Tier 1 item reuses.
3. **1e denial self-consistency** - an hour once 1a's replay runner exists.
4. **2b wiring completeness** - lint, CI-safe, no corpus.
5. **1d secret sweep**, then **1c config matrix**.
6. **2a measured-claim registry** - the largest, because it needs every existing number audited once.
7. **2c negative-control receipt** and **3 sentinels** - discipline, cheap, do them alongside.

Stop after 1-4 if the budget is short: that is B1, B2, B7, M2, M4, M5, M10 - seven of the twenty-one
for roughly two days.
