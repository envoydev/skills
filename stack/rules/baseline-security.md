---
description: House baseline - security. Always-on (no paths), installer-managed - update overwrites local edits.
---

# Security

- Crypto / secret / auth / payment / data-access work: review the diff for vulnerabilities before presenting it. **Do the scoped review yourself, first:** compute `git diff HEAD` (or the staged diff, or `git diff <base>..HEAD` for a range) and apply the vulnerability checklist to exactly that - a read-only general-purpose seat where dispatch exists, inline otherwise, and inline inside a stamped flow where the dispatch guard blocks generic seats. Feed it the FULL change set: `git add -N .` first, so untracked files appear in the diff itself (undo the intent-to-add entries with `git reset -q` after), because a diff-fed review silently skips brand-new files, which are often the most security-relevant code in the change (measured near-miss).
  `/security-review` is the UNBOUNDED route, and the bound is not yours to set: it recomputes a whole-branch diff whatever base it is handed, so an explicit base does not scope it (measured: handed the correct base it returned a ~250-file diff spanning already-reviewed stages). Five measured runs delivered ZERO content while overflowing their injected sections to `<persisted-output>` at 116 KB, 187 KB and 11.3 MB - and one of those was on a branch level with origin with a clean tree at session start, so 'long-lived branch' is not the trigger either. Reach for it only when the whole branch really is the review scope and the diff is small. On these paths the review is
part of the pre-commit checkpoint: the `COMMIT-GATE` receipt (baseline-git) is written `VERIFIED`
only after it ran - an auth-path diff committed on the code review alone shipped unreviewed to a
shared branch (measured). A checkpoint exemption in baseline-git (a loop or cross-task gate that
just cleared the diff) skips this half only when that gate carried a security pass - the
`integration-reviewer` gate does, the quality loop's does not, so a loop diff on these paths still
runs the review before `VERIFIED`.
- Three honesty rules on that path. A skip on 'the diff is test-only' is a claim - verify it from
the diff's own file list and name the carve-out in the close ('security review: skipped - test-only
diff: <paths>'), never a silent unilateral call (measured: stated unilaterally twice in one session).
An inline review is a substantive checklist pass with per-category findings named - a one-line 'no
issues' nod over a secrets-adjacent diff is not a review (measured both ways: the nod, and the
checklist pass that caught real findings). And when the user overrides a security recommendation,
proceed - their call - but the close and any receipt record the override with the risk named and
their words quoted, so the decision is auditable (measured: an override shipped with no recorded-risk
trail).
- Never log PII, tokens, passwords, or full payment data - and a change that WIDENS logging (a
default flipped verbose, a redaction removed, a new sink) is itself security-relevant work riding
the review path above (measured: a logging-default flip shipped unredacted tokens).
- Hardcoded secret found: stop, flag, redact as `<redacted>`, recommend rotation + git-history removal. Never propagate the value into any tool. And the turn does not end on that bullet - it ends on the ask (rotate now / acknowledge and defer), because a discovered exposure stated as prose was abandoned in 3 of 3 measured sessions.
- `permissions.deny` blocks the Read TOOL on secret files (`.env*`, key/cert globs, the account settings.json) and NOTHING else - not a shell `cat`, not a subprocess. Measured: an account carrying `Read(**/config.json)` returned two Bash `cat`s of a config.json unblocked. The rule below is the only thing covering those routes.
- Reading a credential means reading its PRESENCE, never its value: report `SENTRY_ACCESS_TOKEN=set (71 chars)` or `absent`, and check a generated artifact by grepping for the prefix and reporting the count. Never echo the value, never pass a pasted secret to a tool, and never ask for one through the chat - a value that must be set goes into the file by the user's own hand, or by a copy-ready command they run in their terminal. The stack's credential guard mechanizes this: a dump of a file that holds a credential-shaped key (by content, whatever the path), an echo of a credential-shaped variable, a bare `env`, and a credential-shaped literal in a command are blocked, and the guard's own `--presence <file> [KEY ...]` mode is the read - `KEY=set (N chars)` or `KEY=absent`. When the VALUE itself is what the user needs - shown to them, or placed where a blind copy (`jq ... > file`, `cp`, `sed -i`) cannot reach - the block ends in ONE AskUserQuestion ('Presence only' recommended), and a 'show or use it' answer is honoured through the `<docs-path>/flow/SECRET-READ-ALLOW` receipt (a file, a variable name, or `*`; this session only, under 8h): the user decides, the model never does, and a remote user is not left waiting on a terminal they cannot reach.
- When the user does paste a credential anyway, use it for the job they asked for and end the turn on the rotation ask: it is now in the transcript on disk, and that is a fact the user has to decide about, not one to leave unsaid.

<!-- Maintainer note: extend the deny list in settings.json with the stack's own secret/config globs. -->
