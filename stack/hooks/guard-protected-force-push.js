#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// PreToolUse gate: block a force-push or deletion of a protected branch (main / master /
// develop). This is the one git rule in CLAUDE.md that is a deterministic,
// catastrophic, irreversible event - so it is enforced by a hook, not left to
// prose the model can skip. Reads the tool-call JSON on stdin; exit 2 blocks
// (stderr fed back to the model), exit 0 allows.
//
// Scope is deliberately narrow - it fires ~never in normal work. The command is split
// on ;|& into segments (like the rm guard) and `git push` must be a segment's own
// COMMAND - not a substring of another program's argument - so `echo "git push --force"`
// no longer false-positives. It blocks a `git push` that would irreversibly rewrite or
// remove main / master / develop:
//   - a force: -f / --force / --force-with-lease / --force-if-includes, a
//     '+'-prefixed refspec, --mirror (incl. --mirror=<value>), or a forced --all;
//   - a deletion: a `:branch` (empty-source) refspec, or --delete / -d;
//   - named explicitly (refspec, normalized past any refs/heads/ prefix and one
//     layer of surrounding quotes), or a bare force/delete while HEAD is on a
//     protected branch.
// A plain fast-forward push to main, or any force on a feature branch (prefer
// --force-with-lease), is left alone - blocking it would be a false-positive.
// Out of scope (matches the rm guard's honesty): indirection that hides the push
// from a flat token scan - aliases, `eval`, subshells, or git invoked via a
// wrapper script - is NOT caught here; this guard reads the literal command.
'use strict';
const fs = require('fs');
// The docs root env value. CLAUDE_STACK_DOCS_PATH is the name; CLAUDE_DOCS_PATH is the pre-0.2.43
// spelling, still read so a project whose settings.json has not been migrated yet keeps resolving
// (the installers rename the key in place on the next install/update).
const docsRootEnv = () => process.env.CLAUDE_STACK_DOCS_PATH || process.env.CLAUDE_DOCS_PATH || '.claude/docs';
const { execFileSync } = require('child_process');

// A heredoc body is DATA, not shell: a plan or checklist that merely DESCRIBES this command is
// inert text, and matching it blocked a document write for its own prose (reproduced). Blank the
// payload spans, keeping the character count so any index into the command still holds.
const stripHeredocs = (c) => String(c).replace(
  /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
  (m) => m.replace(/[^\n]/g, ' '),
);

// Same segment split as the rm guard - a compound command (`a && git push --force ; b`)
// is inspected segment by segment so `git push` must be a segment's own COMMAND, not a
// substring of another program's argument (no false positive on `echo git push --force`).
const SEPARATORS = /[;|&]{1,2}|\n/;

const PROTECTED = ['main', 'master', 'develop'];
const FORCE_FLAG = /^(?:-f|--force|--force-with-lease|--force-if-includes)(?:=\S*)?$/;

// Strip one layer of surrounding quotes (same shape as the rm guard) so a quoted
// refspec - `git push origin "main" --force` - normalizes to the bare token.
function unquote(tok)
{
    const t = tok.trim();
    if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))))
    {
        return t.slice(1, -1);
    }

    return t;
}

// Branch name from a ref/refspec destination, normalized for the protected check:
// unquote, then drop a leading '+' (force marker) and any 'refs/heads/' prefix.
function normalizeBranch(ref)
{
    return unquote(ref).replace(/^\+/, '').replace(/^refs\/heads\//, '');
}

// Destination side of a refspec: '+src:dst' / 'src:dst' -> 'dst'; 'dst' -> 'dst'.
function refDestination(token)
{
    const ref = unquote(token).replace(/^\+/, '');
    const colon = ref.indexOf(':');

    return colon === -1 ? ref : ref.slice(colon + 1);
}

// Source side of a refspec; '' for a deletion refspec like ':main'.
function refSource(token)
{
    const ref = unquote(token).replace(/^\+/, '');
    const colon = ref.indexOf(':');

    return colon === -1 ? ref : ref.slice(0, colon);
}

// A "bare" push has no explicit refspec - at most the remote (e.g. `git push`,
// `git push origin`, `git push --force`). Such a push targets the current branch.
function isBarePush(tokensAfterPush)
{
    const refs = tokensAfterPush.filter(t => !t.startsWith('-'));

    return refs.length <= 1; // 0 = `git push`, 1 = the remote name only
}

function currentBranch(cwd)
{
    try
    {
        return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
    }
    catch
    {
        return null; // not a repo / detached / git missing -> caller fails open
    }
}

// The tokens of a segment whose COMMAND is `git push`, sliced to those after `push`;
// null if this segment is not a git push. Mirrors the rm guard's command-position
// discipline: skip leading env-assignments and benign prefixes, require `git` (or a
// `.../git` path) as the command and `push` as its subcommand. `git -C dir push` and
// `git -c k=v push` are handled by skipping git's own pre-subcommand options.
function pushArgs(seg)
{
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])
        || tokens[i] === 'sudo' || tokens[i] === 'command' || tokens[i] === 'nice' || tokens[i] === 'time'))
    {
        i++;
    }

    const cmd = tokens[i];
    if (!cmd || !(cmd === 'git' || cmd.endsWith('/git')))
    {
        return null;
    }

    // Walk git's own options/values before the subcommand (`-C dir`, `-c k=v`, `--git-dir=...`).
    let j = i + 1;
    while (j < tokens.length && tokens[j].startsWith('-'))
    {
        const opt = tokens[j];
        j++;
        if ((opt === '-C' || opt === '-c') && j < tokens.length)
        {
            j++; // skip the option's value token
        }
    }

    return tokens[j] === 'push' ? tokens.slice(j + 1) : null;
}

