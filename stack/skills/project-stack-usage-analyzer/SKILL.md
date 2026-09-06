---
name: project-stack-usage-analyzer
description: "Token/tool usage audit of claude-stack skill runs in THIS project: finds EVERY session transcript with a stack-skill run (or the SESSIONS named), runs the stack's analyze-usage.js over each, and writes a per-session report (tokens, tool calls, waste, protocol check, verdict) plus the raw data for a follow-up agent - and a cross-session SUMMARY.md when several sessions are audited. Manual, /-only. Triggers on 'analyze the stack usage', 'usage report for the skill runs', 'audit all sessions for this project', 'how many tokens did the flow burn'. NOT for live session cost (claude-hud shows that), fixing the findings (route them to the owning skill), or benchmarking model choices."
disable-model-invocation: true
---

# Project Stack Usage Analyzer - token/tool report on stack skill runs

You audit what claude-stack skill runs in this project actually cost: find the session transcripts, run the stack's offline analyzer over them, and write one report per session with the raw data next to it, so a later agent can re-analyze without re-collecting.

Run the audit from a FRESH session that names the target session id(s) - never from the tail of the session being audited. The work is offline (a node script plus report writing) and needs none of the audited chat's context; measured, an in-session run at ~620k accumulated context paid six 529-retry re-sends (629k cache-write for 11 messages) for a report a fresh session produces from ~20k.

**Inputs.** SESSIONS - which of this project's sessions to audit. An invocation that names the scope (session ids, 'the last 3', a since-date, 'all') IS the answer - never re-ask; the one exception is a scope that includes the CURRENT session, which always routes through the fresh-session self-check below (that ask resolves HOW to honor the fresh-session rule, it does not re-ask the scope). Otherwise resolve the candidates first (step 1's grep), then ask ONE question via AskUserQuestion, each option carrying its real count: **Up to 12 unaudited, oldest first (recommended)** - the batch bound, and re-run for the rest; **All matching** - every transcript with a stack-skill run, N unaudited, and say plainly that N over 12 will force compactions; **Today's sessions** - the matching transcripts started today, N; **Current session only** - routes through the fresh-session self-check below (exclude it from this run, or hand the invocation to a fresh session - it is never audited from its own tail); a custom scope arrives via the built-in Other. Hold the answer for the run. **The batch is BOUNDED at 12 bundles per run and the marker goes on the bounded option, not the largest one** - two measured runs took 45 and 53 bundles in one chat for 42.1M and 78.2M cache-read and 2 and 4 forced compactions, because the biggest scope was the one marked Recommended. Over the bound, audit the oldest 12, then close the run naming exactly what is left and the invocation that resumes it. SKILLS - the skill names to hunt in the transcripts. Default: DETECT - sweep the transcripts for the stack skills that actually RAN (a `<command-name>` slash block or a Skill-tool call against the installed roster; a name appearing only in injected CLAUDE.md/rules text is a mention, not a run) and audit those, stating the detected list in the report. The user can name specific skills instead to narrow the audit. Two run modes, opposite expectations: a single-chat skill (the `project-solution-design` / `project-implementer` / `project-verify-plan` trio) runs in-session and dispatches NOTHING - its cost is all main-context, so the interesting numbers are tool-result sizes and cache behavior. A dispatch-mode run (`project-solve-cross-task`, an agents build mode, a capture fan-out, a DELEGATED quality loop) is the reverse: subagents are EXPECTED, and the interesting split is main-session vs per-seat cost - the analyzer reads the session's `subagents/` files and emits both.

## The run

### 1. FIND the transcripts
Claude Code writes one JSONL per session under `~/.claude/projects/<encoded-project-path>/` - the folder whose name is this project's absolute path with slashes replaced by dashes. Grep the `*.jsonl` files there for each SKILLS name (on the DETECT default: for the invocation markers of any installed stack skill) and list which session file(s) contain which skill RUN - invocation markers only, never bare mentions. A `<session-id>/subagents/` folder next to a session file belongs to that session - note it (for the default trio, its existence is already a finding; see the report shape).

