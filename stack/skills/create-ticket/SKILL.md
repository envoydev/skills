---
name: create-ticket
description: "Writes a ticket in English from a raw description for any tracker (Jira, Azure DevOps, GitHub, GitLab, YouTrack): bug, user story, epic, or technical task - detects the type, routes to its template. Use whenever the user wants a ticket written or a not-yet-filed draft reworked (shorter, different focus), even casually or in Ukrainian - 'create a bug/story/epic/task ticket', 'create user story', 'create jira ticket', 'file a bug'. Do NOT fire to write code or fix the bug instead of filing it, to touch a ticket already in the tracker (query / update / comment / close), or for a commit / PR message."
---

# Create Ticket

Transforms a raw description into a clean, professional ticket written in English. Output is tracker-agnostic Markdown that pastes cleanly into Jira, Azure DevOps, GitHub, GitLab, or YouTrack.

## Procedure

1. Detect the type from the request (table below). Ambiguous: pick the closest type and note the assumption.
2. Read the matching reference file **before writing** - it carries the Description template, the type-specific rules, and a worked example.
3. Write the ticket to the reference's template and the rules below.
4. Pre-flight the draft before presenting it - strike anything the three checks catch, then re-read once: (a) a file, class, method, DTO or other name that does not exist in the codebase yet; (b) a path or document the reader cannot open from the tracker (a plan file, a working-tree doc, a session path); (c) a criterion nobody can trigger and observe. Each is a rule below written as a check, because as prose alone they were skipped in a live run.

| Type | Use when | Reference |
|---|---|---|
| **Bug** | something is broken - a defect, error, or regression | `references/bug.md` |
| **Story** | a user-facing capability or requirement | `references/story.md` |
| **Epic** | a large initiative spanning multiple stories / sprints | `references/epic.md` |
| **Task** | technical work that is not a bug or a user feature (refactor, performance, spike, migration, upgrade, cleanup) | `references/task.md` |

## Output Format

Always produce exactly two sections: **Title** and **Description**.

### Title

A single line. Must be:
- Concise (under 80 characters)
- Specific enough to understand at a glance without reading the description
- Phrased to fit the type - the reference shows the exact wording (bug = a statement of the problem; story / epic = a capability or outcome; task = an action or goal)
- Format: `[Area/Component] Short description`

### Description

Use the template in the type's reference file. Write in clear, professional English. Be concise - avoid filler.

## Rules (all types)

- **Language**: Always output in English, regardless of input language.
- **Tracker dialect**: Output Markdown by default - it pastes natively into GitHub, GitLab, and YouTrack, Jira Cloud converts it on paste, and Azure DevOps renders it once the large-text field is switched to Markdown. If the user names a specific tracker, adapt to its conventions (e.g. drop the `[Area]` title prefix when the tracker has a Component field that carries it).
- **Filing**: if an issue-tracker MCP is connected (e.g. Atlassian), offer it after presenting the ticket via AskUserQuestion - file it via the connector vs copy-paste only (plain-text options where the harness lacks the tool); title and description map 1:1. Never file without explicit confirmation.
- **Tone**: Neutral and factual. No emotional language, no blame.
- **Assumptions**: If the description is vague, make reasonable assumptions and note them briefly - in the Problem section for bugs, the Notes section otherwise.
- **Two readers - QA and the developer**: the ticket describes the problem and the behaviour wanted in words a tester who has never opened the code can follow - what happens today, in which situation, and what should happen instead. Spend the length there, not on internals.
- **No solution in the ticket**: no new file, class, method or DTO, no design, no implementation steps. Naming a shape that does not exist yet reads as a decision already taken, and it tells QA nothing - how to build it is the developer's call. Where the product already behaves the wanted way somewhere else, name that place as the example to compare against (by feature or screen, one line; a code path only where it genuinely helps orientation) and say what differs.
- **Acceptance criteria are checkable**: each one is something a person can trigger and observe - a screen, a message, a state, a value. For purely internal work, where there is nothing for QA to see, the criterion is what the build or the test suite proves. Never a criterion that only restates the design ('the service is generic', 'the code is refactored').
- **Nothing session-local**: no plan file, working-tree doc, scratch path or generated-docs path in the ticket - the reader has neither your session nor your branch. Everything that matters is written IN the ticket; a link is only for something the reader can open themselves (a tracker ID, a URL).
- **Unverified goes in Notes as a question**: something inferred but not confirmed is phrased as a check to run before relying on it, never as an instruction to implement.
- **Length**: the whole Description fits one screen, roughly 400 words - a ticket is scanned in a board preview, not read like a document. Never restate a section - one Scope, one Acceptance Criteria list, about 6 criteria at most.
- **Format / delivery**: present the Description as raw, copy-pasteable Markdown inside one fenced block - headers (`##`) and symbols must stay literal, not rendered, since the user pastes it straight into the tracker. Inside it:
  - Do not hard-wrap prose - one paragraph is one line (full width); let the tracker wrap it.
  - Wrap identifiers, methods, paths, expressions, and error strings in inline code with backticks.
  - Avoid nested code fences and Markdown tables in the body; for a trace, call chain, or log excerpt use a bullet list (`- file:line - code`) under a plain lead-in line, annotating the key line inline (e.g. `← null deref`). The one sanctioned table is the task Baseline/Target metrics block (see `references/task.md`).
  - Use a normal dash `-`, never an em dash.