// Block a push that would force-update, delete, or mirror a protected branch.
function isProtectedForcePush(command, cwd)
{
    for (const seg of command.split(SEPARATORS))
    {
        const after = pushArgs(seg);
        if (after === null)
        {
            continue;
        }

        // FORCE_FLAG catches -f / --force / --force-with-lease / --force-if-includes as whole tokens;
        // also catch clustered short flags (-fu, -uf, -fv): single-dash token containing f.
        const hasForceFlag = after.some(t => FORCE_FLAG.test(t))
            || after.some(t => /^-[A-Za-z]*f[A-Za-z]*$/.test(t) && !t.startsWith('--'));
        const hasDeleteFlag = after.includes('--delete') || after.includes('-d');

        // --mirror / --mirror=<value> (and a forced --all) rewrite/prune every remote ref,
        // protected ones included, without naming them - always catastrophic on a shared remote.
        if (after.some(t => t === '--mirror' || t.startsWith('--mirror='))
            || (after.includes('--all') && hasForceFlag))
        {
            return true;
        }

        // Explicit refspec whose destination is a protected branch, when the op is a
        // force ('+' prefix or a force flag) or a delete (--delete/-d, or ':dst').
        // Unquote first so a quoted token - `"main"` or `"+main"` - is read correctly.
        const targets = after.filter(t => !t.startsWith('-') && PROTECTED.includes(normalizeBranch(refDestination(t))));
        for (const t of targets)
        {
            const u = unquote(t);
            if (u.startsWith('+') || hasForceFlag || hasDeleteFlag || refSource(t) === '')
            {
                return true;
            }
        }

        // Bare push targets HEAD's branch - block a force or delete of a protected one.
        if (isBarePush(after) && PROTECTED.includes(currentBranch(cwd)) && (hasForceFlag || hasDeleteFlag))
        {
            return true;
        }
    }

    return false;
}

function main()
{
    let payload;
    try
    {
        payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    }
    catch
    {
        process.exit(0); // can't parse hook input -> don't block on a harness malfunction
    }
    if (!payload || typeof payload !== 'object')
    {
        process.exit(0); // a JSON scalar/null - nothing to judge
    }

    // --- block telemetry (shared by every guard hook; keep the copies identical) ------------
    // A block costs a whole turn - the stderr goes back to the model and the work is re-done - so a
    // FALSE positive is 10-100x the cost of the gate itself, and until this existed the block rate was
    // the one number the stack could not measure (measured 2026-09-04: the hooks emit ~22-25ms and
    // nothing else). One JSONL row per block, written where the tool-usage instrument writes, so
    // scripts/analyze-usage.js can tally both from the same docs root. Best-effort in every direction:
    // telemetry never changes the verdict and never throws.
    (() => {
        let last = '';
        const w = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk, ...rest) => { last = String(chunk); return w(chunk, ...rest); };
        const exit = process.exit.bind(process);
        process.exit = (code) =>
        {
            if (code === 2)
            {
                try
                {
                    const path = require('path');
                    const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
                    // resolve, NOT join: an ABSOLUTE CLAUDE_STACK_DOCS_PATH makes path.join('/a/b','/x/y')
        // '/a/b/x/y', so every ledger row landed in a doubled path that nothing reads (measured
        // across all ten guards). resolve honours an absolute value and still joins a relative one.
        const dir = path.resolve(root, docsRootEnv(), 'hook-blocks');
                    fs.mkdirSync(dir, { recursive: true });
                    fs.appendFileSync(path.join(dir, `${payload.session_id || 'nosession'}.jsonl`), JSON.stringify({
                        ts: new Date().toISOString(),
                        hook: path.basename(__filename),
                        event: payload.hook_event_name || payload.tool_name || '',
                        tool: payload.tool_name || '',
                        reason: last.split('\n')[0].slice(0, 200),
                    }) + '\n');
                }
                catch { /* telemetry is never allowed to break the gate */ }
            }
            exit(code);
        };
    })();

    const command = stripHeredocs(payload?.tool_input?.command ?? '');
    const cwd = payload?.cwd ?? process.cwd();
    if (!isProtectedForcePush(command, cwd))
    {
        process.exit(0);
    }

    process.stderr.write(
        'Rewriting or deleting a shared branch (main/master/develop) is forbidden (CLAUDE.md) - ' +
        'no force-push, branch deletion, or --mirror. Push to a feature branch and open a PR; ' +
        'use --force-with-lease only on your own feature branch.\n');
    process.exit(2);
}

main();
