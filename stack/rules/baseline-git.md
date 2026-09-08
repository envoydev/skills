---
description: House baseline - git, pull requests, and the pre-commit checkpoint. Always-on (no paths), installer-managed - update overwrites local edits.
---

# Git and pull requests

- Conventional Commits - or the ticket-id header shape below; the two are the only valid headers. Branch `<type>/<short-description>` or `<type>/<ticket-id>`.
- Do NOT commit or push until the user explicitly says to - not when a task looks finished, not proactively because it seems done. Show the diff and let them review; commit only on their explicit word, and push only when they ask.
- The scope shown at a commit ask is derived FRESH at ask time - `git add -N . && git diff HEAD --stat` (then `git reset -q`) so untracked files count - never an earlier turn's stat (measured twice: an ask cited a stale stat while the uncommitted set had grown); the same ask names anything still owed on the diff (a gate not yet run, a review skipped) rather than leaving it to a private receipt.
- Never mention yourself: no AI/assistant attribution in commits, branches, or PR text (deliberate override of the platform default).
- One logical change per PR, under 400 LOC. Body: what / why / how to test. Link the ticket; screenshots if UI.
- Squash or rebase, no merge commits on feature branches; prefer `--force-with-lease`. Non-trivial git (rebase, cherry-pick, recovery): know the undo before you run it.

## Commit message shape

- **Header** - the ticket id (`PROJ-142`) or the feature delivered (a Conventional-Commits subject such as `feat(auth): token refresh` counts as the feature). One line.
- Then a blank line, then the body: one short, understandable sentence per thing done, each on its own line, indented two spaces, with NO blank line between them.
- A critical caveat (a constraint a later change must not break, a footgun, a silent tradeoff) goes LAST, after a blank line, indented, prefixed `Critical:`. Omit it when there is none.

```
PROJ-142

  Added a /healthz endpoint to the orders API.
  Wired it into the container readiness probe.
  Updated the deployment runbook.

  Critical: the probe path must stay /healthz or the readiness probe breaks the rollout.
```

## Pre-commit checkpoint