With the matches listed, resolve SESSIONS: unless the invocation itself named the scope, this step IS an AskUserQuestion call - fire the run-start ask above with the counts this grep just produced, and only then continue. Never pick a scope yourself and never default to the current session on a bare invocation (measured: one run picked 'two sessions' unasked from its own tail, another started analyzing the current session with no ask - the prose form of this step was skipped both times; the tool call is the step). Self-check before anything runs: when the resolved scope includes the session this audit is running in, stop, restate the fresh-session rule, and put the resolution through ONE AskUserQuestion - **Exclude current session (recommended)**: drop the current id from the scope and note it for the next fresh-session run; **Hand off to a fresh session**: end the turn with the invocation to paste there - never resolve it silently and never audit the live session's own tail (measured: four sessions did, one burning its whole 529-retry budget over 44 minutes and shipping a bundle that undercounts its own tail - the prose rule alone did not hold, this check is the gate). Then audit EVERY session in the chosen scope - never just the newest, never a silent subset; each audited session gets its own step-4 bundle. One bound keeps repeated sweeps sane, and the test is the REPORT, not the folder: a session is previously-audited when `<docs-path>/claude-stack-usage-report/<session-id>/report-usage.md` exists AND carries no `FILL IN` section - skip that one, list it as previously-audited, and re-audit only on an explicit ask. The folder alone is not the test: it becomes true at the SKELETON write, up to 74 minutes before the report is authored, so a run resumed after an interruption would have skipped all 53 of its own unfinished bundles as done.

### 2. GET the analyzer
It ships in the stack's source repo, not in this project. One snapshot, the house way - the release archive first, clone fallback:

```bash
TMP=$(mktemp -d)
curl -fsSL -o "$TMP/stack.tar.gz" https://github.com/envoydev/claude-stack/releases/latest/download/claude-stack.tar.gz
tar -xzf "$TMP/stack.tar.gz" -C "$TMP"
# archive route failed entirely? then:
git clone --depth 1 -b main https://github.com/envoydev/claude-stack "$TMP/repo"
```

Run these as SEPARATE simple commands, not a piped one-liner - the harness's auto-mode
classifier blocks the `curl | tar || git clone` compound verbatim (measured three times: two
runs fell back after a denied pipe; one lost 17 minutes - a quarter of its session - to the
resulting cold clone). The RUN step is different, and the clause that banned loops there was unfollowable at real scope:
one measured sweep carried a loop in 69 of its 141 calls, because a per-session command times N
sessions is N calls. Only the PIPE half of the rule holds. So for the run: write the batch to a
file and execute the file -

```bash
cat > "$TMP/run.sh" <<'EOF'
for f in <the session files>; do
  node "<snapshot>/scripts/analyze-usage.js" "$f" --report-md > "<out>/$(basename "$f" .jsonl)/report-usage.md"
done
EOF
bash "$TMP/run.sh"
```

- which is one simple command the classifier reads as one, with the loop inside a file rather than
inside the command line. The tool is `scripts/analyze-usage.js` inside the extracted snapshot - `<snapshot>` = `$TMP` when the archive extracted, `$TMP/repo` when the clone ran. Both fetches fail: say so and stop - never rebuild the tool from memory. Record the snapshot revision (the archive's `RELEASE-SOURCE` file, or the clone's HEAD) for the report's Environment section. Remove `$TMP` at the end of the run, on every exit path - success, failure, or abort.

