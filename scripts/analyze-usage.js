#!/usr/bin/env node
'use strict';

// analyze-usage.js - offline token/tool consumption report for a Claude Code session.
//
// Why: hooks see WHO fired (instrument-tool-usage.js) but can never see tokens - token
// accounting lives per API message in the transcript JSONL Claude Code already writes.
// This script mines that transcript (plus the session's subagents/ directory) and emits
// the consumption report an agent-flow tuning pass needs: tokens by scope and model,
// exact per-dispatch subagent cost, skill/MCP/tool call+result volume, context-growth
// spikes, and an optional join against an instrument-tool-usage.js hook log.
//
// Usage:
//   node scripts/analyze-usage.js <session.jsonl>                  # full report for one session
//   node scripts/analyze-usage.js <projects-dir>                   # one-line rollup per session
//   node scripts/analyze-usage.js <session.jsonl> --hook-log <f>   # join a <docs-path>/tools-usage/<sid>.jsonl ledger
//   node scripts/analyze-usage.js <session.jsonl> --hook-blocks <d> # per-HOOK block counts from <docs-path>/hook-blocks/
//   node scripts/analyze-usage.js <session.jsonl> --json           # machine-readable dump
//   node scripts/analyze-usage.js <session.jsonl> --report-md      # markdown report skeleton (machine tables + FILL IN sections)
//   node scripts/analyze-usage.js <s.jsonl> --from <ISO> --to <ISO> # window one run inside a long session
//   node scripts/analyze-usage.js <s.jsonl> --docs-root <path>     # extra docs prefix when CLAUDE_STACK_DOCS_PATH is non-default
//
// The headline health signal is ctx/msg (avg context re-sent per API call = input +
// cache-write + cache-read over msgs): high tool-result volume means noisy tools, but a
// high ctx/msg means carried-forward conversation - the cost driver windowing isolates.
//
// Transcripts live under ~/.claude/projects/<encoded-project-path>/: the main session is
// <session-id>.jsonl, its dispatched subagents under <session-id>/subagents/agent-*.jsonl
// (+ .meta.json with agentType/description/toolUseId). Facts this parser relies on,
// verified against real transcripts: one API response is split across several assistant
// lines that each repeat the same message.id with usage that is IDENTICAL (main session)
// or a PROGRESSIVE streaming snapshot (subagent files: output_tokens grows 4 -> 9579
// across lines) - so usage is folded as an elementwise max per message.id, never summed
// per line and never first-wins; tool_use ids are globally unique; assistant lines carry
// attributionSkill/attributionPlugin while a skill is active; result sizes are measured
// in chars and reported as ~tokens (chars/4) - approximate, oversized results may be
// offloaded to tool-results/ and undercount.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------- small helpers ----------

const fmt = (n) => {
  if (n == null) return '-';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};
const approxTok = (chars) => Math.round(chars / 4);
const dur = (ms) => {
  if (!ms || ms < 0) return '-';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const pad = (s, w) => String(s).length >= w ? String(s) : String(s) + ' '.repeat(w - String(s).length);
const rpad = (s, w) => String(s).length >= w ? String(s) : ' '.repeat(w - String(s).length) + String(s);

function newTally() { return { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, msgs: 0 }; }
const ctxOf = (t) => (t.msgs ? Math.round((t.input + t.cacheCreate + t.cacheRead) / t.msgs) : 0);
function addUsage(t, u) {
  t.input += u.input_tokens || 0;
  t.cacheCreate += u.cache_creation_input_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.msgs += 1;
}
function mergeTally(a, b) {
  a.input += b.input; a.cacheCreate += b.cacheCreate; a.cacheRead += b.cacheRead;
  a.output += b.output; a.msgs += b.msgs;
}

function readJsonl(file, onObj) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file) });
    rl.on('line', (l) => { try { onObj(JSON.parse(l), l); } catch { /* skip broken line */ } });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// ---------- generated-docs consumption ----------
// The capture skills' whole value claim is that seats READ these docs instead of
// re-deriving the project - so consumption is a first-class signal, not a grep afterthought.
// Style delivery is counted via stable marker phrases: the generated project-code-style
// rule's heading (current mechanism - see the skill's code-style-rule template) and the
// retired inject-code-style hook's injected preamble (legacy sessions).

const STYLE_RULE_MARKER = 'the project-code-style-analyzer skill owns this rule';
const STYLE_INJECT_MARKER = 'maintained by the project-code-style-analyzer';
const docsPrefixes = ['/.claude/docs/'];

function docRelPath(filePath) {
  for (const p of docsPrefixes) {
    const i = filePath.indexOf(p);
    if (i >= 0) return filePath.slice(i + p.length);
  }
  return null;
}

// ---------- transcript analysis (main session or one subagent) ----------

// ---------- one quoted-span-and-heredoc discipline, four consumers ----------
// The same root defect appeared in the commit guard, the publish guard, this script's commit
// counter and this script's doc matcher: a literal sitting inside PROSE - a heredoc body, a quoted
// string - read as an invocation. Here it manufactured `git commits 12` for a session that made
// ZERO, and phantom `flow/COMMIT-GATE` writes, which is the exact fact a protocol check turns on
// (patched replay of the doc table: 61 rows -> 24).
//
// A heredoc body is DATA when it goes to `cat > file` and CODE when it is fed to an interpreter,
// so only the first kind is masked - blanking both would erase the python doc writes that reach a
// file from inside a heredoc, which is how this script sees batched doc I/O at all.
const INTERP_RE = /\b(?:python[\d.]*|node|nodejs|ruby|perl|php|deno|bun|osascript|pwsh|powershell)\b/;
function maskHeredocs(cmd) {
  return String(cmd).replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    (m, _q, _tag, off, whole) => {
      const header = whole.slice(whole.lastIndexOf('\n', off) + 1, off);
      if (INTERP_RE.test(header)) return m;               // an inline script - real code
      const nl = m.indexOf('\n');
      return nl === -1 ? m : m.slice(0, nl) + m.slice(nl).replace(/[^\n]/g, ' ');
    },
  );
}
// Length-preserving and NON-space, so a masked span stays one opaque argument token rather than
// dissolving the command around it (that is what un-gated `git -C "<dir>" commit` in the guard).
const maskQuoted = (cmd) => String(cmd)
  .replace(/'[^'\n]*'/g, (m) => m.replace(/[^\n]/g, 'x'))
  .replace(/"[^"\n]*"/g, (m) => m.replace(/[^\n]/g, 'x'));