On any non-trivial diff, before committing or presenting: run the formatter, then the house
review `project-verify-code` - model-invocable, so the gate holds in autonomous flows too
(`/code-review` is a user-run parallel sweep, not this gate; `/simplify` applies its quality
findings in place) - plus `/security-review` when the diff touches auth, crypto, secrets,
payment or data-access paths (`baseline-security.md` owns that call), plus any diff gates named
in the project's `CLAUDE.md` - then satisfy the Definition-of-done gate. Findings caught here land in the same
commit; found later they become fixup noise or shipped defects. Skip for typos / one-line /
formatting-only diffs - and for a diff an equivalent-or-stronger check just cleared: the active
quality-loop's own dispatched re-verify plus final gate, or the cross-task flow's domain-verifier
sign-offs plus the `integration-reviewer` final gate (a self-granted skip on any other reasoning
is not this exemption; the security-review half follows `baseline-security.md`'s own carve-out). The review half may also run as a DISPATCHED domain-verifier pass over
exactly this diff - the right call when the session's carried context is already heavy, since the
seat reviews from a clean context - and its sign-off satisfies the checkpoint the same way. Either
way the review is a real invocation THIS session: a receipt claiming 'project-verify-code inline'
with no Skill call in the transcript is a replay from memory, not the gate (measured twice). The formatter half is never skipped, and it must be FRESH: a formatter
run from earlier in the session does not cover files edited since - re-run it after the last
edit, before the commit (measured: one file edited during review and committed on a stale
'I ran it earlier' broke CI's format check and cost a fixup commit). One unformatted
commit is a red CI run and a fixup commit (measured). A quality-loop stage-boundary commit may
exceed the one-logical-change size guidance when its stages share touched files - name the stages
in the commit body rather than splitting an unverifiable diff.

The checkpoint ends by writing its receipt: `<docs-path>/flow/COMMIT-GATE`, five lines -

```
VERIFIED <what was reviewed, one phrase>
authorized: "<the user's words asking for THIS commit, verbatim>"
head: <the sha the review ran against>
spec: <N files - the set it covered>
live-probe: <what was actually run, or NOT RUN - <reason>>
```

(the quality-loop and cross-task gate exemptions count as VERIFIED - name the loop or gate); or
`WAIVED - "<the user's words, verbatim>"` alone on their explicit waiver - 'commit it' is an
instruction to commit, never a waiver of the review. Each line answers a way the receipt was
measured passing while recording nothing: the VERIFIED line proves the review ran, `authorized:`
proves the user asked (a self-written VERIFIED receipt once cleared a commit no user had
requested), `head:` proves it reviewed THIS tree, `spec:` proves it covered the whole diff (one
receipt asserted a 17-file review in which 9 files had been read) and `live-probe:` proves it ran
the thing (one asserted a passing review with no build or test output at all). The quoted words
must carry a commit verb - `authorized: "what time is it?"` used to pass - and must not be an
option label this run wrote: consent given by picking an option is spelled `answered: <the chosen
label>` instead, which is a different claim and reads as one. A review carried from an earlier
cycle says so: `carried: <cycle id>, reviewed <date>`.
Write the receipt as its OWN tool call, before the call that runs `git commit` - the enforcing
hook checks the file at commit time, so a receipt written inside the same compound command is
invisible to a stricter gate and unauditable in the ledger. The shipped hook still ACCEPTS the atomic
write+commit shape (blocking it would reject the receipt discipline itself), so nothing stops you
mechanically - which is exactly why the rule is the binding one: 9 of 13 commits in one audited
session took the atomic shape and two of those left the receipt uncleared. Own-call receipt, then
the commit, then clear it. The `guard-ungated-commit` hook
blocks a non-trivial `git commit` without a fresh receipt
(measured: 8 ungated commit events across 6 audited sessions rode on prose alone). The hook
judges 'trivial' mechanically - at most 2 files and 15 changed lines - so a prose-exempt diff
above that bar (a formatting-only sweep) still writes `VERIFIED` naming the exemption; never
split a real change into small commits to slip under it. Clear the file once the commit lands -
after the LAST commit when one receipt covers a reviewed batch (measured: a batch receipt left
uncleared after 4 commits) - a leftover receipt is the stale-stamp failure the hook's 2h age
cap exists for. A commit in a second tree this session may write (the cross-project guard's own
allowance, for a tree the project owns) gets its own receipt in THAT tree's docs root, written and
cleared the same way; a sibling repo is never committed, branched, pushed or PR'd from
here - its change is a task card under `<docs-path>/cross-project-tasks/`, and it is never OFFERED
as an option in an ask of the run's own making. The one place it IS offered is the guard's own
denial - 'Allow writes into <root> for this session', never the recommended option - and only
because that answer is honoured: it writes the `<docs-path>/flow/CROSS-WRITE-ALLOW` receipt (one
root per line; this session's own, under 8h) that the guard reads before it judges. Measured
before the receipt existed: an ask presented a sibling-repo commit + push + PR as its
`(Recommended)` option, the user took it, and `guard-cross-project-write.js` denied it at the first
git verb - the run recommended a route the stack bans.

**Publishing has the same ceremony.** `git push` and `gh pr merge` are where the work leaves this
machine - other people and CI get it, and a shared branch cannot be un-pushed quietly - so they
carry their own receipt, `<docs-path>/flow/PUSH-GATE`, in the SAME five-line shape - `VERIFIED
<what is being published, one phrase>`, `authorized: "<the user's words asking for THIS publish,
verbatim>"`, `head:`, `spec: <the commit set going out>` and `live-probe:` - or `WAIVED - "<their
words>"`. Only the spec differs in kind: a publish's spec names what LEAVES the machine, not what
is uncommitted here, so it is required and never counted against the working tree. Say what is going out and to which branch, get the answer, write the
receipt as its own call, publish, clear it. `guard-ungated-commit` enforces this half too (measured:
across four audited sessions every push and merge passed every guard - one published unpushed
commits 18 minutes before any receipt existed, another put 40 files on a shared `develop`). A push
that publishes nothing - a dry run, or a branch already level with its upstream - is never gated,
and a repo whose remote is already gated by branch protection or a required review turns the half
off for good with `CLAUDE_STACK_PUSH_GATE=0` in the settings.json env block.