### 3. RUN it
- `node <snapshot>/scripts/analyze-usage.js <projects-dir>` - one-line rollup, to confirm which sessions matter.
- `node <snapshot>/scripts/analyze-usage.js <session.jsonl>` - full report, once per matching session.
- `node <snapshot>/scripts/analyze-usage.js <session.jsonl> --json` - machine dump, once per matching session.
- `node <snapshot>/scripts/analyze-usage.js <session.jsonl> --report-md > report-usage.md` - the report SKELETON: machine-written tables plus the FILL IN judgment sections. Add `--hook-log` here too when the ledger exists (below).
- Non-default docs root (`CLAUDE_STACK_DOCS_PATH` set): add `--docs-root <that root>` to every per-session call - the analyzer's Generated-docs table watches only `.claude/docs/` by default, so a custom root silently drops every doc touch.

**Test for the ledgers, never assert their absence.** All 53 reports in one measured sweep shipped
`Hook ledger | absent` from a prose instruction nobody executed, and 26 of them were reworked at the
end of the run for 6,222,488 cache-read - 8.0% of that session. The test is one command per session,
and its OUTPUT is what the report quotes:

```bash
for d in tools-usage hook-blocks; do
  f="<docs-path>/$d/<sid>.jsonl"
  [ -f "$f" ] && echo "$d: $f ($(wc -l < "$f") rows)" || echo "$d: absent"
done
```

`absent` in the report means that command printed `absent` for that session. Then look for the
instrumentation ledgers - do not wait to be pointed at them: `CLAUDE_STACK_INSTRUMENT=1` writes one per session/agent id under `<docs-path>/tools-usage/<sid>.jsonl` (or wherever `CLAUDE_STACK_INSTRUMENT_LOG` pointed). For each audited session, check that folder for the session's own id and its dispatched agents' ids; on a hit add `--hook-log <ledger>` - it joins the who-fired-what identity side the transcript alone cannot attribute. No ledger: skip the flag and say so in the report. Check `<docs-path>/hook-blocks/<sid>.jsonl` the same way and add `--hook-blocks <that file>` on a hit - the session's OWN file, never the whole directory, or every other session's blocks land in this session's tally. That ledger is the only record of WHICH guard denied a call (the transcript names the denied tool and nothing else), and a block costs its denial text plus the retried turn, so the per-hook block rate is what says a gate earns its keep.

### 4. WRITE - one folder per session
Everything for a session lands in `<docs-path>/claude-stack-usage-report/<session-id>/`:

- `report-usage.md` - the filled `--report-md` skeleton: the analyzer's tables stay UNTOUCHED (a number a tool prints cannot be misquoted - measured: 5 wrong claims across 4 hand-written reports, each a prose restatement of tool output), and you author only the FILL IN sections, shaped per the section spec below.
- The `--json` dump(s).
- A copy of the session `.jsonl` and its `subagents/` folder when present - the complete raw data, co-located so another agent can analyze it without hunting.
- The session's guard-block ledger, COPIED from `<docs-path>/hook-blocks/<sid>.jsonl` and renamed `hook-blocks-<sid>.jsonl` when it exists - one row per BLOCK, naming the hook that fired. Copied rather than moved: the ledger is the project's own running record of what its gates denied. Absent means no block fired this session - say that rather than leaving the reader to guess.
- The session's instrumentation ledgers, MOVED (not copied) from `<docs-path>/tools-usage/` and renamed `tool-usage-<sid>.jsonl` - the session's own and its dispatched agents'. The move is deliberate: an audited run's ledgers live with its bundle, and the collection folder drains as runs get audited instead of accumulating forever; a session not audited this run keeps its ledger in place.

Raw transcripts carry full conversation content - code, file contents, possibly secrets. Under the default machine-local docs root that stays on this machine; when the project set a COMMITTED docs root, get explicit consent before copying raw transcripts there, and without it copy only the report and the `--json` dumps.

`report-usage.md` = the skeleton plus your judgment. The machine sections (Environment, Tokens, Subagent dispatches, Skills, Generated docs, MCP, Tools, Context spikes, Hook-log join - whichever the run emits) stay as printed; you add the Environment rows only you know, insert ONE authored section - `## Per skill run` - between the machine tables and Waste analysis, and fill the skeleton's three FILL IN sections. Content per authored piece:

**## Environment** - append the rows the analyzer cannot know: Claude Code version, OS, project stack(s), analyzer snapshot revision, which session file covers which skill run - and a `Session vintage` row: the audited transcript's own date and CLI version, the reference every 'the session broke rule X' claim is checked against (the vintage rule below). Models and wall-clock arrive machine-written - leave them.

**## Per skill run** (one subsection per SKILLS entry found)
- Tokens and tool-call counts: cite the Tokens/Tools table rows - never restate the numbers in prose (that restating is where the 5 wrong claims came from).
- Top 10 most expensive tool RESULTS by ~tokens, each as: tool | target (file path or command only, never file contents) | ~tokens - measured from the transcript (the analyzer aggregates per TOOL, not per result); label them as transcript measurements.
- Context-growth spikes the analyzer flags, and what caused each.
- Skills/plugins that attributed output (the analyzer's attribution columns) - did the run load anything unexpected, or fail to load something it should have? The analyzer prints main and subagent attribution SPLIT, with the seat types carrying each sub stamp: a seat type foreign to the skill (a domain verifier under an installer command) is stamp bleed from an adjacent run - a dispatched seat inherits whatever skill was last active - so report it as bleed and never charge it to the skill (measured: 223 verifier msgs / 31.3M cache-read once landed on a plugin-update command that dispatches nothing).
- Subagent dispatches, mode-aware. Single-chat skill: should dispatch nothing - any subagent cost is a finding, not a footnote. Dispatch-mode skill: the per-seat breakdown from the analyzer's subagent rows - one line per dispatched agent (seat, model, tokens in/out/cache, tool calls, duration) plus the main-vs-seats share - and flag the anomalies: a seat that idles on a wait, re-dispatches, or costs more than the work it returned.

**## Waste analysis** - the specific places token use was disproportionate, each with evidence: whole-file Reads where a symbol lookup would do, the same file read more than once, oversized Bash/test output pulled into context, overlong prose in reports/summaries. Rank by tokens wasted.

**## Protocol check** - for each skill, did the run follow its own protocol? Judge against that skill's own SKILL.md steps - for the default trio: solution-design oriented from the project docs before designing and produced an ordered minimal plan; verify-plan ran its passes against the plan rather than re-deriving it; implementer stayed inside the task contract, ran build/tests, reported per its shape. Cite turns, never assume. The check's scope is the SESSION, not the skill windows - three sweeps are mandatory before any PASS: (1) every stop in a flow's window - a gate verdict counts only when an AskUserQuestion tool_use produced the answer; a free-text user reply after prose narration is the measured failure mode, not a held gate (measured: three reports stamped 'PASS, all hard gates held' over prose stops); (2) every `git commit` event anywhere in the session, checked against the pre-commit checkpoint - including commits OUTSIDE any skill window, where the measured skips cluster (measured: a report counted 1 gate deviation where the session held 2, the other silent); (3) every user correction or redirect - each is a first-class report item with its surrounding context, never reduced to a token-waste row (measured: one report filed a user-caught managed-file edit purely as edit churn). A redirect is detected from the USER's own turn text - an assistant 'good catch' with no matching user turn is not one, and injected task-notifications/system-reminders are never user corrections.

**## Verdict** - one table: skill | worked as intended (y/n) | biggest strength | biggest waste source | one concrete suggestion.

Then append the full-report analyzer outputs verbatim at the end of the doc (they contain only counts, tool names, and paths - no code).

### 5. SUMMARIZE - the project-wide picture

When this run audited more than one session, or bundles from prior runs already sit in `<docs-path>/claude-stack-usage-report/`, write `<docs-path>/claude-stack-usage-report/SUMMARY.md` - replaced whole each run, never an append log:

- The analyzer's directory rollup table verbatim (`node <snapshot>/scripts/analyze-usage.js <projects-dir>`) - the machine-written per-session totals.
- One line per audited session: id, start date, headline verdict, bundle path.
- A short cross-session judgment, cited from the bundles: the ctx/msg trend across sessions, waste patterns that recur in more than one session (a one-off is the session's finding; a repeat is the stack's), and per-skill cost across sessions where the same skill ran several times.

Then `rm -rf "$TMP"`.

## Privacy rule
The report body carries aggregates, tool names, token counts, and file PATHS only - never code or file contents. The raw-data copies exist for re-analysis and follow the committed-root consent rule above.

## Don't game it
Numbers come from the analyzer's output, never estimated from memory - a claim without an analyzer line behind it does not go in the report. A protocol-check verdict cites the transcript turn that proves it. If the ledger was absent, the identity attribution is marked unavailable rather than inferred. Suggest - once, briefly - that a re-run with `.claude/hooks/instrument-tool-usage.js` wired and `CLAUDE_STACK_INSTRUMENT=1` would add the `--hook-log` join next time; do not block on it.

Diagnosis discipline - the measured failure modes of hand-written analysis (a sweep found 14 wrong or mislabeled claims across 12 shipped reports, including one verdict that inverted its own table):
- Diagnose an error cluster only from the quoted error text, never from counts - hook blocks carry a deterministic `Blocked:` message, a wrong-parameter error names the parameter; grep it before assigning a cause - and attribute COUNTS only after grepping every distinct signature in the cluster, never by generalizing one sampled seat (measured: 88 errors filed under one cause that covered 24; the other 64 carried a different signature).
- An output-volume waste claim splits green from red: a GREEN run's verbose output is waste against the summary-line recipe, a RED run's stack traces and parse errors are the diagnosis - earned cost, never a waste row (measured: 5 of 6 flagged rows were real failure diagnostics from briefs the seats had followed).
- A low-message loop run is judged against the skill's own STOP text in the transcript, never inferred 'incomplete' from message count.
- A per-skill tool claim cites the invocation window (timestamps) the calls fall inside; a blocked Skill attempt is not a run; a Read is 'whole-file' only when its tool_input and any truncation notice say so, and 'file read N times' is not 'content re-read N times' - check the offsets.
- Prose restatements must agree with the report's own tables in the same document; derive protocol verdicts and uncosted-seat lists from the tables (set-difference), never by eyeballing; cite the value at the actual event's timestamp, not a nearby spike.
- Quote file, command, and label names VERBATIM from the tool_use input - a paraphrased label is a fabricated citation (measured: one report cited a symbol name with zero transcript hits); enumerate countable events (commits, mutation probes, verbose runs) from the transcript's own output lines, never from summary memory (measured: 'four logical commits' where the session's own git log printed six).
- A skill firing late in a long session is costed at its WINDOW's ctx-per-message (its own cache-read over its own messages), never glossed with the session-wide average (measured: a 242k window reported as the 171k mean).
- A hook-block claim names the guard whose `Blocked:` text matches; a harness-native tool error (write-before-read, disable-model-invocation refusal, input validation) is NOT a stack hook block - the hook-blk column, not the errors column, is the source (measured: two reports promoted harness errors to 'guard denials').
- An uncovered ledger tail is reported with the COUNT of transcript tool calls inside it - a quiet tail (zero calls) and a real coverage gap read the same in percentages and are different facts.
- NO cross-session superlatives in a per-session report ('largest of the audited set', 'most blocks in the audit') unless the sibling sessions' own analyzer output was loaded and diffed THIS run - route real rankings to SUMMARY.md only (measured: two single-session superlatives were both false - 5th of 22, and 4 blocks against a sibling's 18 - and one propagated into a shipped cross-session summary).
- A waste claim about reads passes four checks first: the same file's hook-blk row (a BLOCKED read delivered zero content - it is not the waste, and its follow-up ranges are the prescribed recovery, measured twice mislabeled); the offsets (non-overlapping ranges are pagination, not re-reads - measured: 'read 3x, ~28k redundant' was zero-overlap tiling of a 941-line file); the content when offsets match (a same-path re-read of a GROWN file that the run then used is not a duplicate - byte-identical or nothing, measured); and the calling skill's own contract (a read its step mandates whole is the contract's cost, not the session's waste - measured three times on the same doc). Truncation flips labels too: a no-offset read cut at the cap is NOT the whole file, and its ranged completion can be the larger result (measured: a report inverted the two and shipped a fix suggestion describing what already happened).
- A gate claim distinguishes an existence CHECK from a WRITE: `ls`/`test -f` output saying 'no receipt' is the receipt's absence, never its creation (measured: a report fabricated two receipt writes from two absence checks, and the phantom stale-stamp risk burned a downstream audit's time).
- Sweep 1 counts MISSING gates, not just fired ones: the analyzer emits unheld-stop candidates (a free-text user turn right after a no-tool end_turn) - check each against the active skill's stop contract before any PASS (measured: five reports stamped 'PASS' while 1-2 unheld stops sat in the transcript).
- Sweep 2 classifies EVERY commit into three buckets - receipted (the gate file written), exempt-trivial (the hook's own bar: 2 files AND 15 lines, judged from the numstat), or ungated - a two-bucket sweep silently promotes exempt commits to violations or hides ungated ones; and checks plan/cycle-note stamps before concluding a step skill 'never ran' - a resumed cycle legitimately re-runs nothing (measured: a report called a correctly-resumed session 'invoked hollow' and suggested skipping the skill).
- The Environment rows you author derive from the AUDITED transcript (its own `version` field - the analyzer now prints it) - and any row describing the analysis run's environment is labeled as such; a cited rule or clause is checked against the audited session's install vintage before 'the session broke rule X' (measured: ~17 reports carried the analyst host's CLI version as the session's; one report blamed a session for a clause that shipped hours after it ran).
- Every hand count states its method inline (which stream, deduped how) so it is reproducible - the harness duplicates content into `toolUseResult` fields and a naive grep double-counts (measured: 'appears 45 times' was 23 or 54 by method, reproducible as neither).
- Verdict-table cells derive from THAT skill's own attributed window (its timestamps, its seats, its metric) - a run-wide total in a seat-type cell, or a row copy-pasted across skills, is a fabricated per-skill claim; print 'n/a' where the skill's contract forbids the metric (measured: three reports reused one skill's cells for another, one crediting a no-dispatch skill with '4 seats dispatched').
- Every transcript measurement carries its locator - the grep/jq command and the matching line number in the bundle's own jsonl - so a checker reproduces it in one paste; and any count past a handful of events comes from a command (`grep -c`, jq), never a hand tally, with the command stated inline (measured: a report asserted 'two tool errors' three times against its own table's 1).
- A 'duplicate read' claim stays inside ONE context: a seat re-reading what the main session read is orientation across a context boundary - the seat never saw the parent's copy - and repeated Reads of the harness's `tasks/*.output` files are background-task polling; neither is waste (both shipped as top waste rows in audited reports).
- Before reporting a skill 'never ran' or a phase 'gap', check the analyzer's companion fold (the `+N via companion loads` clause) - a reference skill loaded in service of a parent shows no row of its own BY DESIGN; the fold is the attribution, not a missing run. The dispatch-window suggestion on stampless seats is likewise citable only as inferred, never charged.
- Every rate names its denominator and cohort ('3 of the 14 main-session Reads'), never a bare percentage.
- The harness's `(Re-invocation ... previously loaded)` marker is not proof of a prior load in THIS session - claim a double-load only when the earlier invocation marker is itself in the transcript (measured: a duplicate-load finding built on the marker alone did not survive the grep).