async function analyzeTranscript(file, window) {
  const s = {
    file,
    total: newTally(),
    byModel: {},                 // model -> tally
    toolCalls: {},               // tool name -> { calls, resultChars, errors }
    skillInvocations: {},        // skill slug -> { calls, injectedChars }
    skillAttribution: {},        // skill slug -> { msgs, output }
    mcp: {},                     // server -> { calls, resultChars, errors, tools: {tool: n} }
    agentDispatches: [],         // Agent/Task tool_use in THIS transcript: {id, desc, subagentType}
    docTouches: {},              // <docs-root>-relative path -> { reads, writes }
    styleRuleAttaches: 0,        // generated project-code-style rule attachments seen in this transcript
    styleInjections: 0,          // legacy inject-code-style hook firings seen in this transcript
    userPrompts: 0,
    compactions: 0,
    compactionEvents: [],        // { ts, pre, post, dropped, durationMs } - one row per compaction
    stopHookBlocks: 0,           // Stop-hook denials: an isMeta user STRING, invisible to is_error
    denialsByHook: {},           // hook file name (or '(unattributed)') -> denials attributed to it
    peakCtx: 0,                  // largest per-message context carried, and where
    peakCtxAt: null,
    floorCtx: 0,                 // smallest per-message context = the standing inventory
    modelIdsFull: [],            // model ids WITH their window suffix, from cost-state
    totalCostUSD: null,
    thinkingTokens: 0,           // from cost-state.modelUsage - unattributable to any one message
    commandInvocations: {},      // slash-command name -> count (from <command-name> markers)
    apiErrors: 0,
    apiErrorEvents: [],          // { ts, ctx } - the context level each API error fired at
    firstTs: null,
    lastTs: null,
    spikes: [],                  // top context jumps: {ts, delta, ctx, causes}
    toolCallTs: [],              // one timestamp per tool_use - lets the hook-log join count only in-window calls
    skillTimeline: [],           // { ts, skill|null } - stamp changes in THIS transcript; lets
                                 // the report suggest (never charge) a skill for seats whose
                                 // own transcripts carry no stamp, from their dispatch window
  };
  const msgReg = new Map();       // message.id -> {model, skill, carried, u:{in,cc,cr,out}} folded max per field
  const seenToolUse = new Set();  // tool_use id dedup across duplicated assistant lines
  const toolById = new Map();
  // doc writes seen in a Bash command, tallied only once the result shows it executed
  const pendingDocTouch = new Map();     // tool_use id -> { name, skill }
  const pendingGitActs = new Map();      // tool_use id -> { commits, merges } - released on a non-error result
  const promptParents = new Set();       // parentUuid of a counted user turn - siblings are the same turn
  // The ["…/hooks/<file>.js"] bracket is an ATTRIBUTION signal, never the test for a denial: the
  // JSON permission-decision route carries no bracket at all. An unattributable denial still counts,
  // it just lands in its own bucket - the transcript alone records which TOOL was denied, never
  // which hook, and that is the whole reason the hook-block ledger exists.
  const attributeDenial = (text) => {
    const m = /\["?[^"\]]*\/hooks\/([A-Za-z0-9._-]+\.js)"?\]/.exec(text);
    const key = m ? m[1] : '(unattributed)';
    s.denialsByHook = s.denialsByHook || {};
    s.denialsByHook[key] = (s.denialsByHook[key] || 0) + 1;
  };
  let prevCtx = null;
  let pending = [];               // tool results since the previous counted assistant msg
  // One real compaction emits TWO lines (a system compactMetadata + a user isCompactSummary,
  // ms apart) - counting both doubled the number in four audited bundles. Count boundaries;
  // fall back to summaries only for a transcript that carries no boundary lines at all.
  let compactMeta = 0, compactSummary = 0;
  // attributionSkill drops to undefined at an async task-notification and never recovers for
  // the rest of a run (measured: ~2h of one skill's session unattributed). Carry the last
  // stamp forward - reset at a compaction or a new slash command - and count carried msgs
  // separately so the report can say how much attribution is inferred vs stamped.
  let lastSkill = null;
  // A skill invoked within a few messages of another skill's own invocation is that skill's
  // in-protocol reference load (a reviewer loading the house style skill), not a new phase.
  // Without this the stamp switches to the companion and the parent's whole run is
  // misattributed (measured: a review that caught 2 MATERIAL findings shipped in a report
  // as '1 msg - not a review pass of substance').
  const companionOf = {};          // skill -> the parent skill it was loaded in service of
  let activeInvoke = null;         // { skill, msgs } - last non-companion Skill call + msgs since
  let askSinceInvoke = false;      // an AskUserQuestion between the parent invoke and a Skill
                                   // call means the user gated a NEW phase - never fold it as
                                   // a companion (measured: a post-gate flow folded into the
                                   // ask-side skill and reported as its cost)
  let lastToolName = null;         // attributes isMeta skill-body injections to spike causes
  let prevAssistantNoTool = null;  // ts of an end_turn assistant msg with no tool_use
  s.gitCommits = 0; s.prMerges = 0; s.clearTs = null; s.ccVersion = null;
  s.unheldStopCandidates = [];     // { stopTs, userTs } - free-text user turn right after a
                                   // no-tool end_turn: candidate unheld gate for the report's
                                   // protocol sweep (measured: 5 reports stamped PASS over these)

  await readJsonl(file, (o, raw) => {
    if (window && o.timestamp) {
      const ts = Date.parse(o.timestamp);
      if ((window.from != null && ts < window.from) || (window.to != null && ts > window.to)) return;
    }
    // An ATTACHMENT is context the session paid for and the accumulator never saw: the largest
    // spike in one bundle printed as '(prompt/attachment only)' with no cause at all, because
    // attachment records never entered `pending`. A file the session itself edited comes back as
    // an attachment too (`edited_text_file`), which an install RUN generates by the dozen.
    if (o.type === 'user' && Array.isArray(o.attachments)) {
      for (const at of o.attachments) {
        const body = typeof at === 'string' ? at : JSON.stringify(at || '');
        pending.push({ name: `attachment:${(at && at.type) || 'text'}`, chars: body.length });
      }
    }
    if (raw.includes(STYLE_RULE_MARKER)) s.styleRuleAttaches++;
    if (raw.includes(STYLE_INJECT_MARKER)) s.styleInjections++;
    if (o.timestamp) { if (!s.firstTs) s.firstTs = o.timestamp; s.lastTs = o.timestamp; }
    if (!s.ccVersion && o.version) s.ccVersion = o.version;
    // `cost-state` is a record in this same file, and it is the ONLY place two facts survive:
    // the THINKING tokens (billed, attributable to no single message - 86,346 in one session, with
    // all 116 thinking blocks empty, so spike residuals could never be closed), and the model id
    // WITH its window suffix (`claude-opus-5[1m]`) - every assistant message strips it, and the
    // fresh-session threshold is chosen by exactly that suffix.
    if (o.type === 'cost-state' && o.modelUsage) {
      // the record is CUMULATIVE and written more than once per session - take the largest,
      // so a resume that restarts the counter cannot shrink the total
      const think = Object.values(o.modelUsage).reduce((n, v) => n + ((v && v.thinkingTokens) || 0), 0);
      if (think > s.thinkingTokens) s.thinkingTokens = think;
      for (const id of Object.keys(o.modelUsage)) if (!s.modelIdsFull.includes(id)) s.modelIdsFull.push(id);
      if (o.totalCostUSD != null && (s.totalCostUSD == null || o.totalCostUSD > s.totalCostUSD)) s.totalCostUSD = o.totalCostUSD;
    }
    if (o.compactMetadata) {
      compactMeta++;
      // The metadata was read and only a COUNT was printed - 738,247 dropped tokens and 4m02s of
      // wall clock discarded across one session's compactions, the single largest unexplained
      // number in several reports.
      const cm = o.compactMetadata;
      const pre = cm.preTokens ?? cm.preCompactTokens ?? null;
      const post = cm.postTokens ?? cm.postCompactTokens ?? null;
      s.compactionEvents.push({
        ts: o.timestamp || null,
        pre,
        post,
        dropped: pre != null && post != null ? pre - post : null,
        durationMs: cm.durationMs ?? cm.duration ?? null,
        trigger: cm.trigger || null,
      });
      if (lastSkill) s.skillTimeline.push({ ts: o.timestamp || null, skill: null });
      lastSkill = null;
    }
    if (o.isCompactSummary) compactSummary++;
    // Record the context level each API error fired at - reports guessed at causes when
    // errors clustered at high ctx (measured: 22 errors at ~200k ctx read as flakiness).
    if (o.isApiErrorMessage) { s.apiErrors++; s.apiErrorEvents.push({ ts: o.timestamp || null, ctx: prevCtx }); }
    // Count slash commands only from the session's OWN user turns - the old whole-line scan
    // also matched markers quoted inside tool_result payloads (measured: a foreign session's
    // /exit surfaced as this session's own invocation in two bundles), and a non-global
    // match dropped every marker after the first on a line.
    if (o.type === 'user' && o.message && raw.includes('<command-name>')) {
      const own = typeof o.message.content === 'string' ? o.message.content
        : Array.isArray(o.message.content) ? o.message.content.filter((c) => c.type === 'text').map((c) => c.text || '').join('\n') : '';
      // A LEADING SPACE inside the tag suppressed the match, and a whole guided-command run then
      // charged its ~2.75M to the previous command's window instead of appearing in the SKILLS
      // table at all.
      for (const m of own.matchAll(/<command-name>\s*\/?\s*([A-Za-z0-9_:-]+)\s*<\/command-name>/g)) {
        s.commandInvocations[m[1]] = (s.commandInvocations[m[1]] || 0) + 1;
        if (lastSkill) s.skillTimeline.push({ ts: o.timestamp || null, skill: null });
        lastSkill = null; // a new slash command ends the previous skill's carry-forward
        // A slash command opens a companion window too: a reference skill loaded in its
        // first messages serves the command, not a phase of its own (measured: a style
        // skill loaded by a command's step charged as a standalone run).
        // `/clear` is a harness reset, not a skill: opening a window for it parks the whole
        // session's real work under a phantom `clear` row and glues the genuine skills onto it
        // as companions (measured: 4 sessions, one with 62 of 71 messages mis-bucketed).
        activeInvoke = m[1] === 'clear' ? null : { skill: m[1], msgs: 0 };
        askSinceInvoke = false;
        // A mid-file /clear starts a new working window: raw first->last spans across it
        // read as a multi-day session at ~6% ledger coverage when the real work window was
        // ~89 min at ~96% (measured) - record the boundary so printers can show both.
        if (m[1] === 'clear' && o.timestamp) s.clearTs = o.timestamp;
      }
    }

    if (o.type === 'assistant' && o.message) {
      const m = o.message;
      // usage: fold as max per field per message.id (duplicate lines repeat identical
      // usage in main sessions but progressive streaming snapshots in subagent files)
      if (m.usage && m.id && m.model !== '<synthetic>') {
        if (o.attributionSkill) {
          if (o.attributionSkill !== lastSkill) s.skillTimeline.push({ ts: o.timestamp || null, skill: o.attributionSkill });
          lastSkill = o.attributionSkill;
        }
        let r = msgReg.get(m.id);
        if (!r) {
          r = { model: m.model, skill: o.attributionSkill || lastSkill || null, carried: !o.attributionSkill && !!lastSkill, u: { in: 0, cc: 0, cr: 0, out: 0 } };
          msgReg.set(m.id, r);
          if (activeInvoke) activeInvoke.msgs += 1;
          // context size is fixed at message start, so first sighting is exact for spikes
          const ctx = (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
          // PEAK context, not just the last one: every threshold in the stack keys off the largest
          // per-message context a session carried, and reports that quoted the final message
          // understated it by 17-43% (10 confirmations).
          if (ctx > s.peakCtx) { s.peakCtx = ctx; s.peakCtxAt = o.timestamp || null; }
          // The COLD FLOOR: the smallest context any message carried is the standing inventory -
          // system prompt, tool schemas, CLAUDE.md, the always-on rules - paid on every single
          // message and re-paid in full after every compaction. Measured at 3.7%-86.8% of a
          // session's cache-read and 23-48% of its own floor, and no report had a row for it.
          if (ctx > 0 && (s.floorCtx === 0 || ctx < s.floorCtx)) s.floorCtx = ctx;
          if (prevCtx != null && ctx - prevCtx > 0) {
            s.spikes.push({ ts: o.timestamp, delta: ctx - prevCtx, ctx, causes: summarizeCauses(pending) });
          } else if (prevCtx != null && (m.usage.cache_creation_input_tokens || 0) > 20000) {
            // Right after a compaction the context DROPS, so a re-cache of the rebuilt prompt has a
            // negative delta and never entered the accumulator - 279,885 tokens, 17.2% of one
            // session's whole cache-write, invisible. Keyed on the write itself, not the delta.
            s.spikes.push({
              ts: o.timestamp,
              delta: m.usage.cache_creation_input_tokens || 0,
              ctx,
              kind: 'cache-write',
              causes: summarizeCauses(pending) || 'prompt re-cached after a context reset',
            });
          }
          s.spikes.sort((a, b) => b.delta - a.delta);
          if (s.spikes.length > 5) s.spikes.length = 5;
          prevCtx = ctx; pending = [];
        }
        r.u.in = Math.max(r.u.in, m.usage.input_tokens || 0);
        r.u.cc = Math.max(r.u.cc, m.usage.cache_creation_input_tokens || 0);
        r.u.cr = Math.max(r.u.cr, m.usage.cache_read_input_tokens || 0);
        r.u.out = Math.max(r.u.out, m.usage.output_tokens || 0);
        if (o.attributionSkill && (!r.skill || r.carried)) { r.skill = o.attributionSkill; r.carried = false; }
      }
      if (Array.isArray(m.content)) for (const c of m.content) {
        if (c.type !== 'tool_use' || seenToolUse.has(c.id)) continue;
        seenToolUse.add(c.id);
        if (o.timestamp) s.toolCallTs.push(o.timestamp);
        const t = s.toolCalls[c.name] || (s.toolCalls[c.name] = { calls: 0, resultChars: 0, errors: 0 });
        t.calls += 1;
        if (c.input && typeof c.input.file_path === 'string') {
          const rel = docRelPath(c.input.file_path);
          if (rel) {
            const d = s.docTouches[rel] || (s.docTouches[rel] = { reads: 0, writes: 0 });
            if (c.name === 'Read') d.reads += 1;
            else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name)) d.writes += 1;
          }
        }
        const info = { name: c.name };
        if (c.name === 'Skill' && c.input && c.input.skill) {
          info.skill = c.input.skill;
          const sk = s.skillInvocations[c.input.skill] || (s.skillInvocations[c.input.skill] = { calls: 0, injectedChars: 0 });
          sk.calls += 1;
          if (activeInvoke && activeInvoke.skill !== c.input.skill && activeInvoke.msgs <= 5 && !askSinceInvoke) {
            if (!companionOf[c.input.skill]) companionOf[c.input.skill] = activeInvoke.skill;
          } else {
            activeInvoke = { skill: c.input.skill, msgs: 0 };
            askSinceInvoke = false;
          }
        } else if (c.name.startsWith('mcp__')) {
          const server = c.name.split('__')[1] || '?';
          const mc = s.mcp[server] || (s.mcp[server] = { calls: 0, resultChars: 0, errors: 0, tools: {} });
          mc.calls += 1;
          const tool = c.name.split('__').slice(2).join('__') || '?';
          mc.tools[tool] = (mc.tools[tool] || 0) + 1;
        } else if ((c.name === 'Agent' || c.name === 'Task') && c.input) {
          s.agentDispatches.push({ id: c.id, desc: c.input.description || null, subagentType: c.input.subagent_type || null });
        }
        if (c.name === 'Bash' && c.input && typeof c.input.command === 'string') {
          const cmdStr = c.input.command;
          // Deterministic counters the report's protocol sweeps previously had no number for
          // (measured: '0 git commits' shipped against 3 commits + a PR merge; occurrence
          // counting, not per-call, since one Bash call can carry two commits).
          // A heredoc body is DATA: a plan file or receipt that merely describes `git commit`
          // is not an invocation. Counting it reported 13 commits where 8 ran, 4 where 1 ran,
          // and 4 where NONE ran (measured across 3 bundles) - blank the payload before counting.
          const cmdShell = maskHeredocs(cmdStr);
          // The COUNTERS need the quoted spans gone too, and the match has to OPEN a segment: every
          // phantom commit in the corpus was a quoted string, one of them inside a command the
          // harness had DENIED (worst case: 12 commits reported against 0 real). Held until the
          // paired tool_result proves the call ran, the same way the doc touches are.
          const cmdCode = maskQuoted(cmdShell);
          const commits = (cmdCode.match(/(?:^|[;&|(]\s*)git\s+(?:-[\w-]+(?:[= ]\S+)?\s+)*commit\b/g) || []).length;
          const merges = (cmdCode.match(/(?:^|[;&|(]\s*)gh\s+pr\s+merge\b/g) || []).length;
          if (commits || merges) pendingGitActs.set(c.id, { commits, merges });
          // Doc traffic routed through Bash (heredocs, printf >, rm -f) is real doc I/O the
          // Write/Edit-only counter missed - a receipt written+cleared via Bash showed
          // writes:0, and batched python doc writes showed writes:0 across 3 rewrites (measured).
          // Classified PER OCCURRENCE against its own command segment, write only when the
          // redirect/rm/tee TARGETS that path, once per call per doc - the whole-command
          // check stamped every doc in a `cat A && rm B` as written, counted a `2>/dev/null`
          // as the write signal, and re-counted one doc per prose mention (measured: a
          // single receipt write reported as 5 writes across 2 docs).
          {
            // A write the harness DENIED never happened: the classifier-blocked attempts still
            // counted, reporting 3 writes where 1 executed (measured). The result for this call
            // decides - an is_error result means nothing was written.
            const touched = new Map();
            for (const seg of cmdShell.split(/&&|\|\||;|\n/)) {
              for (const pm of seg.matchAll(/(?:^|[\s"'`=(])((?:[^\s"'`;|&)]*\/)?\.claude\/docs\/[^\s"'`;|&)]+)/g)) {
                const p = pm[1].replace(/[/:,.]+$/, ''); // a trailing separator is punctuation, not the name
                if (p.includes('$')) continue; // unexpanded variable - not a literal doc path
                if (/[*?\[]/.test(p)) continue; // a GLOB names no one document
                const rel = p.slice(p.indexOf('.claude/docs/') + '.claude/docs/'.length);
                // Only a DOCUMENT: keying on every token under the docs root produced 79 rows for
                // ~6 real documents - directories, globs and trailing punctuation each got a row.
                if (!rel || !/\.md$/i.test(rel)) continue;
                // An ASSIGNMENT is neither a read nor a write; it was counted as a read in 35 of 72
                // occurrences. Only the varWrite check below can turn a binding into a write.
                const assigned = pm[0][0] === '=';
                const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // A python write reaches the file three ways and only one names the path inside
                // open(): `open("<path>","w")`, `p = "<path>" ... open(p,"w")`, and
                // `Path("<path>").write_text(...)`. Counting only the first read a real write as a
                // READ in 3 audited bundles (a doc reported 0 writes against 6 real edits), so the
                // variable binding and the pathlib form are matched too.
                // The binding and its use sit on DIFFERENT lines of a python heredoc, so both
                // checks run against the whole command, not the segment the path appeared in.
                const varBound = new RegExp(`(\\w+)\\s*=\\s*(?:pathlib\\.)?(?:Path\\()?["'\`][^"'\`]*${esc}`).exec(cmdStr);
                const varWrite = varBound
                  ? new RegExp(`open\\(\\s*${varBound[1]}\\s*,[^)]*["']w["']|\\b${varBound[1]}\\.write_(text|bytes)\\(|\\bio\\.open\\(\\s*${varBound[1]}\\s*,[^)]*["']w["']`).test(cmdStr)
                  : false;
                // `rm` CLEARS a receipt - counting it as a write reported a written document that
                // was in fact deleted; and `mkdir -p <dir>` is neither read nor write of a document.
                const cleared = new RegExp(`\\brm\\s+(?:-\\w+\\s+)*["']?${esc}`).test(seg);
                const made = new RegExp(`\\bmkdir\\s+(?:-\\w+\\s+)*["']?${esc}`).test(seg);
                const isWrite = varWrite || new RegExp(`(>>?\\s*["']?${esc})|(\\btee\\s+(?:-a\\s+)?["']?${esc})|(open\\([^)]*${esc}[^)]*["']w["'])|(${esc}["'\`]?\\s*\\)?\\.write_(text|bytes)\\()`).test(seg);
                const e = touched.get(rel) || { r: false, w: false, c: false };
                if (isWrite) e.w = true;
                else if (cleared) e.c = true;
                else if (!made && !assigned) e.r = true;
                touched.set(rel, e);
              }
            }
            // Held until the paired tool_result proves the command actually ran (below).
            if (touched.size) pendingDocTouch.set(c.id, [...touched.entries()]);
          }
        }
        if (c.name === 'AskUserQuestion') askSinceInvoke = true;
        toolById.set(c.id, info);
        lastToolName = c.name;
      }
      const hasToolUse = Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_use');
      if (hasToolUse) prevAssistantNoTool = null;
      else if (m.stop_reason === 'end_turn') prevAssistantNoTool = o.timestamp || prevAssistantNoTool;
    }

    if (o.type === 'user' && o.message) {
      const content = o.message.content;
      // Harness-injected user turns (task notifications, system reminders) are not the
      // person typing: counting them inflated userPrompts and manufactured unheld-stop
      // candidates out of background-task completions (measured: a clean session reported
      // 1 candidate whose 'user turn' was a task-notification landing after the close).
      // The harness's own UserPromptSubmit hook already implements the right discriminator, and it
      // is a POSITIVE one: origin.kind === 'human'. Counting by exclusion list inflated the prompt
      // count by up to 500% across 12 bundles - it missed <command-name>, <local-command-stdout>,
      // isCompactSummary, and the sibling records one typed turn produces. The list stays as the
      // fallback for a transcript generation that carries no origin.
      const isInjectedText = (txt) => (o.origin
        ? o.origin.kind !== 'human'
        : /^\s*<(task-notification|system-reminder|teammate-message|background-task|command-message|command-args|local-command-stdout|local-command-stderr)\b/.test(txt))
        || o.isCompactSummary === true;
      // One typed turn can emit several user records sharing a parentUuid (the command marker, its
      // message, its stdout). The first one counts; the rest are the same turn.
      const firstOfTurn = () => {
        if (!o.parentUuid) return true;
        if (promptParents.has(o.parentUuid)) return false;
        promptParents.add(o.parentUuid);
        return true;
      };
      if (typeof content === 'string') {
        // A Stop-hook denial arrives as an isMeta user STRING with no tool_result, so it is
        // structurally invisible to the is_error path below: one report printed 'Hook blocks - 4'
        // against 6 and then named both Stop blocks two paragraphs later.
        if (/^\s*Stop hook feedback:/.test(content)) {
          s.stopHookBlocks = (s.stopHookBlocks || 0) + 1;
          attributeDenial(content);
        }
        if (!o.isMeta && !isInjectedText(content) && firstOfTurn()) {
          s.userPrompts++;
          if (prevAssistantNoTool) { s.unheldStopCandidates.push({ stopTs: prevAssistantNoTool, userTs: o.timestamp || null }); prevAssistantNoTool = null; }
        }
        return;
      }
      if (!Array.isArray(content)) return;
      // A Skill call's tool_result is a tiny stub; the skill BODY lands as an isMeta text
      // injection right after it. Without this a spike's cause line credited the ~18-token
      // stub while the ~4k-token body drove the jump (measured: cause off by 2 orders).
      if (o.isMeta && lastToolName === 'Skill') {
        const bodyChars = content.filter((c) => c.type === 'text').reduce((n, c) => n + (c.text || '').length, 0);
        if (bodyChars > 500) pending.push({ name: 'skill-body', chars: bodyChars });
      }
      let hasResult = false;
      for (const c of content) {
        if (c.type !== 'tool_result') continue;
        hasResult = true;
        // An image block is base64: measuring it as text put a shipped report's headline cost
        // 46x over the truth (353.2k claimed vs 7,756 actually billed, read off the next turn's
        // cache_creation). Images are counted separately and never enter the chars/4 estimate.
        const parts = Array.isArray(c.content) ? c.content : null;
        const imgs = parts ? parts.filter((b) => b && b.type === 'image').length : 0;
        const textParts = parts ? parts.filter((b) => !b || b.type !== 'image') : c.content;
        const text = typeof textParts === 'string' ? textParts : JSON.stringify(textParts || '');
        const chars = text.length;
        if (imgs) s.imageResults = (s.imageResults || 0) + imgs;
        const info = toolById.get(c.tool_use_id);
        pending.push({ name: info ? info.name : '?', chars });
        if (!info) continue;
        const t = s.toolCalls[info.name];
        // A PreToolUse guard denial is the gate WORKING, not a tool failure - bucketing them
        // as errors made reports call a working gate 'the session's weak point' (measured in
        // three bundles: 124/132, 14/14 and 15/15 'Read errors' were all guard blocks).
        // Match the whole guard family by its shared 'Blocked' word - enumerating two messages
        // missed the commit/rm/force-push/sleep variants and split one session's denials into 22
        // 'errors' + 12 blocks when all 34 were gate denials (measured). The COLON is not part of
        // the contract: two real denials read '... Blocked because no receipt. Do NOT retry this
        // command yet.' and arrive by the JSON permission-decision route with no hooks bracket at
        // all, so requiring either would newly hide a whole class of real blocks.
        const isHookBlock = c.is_error && (/\bBlocked\b/.test(text) || /\bDo NOT retry\b/i.test(text));
        if (isHookBlock) attributeDenial(text);
        const held = pendingDocTouch.get(c.tool_use_id);
        if (held) {
          pendingDocTouch.delete(c.tool_use_id);
          for (const [rel, e] of held) {
            // An occurrence that classified as NOTHING - a bare `VAR=<path>` binding, a `mkdir` of
            // its directory - must not open a row: an all-zero row is one of the 79 the report
            // printed for ~6 real documents.
            if (!e.w && !e.c && !e.r) continue;
            const d = s.docTouches[rel] || (s.docTouches[rel] = { reads: 0, writes: 0 });
            if (e.w && !c.is_error) d.bashWrites = (d.bashWrites || 0) + 1;
            else if (e.w && c.is_error) d.bashWritesDenied = (d.bashWritesDenied || 0) + 1;
            if (e.c && !c.is_error) d.cleared = (d.cleared || 0) + 1;
            if (e.r && !e.w && !e.c) d.bashReads = (d.bashReads || 0) + 1;
          }
        }
        const acts = pendingGitActs.get(c.tool_use_id);
        if (acts) {
          pendingGitActs.delete(c.tool_use_id);
          if (!c.is_error) { s.gitCommits += acts.commits; s.prMerges += acts.merges; }
        }
        // A DECLINE is the user answering the question, not a tool failure: reports read
        // "The user doesn't want to proceed" as an error and called a working ask a weak point.
        const isDecline = c.is_error && /\buser (?:doesn'?t want to proceed|declined|chose not)\b/i.test(text);
        if (t) {
          t.resultChars += chars;
          if (isHookBlock) t.hookBlocks = (t.hookBlocks || 0) + 1;
          else if (isDecline) t.declines = (t.declines || 0) + 1;
          else if (c.is_error) t.errors += 1;
        }
        if (info.skill) s.skillInvocations[info.skill].injectedChars += chars;
        if (info.name.startsWith('mcp__')) {
          const mc = s.mcp[info.name.split('__')[1] || '?'];
          if (mc) { mc.resultChars += chars; if (c.is_error) mc.errors += 1; }
        }
      }
      const textJoined = content.filter((c) => c.type === 'text').map((c) => c.text || '').join('\n');
      if (/^\s*Stop hook feedback:/.test(textJoined)) {
        s.stopHookBlocks = (s.stopHookBlocks || 0) + 1;
        attributeDenial(textJoined);
      }
      if (!hasResult && !o.isMeta && textJoined.trim() && !isInjectedText(textJoined) && firstOfTurn()) {
        s.userPrompts++;
        if (prevAssistantNoTool) { s.unheldStopCandidates.push({ stopTs: prevAssistantNoTool, userTs: o.timestamp || null }); prevAssistantNoTool = null; }
      }
    }
  });

  // finalize the folded per-message usage into the tallies; companion skills fold into
  // their parent (resolved transitively) so a nested reference load never steals the run
  const resolveParent = (k) => { const seen = new Set(); while (companionOf[k] && !seen.has(k)) { seen.add(k); k = companionOf[k]; } return k; };
  const carryRun = {};
  for (const r of msgReg.values()) {
    const u = { input_tokens: r.u.in, cache_creation_input_tokens: r.u.cc, cache_read_input_tokens: r.u.cr, output_tokens: r.u.out };
    addUsage(s.total, u);
    addUsage(s.byModel[r.model] || (s.byModel[r.model] = newTally()), u);
    if (r.skill) {
      const eff = resolveParent(r.skill);
      const a = s.skillAttribution[eff] || (s.skillAttribution[eff] = { msgs: 0, output: 0, cacheRead: 0, carriedMsgs: 0 });
      a.msgs += 1; a.output += r.u.out; a.cacheRead += r.u.cr;
      if (eff !== r.skill) { a.companionMsgs = (a.companionMsgs || 0) + 1; a.companionOut = (a.companionOut || 0) + r.u.out; }
      if (r.carried) {
        a.carriedMsgs = (a.carriedMsgs || 0) + 1;
        carryRun[eff] = (carryRun[eff] || 0) + 1;
        // A long unbroken carry is a stale stamp absorbing later phases, not the named
        // skill's cost (measured: one stamp froze across 2 full cycles / 1h42m) - surface
        // it so reports flag instead of charging it.
        if (carryRun[eff] > (a.maxCarryRun || 0)) a.maxCarryRun = carryRun[eff];
      } else carryRun[eff] = 0;
    }
  }
  s.companionOf = companionOf;
  s.compactions = compactMeta > 0 ? compactMeta : compactSummary;
  return s;
}

function summarizeCauses(pending) {
  const by = {};
  for (const p of pending) {
    const e = by[p.name] || (by[p.name] = { n: 0, chars: 0 });
    e.n += 1; e.chars += p.chars;
  }
  return Object.entries(by).sort((a, b) => b[1].chars - a[1].chars).slice(0, 3)
    .map(([name, e]) => `${name}×${e.n} (~${fmt(approxTok(e.chars))} tok)`).join(', ');
}

// ---------- subagents (the session's <id>/subagents/ directory) ----------

async function analyzeSubagents(sessionFile, window) {
  // Native layout: <sid>.jsonl + <sid>/subagents/. Audit bundles (what the
  // project-stack-usage-analyzer skill archives) put subagents/ as a SIBLING of the
  // transcript - without the fallback a bundle re-analysis silently drops every seat.
  // Workflow-tool fan-outs nest under subagents/workflows/<wf-id>/agent-*.jsonl - a flat
  // scan silently dropped 703 transcripts (~35% of output) across two audited bundles,
  // so recurse (bounded) and tag each nested entry with its group.
  let dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  if (!fs.existsSync(dir)) dir = path.join(path.dirname(sessionFile), 'subagents');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = async (d, group, depth) => {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (depth < 2) await walk(full, group ? `${group}/${f}` : f, depth + 1);
        continue;
      }
      if (!f.endsWith('.jsonl')) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(d, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch { /* meta optional */ }
      if (group && !meta.agentType) meta.agentType = 'workflow-subagent';
      const t = await analyzeTranscript(full, window);
      if (window && t.total.msgs === 0) continue; // dispatched entirely outside the window
      out.push({ id: f.replace(/^agent-|\.jsonl$/g, ''), group: group || null, meta, stats: t });
    }
  };
  await walk(dir, null, 0);
  return out;
}

// ---------- hook-log join ----------

async function analyzeHookLog(file) {
  const byTool = {}; let rows = 0; let firstTs = null; let lastTs = null;
  await readJsonl(file, (o) => {
    if (!o.tool) return;
    rows++;
    if (o.ts) { if (!firstTs || o.ts < firstTs) firstTs = o.ts; if (!lastTs || o.ts > lastTs) lastTs = o.ts; }
    const t = byTool[o.tool] || (byTool[o.tool] = { calls: 0, details: {} });
    t.calls += 1;
    if (o.detail) t.details[o.detail] = (t.details[o.detail] || 0) + 1;
  });
  return { rows, byTool, firstTs, lastTs };
}

// ---------- report ----------

function tallyRow(label, t) {
  return `  ${pad(label, 22)} ${rpad(fmt(t.input), 8)} ${rpad(fmt(t.cacheCreate), 11)} ${rpad(fmt(t.cacheRead), 11)} ${rpad(fmt(t.output), 8)} ${rpad(t.msgs, 6)} ${rpad(fmt(ctxOf(t)), 8)}`;
}

const CTX_WARN = 120000; // avg ctx/msg above this = the conversation, not the tools, is the cost

// One aggregation, two renderers (text + markdown) - the numbers can never diverge by printer.
function computeAggregates(main, agents) {
  const agentTotal = newTally();
  const byType = {};
  for (const a of agents) {
    mergeTally(agentTotal, a.stats.total);
    const type = a.meta.agentType || '(unknown)';
    const g = byType[type] || (byType[type] = { n: 0, tally: newTally(), tools: {}, descs: [], wall: 0, span: 0, seatMs: 0, intervals: [], firstTs: null, lastTs: null });
    g.n += 1; mergeTally(g.tally, a.stats.total);
    for (const [name, t] of Object.entries(a.stats.toolCalls)) g.tools[name] = (g.tools[name] || 0) + t.calls;
    if (a.meta.description && g.descs.length < 2) g.descs.push(a.meta.description);
    if (a.stats.firstTs && a.stats.lastTs) {
      g.seatMs += new Date(a.stats.lastTs) - new Date(a.stats.firstTs);
      g.intervals.push([Date.parse(a.stats.firstTs), Date.parse(a.stats.lastTs)]);
      if (!g.firstTs || a.stats.firstTs < g.firstTs) g.firstTs = a.stats.firstTs;
      if (!g.lastTs || a.stats.lastTs > g.lastTs) g.lastTs = a.stats.lastTs;
    }
  }
  // wall = the union of the group's seat intervals, NOT the outer span and NOT summed seat
  // durations - the summed form overstated a 10-seat parallel fan-out 3x, and the outer
  // span read two 10-minute waves dispatched 4h apart as a 4h11m wall (both measured).
  // span (outer first -> last) is kept so the printer can flag multi-wave groups.
  for (const g of Object.values(byType)) {
    if (!g.intervals.length) continue;
    g.intervals.sort((x, y) => x[0] - y[0]);
    let wall = 0; let [cs, ce] = g.intervals[0];
    for (const [st, en] of g.intervals.slice(1)) {
      if (st <= ce) ce = Math.max(ce, en);
      else { wall += ce - cs; cs = st; ce = en; }
    }
    g.wall = wall + (ce - cs);
    g.span = Date.parse(g.lastTs) - Date.parse(g.firstTs);
  }
  const grand = newTally(); mergeTally(grand, main.total); mergeTally(grand, agentTotal);

  const skillSet = new Set([...Object.keys(main.skillInvocations), ...Object.keys(main.skillAttribution)]);
  for (const a of agents) for (const k of [...Object.keys(a.stats.skillInvocations), ...Object.keys(a.stats.skillAttribution)]) skillSet.add(k);
  const skillRows = [...skillSet].sort().map((k) => {
    const inv = { calls: 0, injectedChars: 0 };
    for (const src of [main, ...agents.map((a) => a.stats)]) {
      if (src.skillInvocations[k]) { inv.calls += src.skillInvocations[k].calls; inv.injectedChars += src.skillInvocations[k].injectedChars; }
    }
    const mAttr = main.skillAttribution[k] || { msgs: 0, output: 0, cacheRead: 0, carriedMsgs: 0 };
    const sub = { msgs: 0, output: 0, cacheRead: 0, types: {} };
    for (const a of agents) {
      const sa = a.stats.skillAttribution[k];
      if (!sa) continue;
      sub.msgs += sa.msgs; sub.output += sa.output; sub.cacheRead += sa.cacheRead || 0;
      const ty = a.meta.agentType || '(unknown)';
      sub.types[ty] = (sub.types[ty] || 0) + 1;
    }
    return { skill: k, cmd: main.commandInvocations[k] || 0, inv, mAttr, sub };
  });
  // Seats whose transcripts carry no skill stamp are real dispatch cost the SKILLS rows
  // cannot show - name them so an undercount reads as coverage, never as fewer dispatches.
  // A seat with its OWN Skill invocations is not stampless (its calls show in the rows) -
  // counted separately; for the truly stampless, the main session's stamp timeline at the
  // seat's dispatch moment gives a suggestion the report may cite as inferred, never charge.
  const unattributed = { n: 0, types: {}, selfInvoked: 0, guesses: {} };
  const tl = main.skillTimeline || [];
  for (const a of agents) {
    if (Object.keys(a.stats.skillAttribution).length) continue;
    if (Object.keys(a.stats.skillInvocations).length) { unattributed.selfInvoked += 1; continue; }
    unattributed.n += 1;
    const ty = a.meta.agentType || '(unknown)';
    unattributed.types[ty] = (unattributed.types[ty] || 0) + 1;
    if (a.stats.firstTs) {
      let guess = null;
      for (const e of tl) {
        if (!e.ts || e.ts > a.stats.firstTs) break;
        guess = e.skill;
      }
      if (guess) unattributed.guesses[guess] = (unattributed.guesses[guess] || 0) + 1;
    }
  }

  const docRows = {};
  let inject = main.styleInjections;
  let attach = main.styleRuleAttaches;
  for (const [rel, d] of Object.entries(main.docTouches)) {
    const r = docRows[rel] || (docRows[rel] = { main: 0, agents: 0, writes: 0, bashReads: 0, bashWrites: 0 });
    r.main += d.reads; r.writes += d.writes; r.bashReads += d.bashReads || 0; r.bashWrites += d.bashWrites || 0;
  }
  for (const a of agents) {
    inject += a.stats.styleInjections;
    attach += a.stats.styleRuleAttaches;
    for (const [rel, d] of Object.entries(a.stats.docTouches)) {
      const r = docRows[rel] || (docRows[rel] = { main: 0, agents: 0, writes: 0, bashReads: 0, bashWrites: 0 });
      r.agents += d.reads; r.writes += d.writes; r.bashReads += d.bashReads || 0; r.bashWrites += d.bashWrites || 0;
    }
  }

  const mcpServers = {};
  for (const src of [main, ...agents.map((a) => a.stats)]) {
    for (const [server, m] of Object.entries(src.mcp)) {
      const e = mcpServers[server] || (mcpServers[server] = { calls: 0, resultChars: 0, errors: 0, tools: {} });
      e.calls += m.calls; e.resultChars += m.resultChars; e.errors += m.errors;
      for (const [t, n] of Object.entries(m.tools)) e.tools[t] = (e.tools[t] || 0) + n;
    }
  }

  const tools = {};
  for (const src of [main, ...agents.map((a) => a.stats)]) {
    for (const [name, t] of Object.entries(src.toolCalls)) {
      const e = tools[name] || (tools[name] = { calls: 0, resultChars: 0, errors: 0, hookBlocks: 0 });
      e.calls += t.calls; e.resultChars += t.resultChars; e.errors += t.errors; e.hookBlocks += t.hookBlocks || 0;
    }
  }

  return { agentTotal, grand, byType, skillRows, unattributed, docRows, inject, attach, mcpServers, tools };
}

// ---------- hook-block ledger (which GUARD fired, not just which tool was denied) ----------
// The transcript shows a denied tool call, never WHICH hook denied it, so the per-hook block rate -
// the number that says whether a gate is earning its keep or misfiring - was unmeasurable. The
// guard hooks now append one row per block to <docs-path>/hook-blocks/<session>.jsonl; this reads
// them. A block costs the denial text plus the retried turn, so the count IS the cost signal.
function readBlockLedger(target) {
  const out = { rows: 0, byHook: {}, firstTs: null, lastTs: null };
  if (!target) return out;
  let files = [];
  try {
    files = fs.statSync(target).isDirectory()
      ? fs.readdirSync(target).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(target, f))
      : [target];
  } catch { return out; }
  // Read these SYNCHRONOUSLY - readJsonl above is stream-based and resolves a Promise, so a
  // sync caller would return an empty tally before the first line arrived. These ledgers are one
  // short row per block, so a plain readFileSync is both correct and cheap.
  for (const f of files) {
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || !o.hook) continue;
      out.rows += 1;
      const e = out.byHook[o.hook] || (out.byHook[o.hook] = { blocks: 0, reasons: new Map(), events: new Set(), tools: new Set() });
      e.blocks += 1;
      if (o.event) e.events.add(o.event);
      if (o.tool) e.tools.add(o.tool);   // rows from before the column exist without it - the cell stays empty
      const r = String(o.reason || '').slice(0, 90);
      e.reasons.set(r, (e.reasons.get(r) || 0) + 1);
      if (o.ts) {
        if (!out.firstTs || o.ts < out.firstTs) out.firstTs = o.ts;
        if (!out.lastTs || o.ts > out.lastTs) out.lastTs = o.ts;
      }
    }
  }

  return out;
}

function hookJoinStats(main, agents, hookLog, tools) {
  const trTools = Object.values(tools).reduce((n, t) => n + t.calls, 0);
  if (!hookLog.firstTs || !hookLog.lastTs) return { trTools, coverage: null };
  // Compare only calls inside the ledger's own window: a ledger wired mid-session
  // (instrumentation installed during the run) legitimately misses everything before
  // its first row - measured at 67 of an 80-row "gap" in a real install session.
  // A 35-58ms hook latency is NOT a coverage gap: comparing raw timestamps put the ledger row a
  // few ms outside the transcript's own window and printed '1 call outside the window' plus a FALSE
  // 'wired mid-session' line over 62/62 and 194/194 real coverage, across 16 bundles. Widen the
  // window by the hook's own latency budget before comparing.
  const HOOK_LATENCY_MS = 250;
  const allTs = [main, ...agents.map((a) => a.stats)].flatMap((src) => src.toolCallTs || []);
  const inWin = allTs.filter((ts) => ts >= hookLog.firstTs - HOOK_LATENCY_MS && ts <= hookLog.lastTs + HOOK_LATENCY_MS).length;
  // Anchor coverage to the ACTIVE window (after a mid-file /clear) - the raw span counted a
  // dead 23h50m gap as uncovered session time, reporting ~6% coverage for a ~96%-covered
  // 89-minute work window (measured).
  const sessStart = main.clearTs && main.clearTs > main.firstTs ? main.clearTs : main.firstTs;
  const sessSpan = sessStart && main.lastTs ? Date.parse(main.lastTs) - Date.parse(sessStart) : 0;
  const covSpan = Math.max(0, Math.min(Date.parse(main.lastTs || hookLog.lastTs), Date.parse(hookLog.lastTs)) - Math.max(Date.parse(sessStart || hookLog.firstTs), Date.parse(hookLog.firstTs)));
  const pct = sessSpan > 0 ? Math.round((100 * covSpan) / sessSpan) : 100;
  // A quiet tail (zero calls after the ledger's last row) and a real coverage gap read the
  // same in percentages - count the tail's calls so the report can tell them apart
  // (measured: an idle 38%-of-session tail with 0 tool calls was reported as unlogged activity).
  const tailCalls = allTs.filter((ts) => ts > hookLog.lastTs + HOOK_LATENCY_MS).length;
  // CALL coverage leads, wall clock follows: a session whose last hour is one idle await_summary
  // reads as 38% time-covered and 100% call-covered, and the second number is the true one.
  const callPct = allTs.length ? Math.round((100 * inWin) / allTs.length) : 100;
  return { trTools, coverage: { inWin, callPct, pct, outside: trTools - inWin, tailCalls, unmatched: Math.max(0, inWin - hookLog.rows) } };
}

function printReport(main, agents, hookLog, window, blockLedger) {
  const span = main.firstTs && main.lastTs ? new Date(main.lastTs) - new Date(main.firstTs) : null;
  console.log(`Session ${path.basename(main.file, '.jsonl')}  ${main.firstTs || '?'} → ${main.lastTs || '?'} (${dur(span)})${main.ccVersion ? `  Claude Code ${main.ccVersion}` : ''}`);
  if (main.clearTs && main.clearTs > main.firstTs) {
    console.log(`  active window since last /clear: ${main.clearTs} → ${main.lastTs} (${dur(new Date(main.lastTs) - new Date(main.clearTs))}) - use this, not the raw span, for duration claims`);
  }
  if (window) console.log(`windowed: ${window.fromStr || 'start'} → ${window.toStr || 'end'} (subagents dispatched outside the window are excluded)`);
  console.log(`user prompts ${main.userPrompts} · API messages ${main.total.msgs} · compactions ${main.compactions} · API errors ${main.apiErrors} · git commits ${main.gitCommits || 0}${main.prMerges ? ` (+${main.prMerges} pr-merge)` : ''}`);
  // The PEAK is what every threshold in the stack keys off; the average understated it by 17-43%.
  if (main.peakCtx) console.log(`peak ctx ${fmt(main.peakCtx)} per message${main.peakCtxAt ? ` (at ${main.peakCtxAt})` : ''} - the number every fresh-session threshold is measured against, not the average below`);
  if (main.thinkingTokens) console.log(`thinking ${fmt(main.thinkingTokens)} tok (cost-state.modelUsage) - billed, and attributable to no single message: spike residuals close against this, not against tool output`);
  if (main.floorCtx) {
    const share = main.total.cacheRead ? Math.round((100 * main.floorCtx * main.total.msgs) / main.total.cacheRead) : null;
    console.log(`standing inventory ~${fmt(main.floorCtx)} tok/msg (system prompt + tool schemas + CLAUDE.md + always-on rules) - paid on EVERY message${share != null ? `, ~${share}% of cache-read` : ''}, and re-paid in full after every compaction`);
  }
  if (main.modelIdsFull && main.modelIdsFull.length) console.log(`models (with window suffix, from cost-state) ${main.modelIdsFull.join(', ')} - the assistant messages strip the suffix, and it is what picks the context tier`);
  if (main.totalCostUSD != null) console.log(`billed $${Number(main.totalCostUSD).toFixed(2)} (cost-state)`);
  if (main.stopHookBlocks) console.log(`Stop-hook denials ${main.stopHookBlocks} - these arrive as meta user TEXT, not tool results, so they are absent from the hook-blk column below`);
  {
    const byHook = Object.entries(main.denialsByHook || {}).sort((a, b) => b[1] - a[1]);
    if (byHook.length) console.log(`denials by hook: ${byHook.map(([h, n]) => `${h}×${n}`).join(', ')} - the bracket is attribution only; '(unattributed)' is the JSON permission route, not a missing block`);
  }
  for (const c of main.compactionEvents || []) {
    console.log(`  compaction ${c.ts || '?'}: ${c.pre != null ? fmt(c.pre) : '?'} -> ${c.post != null ? fmt(c.post) : '?'} tok, dropped ${c.dropped != null ? fmt(c.dropped) : '?'}${c.durationMs ? `, ${dur(c.durationMs)}` : ''}${c.trigger ? ` (${c.trigger})` : ''}`);
  }
  {
    const evs = (main.apiErrorEvents || []).filter((e) => e.ctx != null);
    if (evs.length) console.log(`  API errors fired at ctx ${evs.slice(0, 5).map((e) => `~${fmt(e.ctx)}`).join(', ')}${evs.length > 5 ? ` … +${evs.length - 5} more` : ''} - a cluster at high ctx is context pressure, not provider flakiness`);
  }
  if (main.unheldStopCandidates && main.unheldStopCandidates.length) {
    const cands = main.unheldStopCandidates;
    console.log(`  ${cands.length} unheld-stop candidate${cands.length === 1 ? '' : 's'} (free-text user turn right after a no-tool end_turn - check each against the active skill's stop contract): ${cands.slice(0, 10).map((c) => `${c.stopTs}→${c.userTs || '?'}`).join(', ')}${cands.length > 10 ? ` … +${cands.length - 10} more` : ''}`);
  }
  const agg = computeAggregates(main, agents);

  console.log('\nTOKENS (deduped per API message; ctx/msg = avg context re-sent per call)');
  console.log(`  ${pad('scope / model', 22)} ${rpad('input', 8)} ${rpad('cache-write', 11)} ${rpad('cache-read', 11)} ${rpad('output', 8)} ${rpad('msgs', 6)} ${rpad('ctx/msg', 8)}`);
  console.log(tallyRow('main session', main.total));
  for (const [m, t] of Object.entries(main.byModel)) console.log(tallyRow('  ' + m, t));
  if (ctxOf(main.total) > CTX_WARN) {
    console.log(`  ! avg context/msg ${fmt(ctxOf(main.total))} - the cost driver is carried-forward conversation, not tool output:`);
    console.log(`    run pipeline steps in fresh sessions that resume from the plan file instead of one long chat.`);
  }
  if (agents.length) {
    console.log(tallyRow(`subagents (${agents.length})`, agg.agentTotal));
    console.log(tallyRow('TOTAL', agg.grand));
  }

  if (agents.length) {
    console.log('\nSUBAGENTS (exact per-dispatch cost, grouped by agent type)');
    console.log(`  ${pad('agent type', 28)} ${rpad('n', 3)} ${rpad('output', 8)} ${rpad('cache-read', 11)} ${rpad('msgs', 5)} ${rpad('wall', 7)}  top tools`);
    for (const [type, g] of Object.entries(agg.byType).sort((a, b) => b[1].tally.output - a[1].tally.output)) {
      const top = Object.entries(g.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n}×${c}`).join(' ');
      // seat-time is printed for EVERY multi-dispatch group: when seats overlap it shows the
      // parallelism win, when they don't it stops the outer span being read as per-seat cost
      // (measured: a 1h17m span over ~22m of actual seat activity framed as 'most expensive pair').
      const waves = g.n > 1 && g.span > g.wall * 1.5 ? `, dispatched in waves over ${dur(g.span)}` : '';
      console.log(`  ${pad(type, 28)} ${rpad(g.n, 3)} ${rpad(fmt(g.tally.output), 8)} ${rpad(fmt(g.tally.cacheRead), 11)} ${rpad(g.tally.msgs, 5)} ${rpad(dur(g.wall), 7)}  ${top}${g.n > 1 ? ` (seat-time ${dur(g.seatMs)}${waves})` : ''}`);
      if (g.descs.length) console.log(`  ${pad('', 28)} e.g. ${g.descs.map((d) => JSON.stringify(d.slice(0, 40))).join(', ')}`);
    }
  }

  if (agg.skillRows.length) {
    // Main and subagent attribution are printed SPLIT, never summed: a dispatched seat
    // inherits whatever skill stamp was last active in the main session, so a seat type
    // foreign to the skill (a verifier charged to an installer command) means the stamp
    // bled from an adjacent run - measured in a real session, where 223 verifier msgs
    // landed on a plugin-update command that dispatches nothing.
    console.log('\nSKILLS (cmd = slash invocations; calls = Skill tool invocations; attributed = API msgs stamped while the skill was active - the real cost signal)');
    console.log('  (sub rows list the seat types carrying the stamp - a seat type foreign to the skill = stamp bleed from an adjacent run, do not charge it)');
    console.log(`  ${pad('skill', 44)} ${rpad('cmd', 4)} ${rpad('calls', 5)} ${rpad('result', 9)} ${rpad('attr msgs', 9)} ${rpad('attr out', 9)} ${rpad('attr cache-rd', 13)}`);
    for (const r of agg.skillRows) {
      const carried = r.mAttr.carriedMsgs ? ` (${r.mAttr.carriedMsgs} carried${r.mAttr.maxCarryRun >= 30 ? ', carry likely stale - a frozen stamp absorbing later phases' : ''})` : '';
      const comp = r.mAttr.companionMsgs ? ` (+${r.mAttr.companionMsgs} via companion loads, ~${fmt(r.mAttr.companionOut || 0)} of the out)` : '';
      console.log(`  ${pad(r.skill, 44)} ${rpad(r.cmd || '', 4)} ${rpad(r.inv.calls, 5)} ${rpad('~' + fmt(approxTok(r.inv.injectedChars)), 9)} ${rpad(r.mAttr.msgs + carried + comp, 9)} ${rpad(fmt(r.mAttr.output), 9)} ${rpad(fmt(r.mAttr.cacheRead), 13)}`);
      if (r.sub.msgs) {
        const seats = Object.entries(r.sub.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(' ');
        console.log(`  ${pad(`    sub: ${seats}`, 44)} ${rpad('', 4)} ${rpad('', 5)} ${rpad('', 9)} ${rpad(r.sub.msgs, 9)} ${rpad(fmt(r.sub.output), 9)} ${rpad(fmt(r.sub.cacheRead), 13)}`);
      }
    }
    if (agg.unattributed.n || agg.unattributed.selfInvoked) {
      const types = Object.entries(agg.unattributed.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(' ');
      const guesses = Object.entries(agg.unattributed.guesses).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ');
      const self = agg.unattributed.selfInvoked ? ` (+${agg.unattributed.selfInvoked} more stamped only by their own Skill calls)` : '';
      if (agg.unattributed.n) console.log(`  (${agg.unattributed.n} dispatched seat${agg.unattributed.n === 1 ? '' : 's'} carry no skill stamp and are uncosted above: ${types}${guesses ? `; dispatch-window suggests ${guesses} - inferred, cite as such, never charge` : ''} - attribution coverage, not fewer dispatches)${self}`);
      else console.log(`  ${self.trim()}`);
    }
  }

  if (Object.keys(agg.docRows).length || agg.inject || agg.attach) {
    console.log('\nGENERATED DOCS (capture-doc consumption; reads = orientation happening, writes = capture/loop maintenance)');
    console.log(`  ${pad('doc', 44)} ${rpad('main-reads', 10)} ${rpad('agent-reads', 11)} ${rpad('writes', 6)}`);
    for (const [rel, r] of Object.entries(agg.docRows).sort((a, b) => (b[1].main + b[1].agents) - (a[1].main + a[1].agents))) {
      const bash = (r.bashReads || r.bashWrites) ? `  (+${r.bashReads || 0}r/${r.bashWrites || 0}w via Bash)` : '';
      console.log(`  ${pad(rel, 44)} ${rpad(r.main, 10)} ${rpad(r.agents, 11)} ${rpad(r.writes, 6)}${bash}`);
    }
    if (agg.attach) console.log(`  ${pad('(style rule attached on file touch)', 44)} ${rpad('-', 10)} ${rpad('-', 11)} ${rpad('-', 6)}  ×${agg.attach}`);
    if (agg.inject) console.log(`  ${pad('(style injected by legacy hook)', 44)} ${rpad('-', 10)} ${rpad('-', 11)} ${rpad('-', 6)}  ×${agg.inject}`);
  }

  if (Object.keys(agg.mcpServers).length) {
    console.log('\nMCP (main + subagents; results measured in chars, shown as ~tokens)');
    console.log(`  ${pad('server', 18)} ${rpad('calls', 5)} ${rpad('results', 9)} ${rpad('errors', 6)}  top tools`);
    for (const [server, m] of Object.entries(agg.mcpServers).sort((a, b) => b[1].calls - a[1].calls)) {
      const top = Object.entries(m.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n}×${c}`).join(' ');
      console.log(`  ${pad(server, 18)} ${rpad(m.calls, 5)} ${rpad('~' + fmt(approxTok(m.resultChars)), 9)} ${rpad(m.errors, 6)}  ${top}`);
    }
  }

  console.log('\nTOOLS (main + subagents; result volume = what lands back in context; hook-blk = PreToolUse denials - a denial may be a FALSE POSITIVE, so read the block before scoring it as the gate working)');
  console.log(`  ${pad('tool', 28)} ${rpad('calls', 5)} ${rpad('results', 9)} ${rpad('errors', 6)} ${rpad('hook-blk', 8)}`);
  {
    // Top 15 by result volume, PLUS any dropped row carrying errors or hook blocks - a
    // 100%-error tool must never vanish on low volume (measured: 2/2-error browser_click did).
    const rows = Object.entries(agg.tools).sort((a, b) => b[1].resultChars - a[1].resultChars);
    const shown = rows.slice(0, 15).concat(rows.slice(15).filter(([, t]) => t.errors > 0 || t.hookBlocks > 0));
    for (const [name, t] of shown) {
      console.log(`  ${pad(name, 28)} ${rpad(t.calls, 5)} ${rpad('~' + fmt(approxTok(t.resultChars)), 9)} ${rpad(t.errors, 6)} ${rpad(t.hookBlocks || '', 8)}`);
    }
  }

  if (blockLedger && blockLedger.rows) {
    console.log('\nHOOK BLOCKS (which guard fired; a block costs its denial text plus the retried turn)');
    console.log(`  ${pad('hook', 32)} ${rpad('blocks', 6)} ${rpad('event / tool', 22)} top reason`);
    for (const [h, e] of Object.entries(blockLedger.byHook).sort((a, b) => b[1].blocks - a[1].blocks)) {
      const top = [...e.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
      const where = [...e.events].join(',') + (e.tools.size ? ' / ' + [...e.tools].join(',') : '');
      console.log(`  ${pad(h, 32)} ${rpad(e.blocks, 6)} ${rpad(where, 22)} ${(top && top[0]) || ''}`);
    }
    console.log(`  ${blockLedger.rows} block(s) total - review any hook whose top reason looks like honest work being stopped.`);
  }

  if (main.spikes.length) {
    console.log('\nCONTEXT SPIKES (main session - biggest single-turn context jumps and what landed before them)');
    for (const sp of main.spikes) {
      console.log(`  +${rpad(fmt(sp.delta), 7)} → ${fmt(sp.ctx)} ctx  ${sp.ts || '?'}  after: ${sp.causes || '(prompt/attachment only)'}`);
    }
  }

  if (hookLog) {
    console.log(`\nHOOK LOG join (${hookLog.rows} rows - identity ledger only, tokens come from the transcript)`);
    for (const [tool, t] of Object.entries(hookLog.byTool).sort((a, b) => b[1].calls - a[1].calls).slice(0, 10)) {
      const top = Object.entries(t.details).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => `${d}×${n}`).join(', ');
      console.log(`  ${pad(tool, 28)} ${rpad(t.calls, 5)}  ${top}`);
    }
    const j = hookJoinStats(main, agents, hookLog, agg.tools);
    if (j.coverage) {
      console.log(`  coverage: ledger window ${hookLog.firstTs} → ${hookLog.lastTs} spans ~${j.coverage.pct}% of the session`);
      console.log(`  cross-check: ${j.coverage.callPct}% of tool calls are inside the ledger window - ${j.coverage.inWin} of ${j.trTools} - vs ${hookLog.rows} ledger rows`);
      if (j.coverage.outside > 0) console.log(`  ${j.coverage.outside} call${j.coverage.outside === 1 ? '' : 's'} outside the ledger window (${j.coverage.tailCalls} after its last row${j.coverage.tailCalls === 0 ? ' - a quiet tail, not lost coverage' : ''}) - a ledger wired mid-session legitimately misses the head`);
      if (j.coverage.unmatched > 0) console.log(`  ${j.coverage.unmatched} in-window call${j.coverage.unmatched === 1 ? '' : 's'} with no ledger row - check each call's own tool_result for a Blocked:/error string (harness-level blocks and input-validation failures never reach PreToolUse) before calling it a gap`);
    } else {
      console.log(`  cross-check: transcript saw ${j.trTools} tool calls vs ${hookLog.rows} hook rows (ledger rows carry no timestamps, so window coverage is unavailable)`);
    }
  }
}

// ---------- markdown report skeleton ----------
// --report-md emits the per-session report SKELETON: every table is machine-written,
// so a report author cannot misquote the numbers (measured: 5 wrong claims across 4
// hand-written session reports, each a prose restatement of tool output). The FILL IN
// sections at the end are the only judgment surface.
function printMarkdown(main, agents, hookLog, window, blockLedger) {
  const extraFacts = [];
  if (main.peakCtx) extraFacts.push(`- **Peak context** ${fmt(main.peakCtx)} tokens per message${main.peakCtxAt ? ` (at ${main.peakCtxAt})` : ''} - every fresh-session threshold is measured against this, not the average.`);
  if (main.thinkingTokens) extraFacts.push(`- **Thinking** ${fmt(main.thinkingTokens)} tokens (\`cost-state.modelUsage\`) - billed, attributable to no single message.`);
  if (main.floorCtx) {
    const share = main.total.cacheRead ? Math.round((100 * main.floorCtx * main.total.msgs) / main.total.cacheRead) : null;
    extraFacts.push(`- **Standing inventory** ~${fmt(main.floorCtx)} tokens/message (system prompt + tool schemas + CLAUDE.md + always-on rules) - paid on EVERY message${share != null ? `, ~${share}% of cache-read` : ''}, and re-paid in full after every compaction.`);
  }
  if (main.modelIdsFull && main.modelIdsFull.length) extraFacts.push(`- **Models (with window suffix)** ${main.modelIdsFull.map((m) => `\`${m}\``).join(', ')} - from \`cost-state\`; the assistant messages strip the suffix, and it is what picks the context tier.`);
  if (main.totalCostUSD != null) extraFacts.push(`- **Billed** $${Number(main.totalCostUSD).toFixed(2)} (\`cost-state\`).`);
  if (main.stopHookBlocks) extraFacts.push(`- **Stop-hook denials** ${main.stopHookBlocks} - meta user TEXT, not tool results, so absent from the \`hook-blk\` column.`);
  {
    const byHook = Object.entries(main.denialsByHook || {}).sort((a, b) => b[1] - a[1]);
    if (byHook.length) extraFacts.push(`- **Denials by hook**: ${byHook.map(([h, n]) => `\`${h}\` x${n}`).join(', ')} - the bracket is attribution only; \`(unattributed)\` is the JSON permission route.`);
  }
  for (const c of main.compactionEvents || []) {
    extraFacts.push(`- **Compaction** ${c.ts || '?'}: ${c.pre != null ? fmt(c.pre) : '?'} -> ${c.post != null ? fmt(c.post) : '?'} tokens, dropped ${c.dropped != null ? fmt(c.dropped) : '?'}${c.durationMs ? `, ${dur(c.durationMs)}` : ''}.`);
  }
  const agg = computeAggregates(main, agents);
  const out = [];
  const span = main.firstTs && main.lastTs ? new Date(main.lastTs) - new Date(main.firstTs) : null;
  const mdTally = (label, t) => `| ${label} | ${fmt(t.input)} | ${fmt(t.cacheCreate)} | ${fmt(t.cacheRead)} | ${fmt(t.output)} | ${t.msgs} | ${fmt(ctxOf(t))} |`;

  out.push(`# Stack usage report - session \`${path.basename(main.file, '.jsonl')}\``, '');
  out.push('Generated by `analyze-usage.js --report-md` - every number in the tables below is the');
  out.push("analyzer's own output. Fill ONLY the marked judgment sections; a claim there must cite a");
  out.push('table row above, or a transcript measurement labeled as such.', '');
  if (window) out.push(`> Windowed: ${window.fromStr || 'start'} → ${window.toStr || 'end'} (subagents dispatched outside the window are excluded)`, '');

  out.push('## Environment', '');
  out.push('| | |', '|---|---|');
  out.push(`| Session window | ${main.firstTs || '?'} → ${main.lastTs || '?'} (${dur(span)}) |`);
  if (main.clearTs && main.clearTs > main.firstTs) {
    out.push(`| Active window (since last /clear) | ${main.clearTs} → ${main.lastTs} (${dur(new Date(main.lastTs) - new Date(main.clearTs))}) - use this, not the raw span, for duration claims |`);
  }
  if (main.ccVersion) out.push(`| Claude Code (this session's transcript) | ${main.ccVersion} |`);
  out.push(`| Volume | ${main.userPrompts} user prompts · ${main.total.msgs} API messages · ${main.compactions} compactions · ${main.apiErrors} API errors |`);
  {
    const evs = (main.apiErrorEvents || []).filter((e) => e.ctx != null);
    if (evs.length) out.push(`| API errors fired at ctx | ${evs.slice(0, 5).map((e) => `~${fmt(e.ctx)}`).join(', ')}${evs.length > 5 ? ` … +${evs.length - 5} more` : ''} - a cluster at high ctx is context pressure, not provider flakiness |`);
  }
  out.push(`| Git commits (Bash occurrence count) | ${main.gitCommits || 0}${main.prMerges ? ` (+${main.prMerges} pr-merge)` : ''} |`);
  if (main.unheldStopCandidates && main.unheldStopCandidates.length) {
    const cands = main.unheldStopCandidates;
    out.push(`| Unheld-stop candidates | ${cands.length} (free-text user turn right after a no-tool end_turn; check each against the active skill's stop contract): ${cands.slice(0, 10).map((c) => `${c.stopTs}→${c.userTs || '?'}`).join(', ')}${cands.length > 10 ? ` … +${cands.length - 10} more` : ''} |`);
  }
  out.push(`| Models (main) | ${Object.entries(main.byModel).map(([m, t]) => `\`${m}\` ×${t.msgs}`).join(', ') || '-'} |`);
  out.push(`| Subagent transcripts | ${agents.length} |`);
  out.push(`| Hook ledger | ${hookLog ? `joined (${hookLog.rows} rows)` : 'absent - identity attribution unavailable, not inferred'} |`, '');
  if (extraFacts.length) out.push('', ...extraFacts, '');

  out.push('## Tokens (deduped per API message; ctx/msg = avg context re-sent per call)', '');
  out.push('| scope | input | cache-write | cache-read | output | msgs | ctx/msg |', '|---|---|---|---|---|---|---|');
  out.push(mdTally('main session', main.total));
  for (const [m, t] of Object.entries(main.byModel)) out.push(mdTally(`- ${m}`, t));
  if (agents.length) { out.push(mdTally(`subagents (${agents.length})`, agg.agentTotal)); out.push(mdTally('**TOTAL**', agg.grand)); }
  out.push('');
  if (ctxOf(main.total) > CTX_WARN) {
    out.push(`> ! avg context/msg ${fmt(ctxOf(main.total))} - the cost driver is carried-forward conversation, not tool output: run pipeline steps in fresh sessions that resume from the plan file instead of one long chat.`, '');
  }

  if (agents.length) {
    out.push('## Subagent dispatches (exact per-dispatch cost, grouped by agent type)', '');
    out.push('| agent type | n | output | cache-read | msgs | wall | top tools |', '|---|---|---|---|---|---|---|');
    for (const [type, g] of Object.entries(agg.byType).sort((a, b) => b[1].tally.output - a[1].tally.output)) {
      const top = Object.entries(g.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n}×${c}`).join(' ');
      const waves = g.n > 1 && g.span > g.wall * 1.5 ? `, dispatched in waves over ${dur(g.span)}` : '';
      out.push(`| ${type} | ${g.n} | ${fmt(g.tally.output)} | ${fmt(g.tally.cacheRead)} | ${g.tally.msgs} | ${dur(g.wall)}${g.n > 1 ? ` (seat-time ${dur(g.seatMs)}${waves})` : ''} | ${top} |`);
    }
    out.push('');
  }

  if (agg.skillRows.length) {
    out.push('## Skills (attribution split main vs sub)', '');
    out.push('A `sub:` row names the seat types carrying the stamp - a seat type foreign to the skill is');
    out.push('stamp bleed from an adjacent run: report it as bleed, never charge it to the skill.');
    out.push('`cmd` = slash invocations counted from command markers; `(N carried)` = msgs attributed by');
    out.push('carry-forward after the stamp dropped at a task-notification - inferred, not stamped.');
    out.push('`(+N via companion loads)` = msgs a nested in-protocol reference load would have stolen,');
    out.push('folded back into the invoking skill; `carry likely stale` = an unbroken 30+-msg carry run -');
    out.push("a frozen stamp absorbing later phases, flag it, don't charge it.", '');
    out.push('| skill | cmd | calls | result | attr msgs | attr out | attr cache-rd |', '|---|---|---|---|---|---|---|');
    for (const r of agg.skillRows) {
      const carried = r.mAttr.carriedMsgs ? ` (${r.mAttr.carriedMsgs} carried${r.mAttr.maxCarryRun >= 30 ? ', carry likely stale' : ''})` : '';
      const comp = r.mAttr.companionMsgs ? ` (+${r.mAttr.companionMsgs} via companion loads, ~${fmt(r.mAttr.companionOut || 0)} of the out)` : '';
      out.push(`| ${r.skill} | ${r.cmd || ''} | ${r.inv.calls} | ~${fmt(approxTok(r.inv.injectedChars))} | ${r.mAttr.msgs}${carried}${comp} | ${fmt(r.mAttr.output)} | ${fmt(r.mAttr.cacheRead)} |`);
      if (r.sub.msgs) {
        const seats = Object.entries(r.sub.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(' ');
        out.push(`| - sub: ${seats} | | | | ${r.sub.msgs} | ${fmt(r.sub.output)} | ${fmt(r.sub.cacheRead)} |`);
      }
    }
    if (agg.unattributed.n || agg.unattributed.selfInvoked) {
      const types = Object.entries(agg.unattributed.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(' ');
      const guesses = Object.entries(agg.unattributed.guesses).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ');
      const self = agg.unattributed.selfInvoked ? ` +${agg.unattributed.selfInvoked} more stamped only by their own Skill calls.` : '';
      if (agg.unattributed.n) out.push('', `> ${agg.unattributed.n} dispatched seat${agg.unattributed.n === 1 ? '' : 's'} carry no skill stamp and are uncosted in the rows above: ${types}${guesses ? `; dispatch-window suggests ${guesses} - inferred, cite as such, never charge` : ''} - attribution coverage, not fewer dispatches (cross-check the Subagent dispatches table).${self}`);
      else out.push('', `>${self}`);
    }
    out.push('');
  }

  const docEntries = Object.entries(agg.docRows).sort((a, b) => (b[1].main + b[1].agents) - (a[1].main + a[1].agents));
  if (docEntries.length || agg.inject || agg.attach) {
    out.push('## Generated docs (reads = orientation happening, writes = capture/loop maintenance)', '');
    out.push('_A **lower bound**. This table reads the Bash command text, so doc I/O routed through a script the session WROTE and then ran is invisible to it - measured at 5 reported against >=53 real. When a session writes its own helper, name that script here and treat the counts as a floor._', '');
    out.push('| doc | main-reads | agent-reads | writes | via Bash (r/w) |', '|---|---|---|---|---|');
    for (const [rel, r] of docEntries) out.push(`| ${rel} | ${r.main} | ${r.agents} | ${r.writes} | ${(r.bashReads || r.bashWrites) ? `${r.bashReads || 0}/${r.bashWrites || 0}` : ''} |`);
    if (agg.attach) out.push(`| (style rule attached on file touch) | - | - | ×${agg.attach} | |`);
    if (agg.inject) out.push(`| (style injected by legacy hook) | - | - | ×${agg.inject} | |`);
    out.push('');
  }

  const mcpEntries = Object.entries(agg.mcpServers).sort((a, b) => b[1].calls - a[1].calls);
  if (mcpEntries.length) {
    out.push('## MCP (main + subagents)', '');
    out.push('| server | calls | results | errors | top tools |', '|---|---|---|---|---|');
    for (const [server, m] of mcpEntries) {
      const top = Object.entries(m.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n}×${c}`).join(' ');
      out.push(`| ${server} | ${m.calls} | ~${fmt(approxTok(m.resultChars))} | ${m.errors} | ${top} |`);
    }
    out.push('');
  }

  out.push('## Tools (main + subagents; result volume = what lands back in context)', '');
  out.push('`hook-blk` = PreToolUse denials. A denial is not automatically the gate working - it may be a FALSE POSITIVE, and a false positive costs the denial text plus the whole retried turn. Read the block before scoring it. (Shipped verbatim over sessions whose blocks were 2 of 2 and 3 of 3 false positives, across 11 bundles.)', '');
  out.push('| tool | calls | results | errors | hook-blk |', '|---|---|---|---|---|');
  {
    const rows = Object.entries(agg.tools).sort((a, b) => b[1].resultChars - a[1].resultChars);
    const shown = rows.slice(0, 15).concat(rows.slice(15).filter(([, t]) => t.errors > 0 || t.hookBlocks > 0));
    for (const [name, t] of shown) {
      out.push(`| ${name} | ${t.calls} | ~${fmt(approxTok(t.resultChars))} | ${t.errors} | ${t.hookBlocks || ''} |`);
    }
  }
  out.push('');

  if (main.spikes.length) {
    out.push('## Context spikes (main session)', '');
    out.push('| Δ | to ctx | when | after |', '|---|---|---|---|');
    for (const sp of main.spikes) out.push(`| +${fmt(sp.delta)} | ${fmt(sp.ctx)} | ${sp.ts || '?'} | ${sp.causes || '(prompt/attachment only)'} |`);
    out.push('');
  }

  if (hookLog) {
    const j = hookJoinStats(main, agents, hookLog, agg.tools);
    out.push('## Hook-log join (identity ledger; tokens come from the transcript)', '');
    if (j.coverage) {
      out.push(`- Coverage: ledger window ${hookLog.firstTs} → ${hookLog.lastTs} spans ~${j.coverage.pct}% of the session.`);
      out.push(`- Cross-check: ${j.coverage.callPct}% of tool calls are inside the ledger window - ${j.coverage.inWin} of ${j.trTools} - vs ${hookLog.rows} ledger rows.`);
      if (j.coverage.outside > 0) out.push(`- ${j.coverage.outside} call${j.coverage.outside === 1 ? '' : 's'} outside the ledger window (${j.coverage.tailCalls} after its last row${j.coverage.tailCalls === 0 ? ' - a quiet tail, not lost coverage' : ''}) - a ledger wired mid-session legitimately misses the head.`);
      if (j.coverage.unmatched > 0) out.push(`- ${j.coverage.unmatched} in-window call${j.coverage.unmatched === 1 ? '' : 's'} with no ledger row - check each call's own tool_result for a Blocked:/error string (harness-level blocks and input-validation failures never reach PreToolUse) before calling it a gap.`);
    } else {
      out.push(`- ${j.trTools} transcript tool calls vs ${hookLog.rows} ledger rows (ledger rows carry no timestamps, so window coverage is unavailable).`);
    }
    out.push('');
  }

  // The markdown emitter never received the ledger at all, so the bundle reports the sweeps
  // actually read carried no guard-block section - 7 confirmations, while the terminal report
  // printed one from the same data.
  out.push('## Guard blocks (which guard fired; a block costs its denial text plus the retried turn)', '');
  if (blockLedger && blockLedger.rows) {
    out.push('_A block is not automatically the gate working. A FALSE positive is the most expensive event in this table - it costs the denial plus the whole retried turn - so read each top reason and say whether it stopped honest work._', '');
    out.push('| hook | blocks | event / tool | top reason |', '|---|---|---|---|');
    for (const [hook, e] of Object.entries(blockLedger.byHook).sort((a, b) => b[1].blocks - a[1].blocks)) {
      const top = [...e.reasons.entries()].sort((x, y) => y[1] - x[1])[0];
      const where = [...e.events].join(',') + (e.tools.size ? ' / ' + [...e.tools].join(',') : '');
      out.push(`| \`${hook}\` | ${e.blocks} | ${where} | ${((top && top[0]) || '').replace(/\|/g, '\\|')} |`);
    }
    out.push('', `${blockLedger.rows} block(s) total.`, '');
  } else {
    out.push('_No ledger rows. That means EITHER no guard fired OR the ledger was never written - say which, do not infer. The transcript alone records which TOOL was denied, never which hook._', '');
  }
  out.push('## Waste analysis - FILL IN', '', '_Ranked by tokens wasted. Every claim cites a table row above, or a transcript measurement labeled as such._', '');
  out.push('## Protocol check - FILL IN', '', "_One verdict per skill run, judged against that skill's own SKILL.md steps, citing the transcript turn that proves it. Mark unavailable rather than inferring._", '');
  out.push('## Verdict - FILL IN', '', '| skill | worked as intended | biggest strength | biggest waste source | one concrete suggestion |', '|---|---|---|---|---|', '');
  console.log(out.join('\n'));
}

// ---------- entry ----------

async function main() {
  const args = process.argv.slice(2);
  const flagVal = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const flagValIdx = new Set(['--hook-log', '--hook-blocks', '--from', '--to', '--docs-root'].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
  const target = args.find((a, i) => !a.startsWith('--') && !flagValIdx.has(i));
  const asJson = args.includes('--json');
  const asMd = args.includes('--report-md');
  const hookFile = flagVal('--hook-log');
  const blockDir = flagVal('--hook-blocks');
  const docsRoot = flagVal('--docs-root');
  if (docsRoot) docsPrefixes.push(docsRoot.endsWith('/') ? docsRoot : docsRoot + '/');
  const fromStr = flagVal('--from'), toStr = flagVal('--to');
  const window = fromStr || toStr
    ? { from: fromStr ? Date.parse(fromStr) : null, to: toStr ? Date.parse(toStr) : null, fromStr, toStr }
    : null;
  if (!target || (window && (Number.isNaN(window.from) || Number.isNaN(window.to)))) {
    console.error('usage: analyze-usage.js <session.jsonl | sessions-dir> [--from <ISO ts>] [--to <ISO ts>] [--hook-log <tool-usage.jsonl>] [--hook-blocks <dir|file>] [--docs-root <path>] [--json] [--report-md]');
    process.exit(1);
  }

  if (fs.statSync(target).isDirectory()) {
    // rollup mode: one line per session in the directory, newest first
    const files = fs.readdirSync(target).filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(target, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    console.log(`  ${pad('session', 38)} ${pad('start', 12)} ${rpad('output', 8)} ${rpad('cache-read', 11)} ${rpad('msgs', 6)} ${rpad('ctx/msg', 8)} ${rpad('agents', 6)} ${rpad('agent-out', 9)}`);
    const grand = newTally();
    for (const f of files) {
      const s = await analyzeTranscript(f, window);
      const agents = await analyzeSubagents(f, window);
      const at = newTally();
      for (const a of agents) mergeTally(at, a.stats.total);
      mergeTally(grand, s.total); mergeTally(grand, at);
      console.log(`  ${pad(path.basename(f, '.jsonl'), 38)} ${pad((s.firstTs || '?').slice(0, 10), 12)} ${rpad(fmt(s.total.output), 8)} ${rpad(fmt(s.total.cacheRead), 11)} ${rpad(s.total.msgs, 6)} ${rpad(fmt(ctxOf(s.total)), 8)} ${rpad(agents.length, 6)} ${rpad(fmt(at.output), 9)}`);
    }
    console.log(`  ${pad('TOTAL', 38)} ${pad('', 12)} ${rpad(fmt(grand.output), 8)} ${rpad(fmt(grand.cacheRead), 11)} ${rpad(grand.msgs, 6)}`);
    console.log('\nRun again with one session file for the full skills/MCP/tools/spikes report.');
    return;
  }

  const mainStats = await analyzeTranscript(target, window);
  const agents = await analyzeSubagents(target, window);
  const hookLog = hookFile ? await analyzeHookLog(hookFile) : null;
  // ONE ledger read, handed to every emitter. --report-md and --json used to drop it entirely,
  // so the bundle reports that quote the markdown - the ones the sweeps actually read - carried no
  // guard-block section at all (7 confirmations), while the terminal report had it.
  const blockLedger = readBlockLedger(blockDir);
  if (asJson) {
    const body = { main: mainStats, agents, hookLog, hookBlocks: blockLedger };
    console.log(JSON.stringify(window ? { window: { from: fromStr, to: toStr }, ...body } : body, null, 2));
    return;
  }
  if (asMd) {
    printMarkdown(mainStats, agents, hookLog, window, blockLedger);
    return;
  }
  printReport(mainStats, agents, hookLog, window, blockLedger);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
