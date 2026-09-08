# Story Ticket

Description template, story-specific rules, and example. The shared rules (Language, Tracker dialect, Filing, Tone, Assumptions, Format / delivery) and the Title format live in `SKILL.md`.

## Title

Phrase as a capability or goal, not a problem statement.

Examples:
- `[Auth] Allow users to reset password via email link`
- `[Dashboard] Display weekly activity summary for logged-in users`
- `[API] Expose endpoint for bulk order status updates`

## Description template

```
## User Story

As a [type of user],
I want to [perform some action],
so that [I achieve some goal / business value].

## Acceptance Criteria

- [ ] [Criterion 1 - specific, testable]
- [ ] [Criterion 2 - specific, testable]
- [ ] [Criterion 3 - specific, testable]

## Notes

[Optional. Include constraints, edge cases, related tickets, or open questions.
 Skip this section entirely if there's nothing relevant to add.]
```

## Story-specific rules

- **User Story format**: Always use the 'As a / I want / So that' format. Infer the user type and goal if not explicitly stated.
- **Acceptance Criteria**: Write at least 2, max ~6. Each must be independently testable - no vague criteria like 'works correctly' or 'looks good'. Phrase as observable outcomes, not implementation steps.
- **Notes**: Only include if there's something genuinely useful - edge cases, dependencies, or open questions. Don't pad.

## Example

**Input (from user):**
> Users should be able to export their order history as a CSV file.

**Output:**

**Title:**
`[Orders] Allow users to export order history as CSV`

**Description:**
```
## User Story

As a registered user,
I want to export my order history as a CSV file,
so that I can analyze my purchases or import them into external tools.

## Acceptance Criteria

- [ ] A user can trigger CSV export from the Order History page.
- [ ] The exported file contains all orders for the authenticated user.
- [ ] Each row includes: order ID, date, status, items, total amount.
- [ ] Export is scoped to the current filter/date range if one is applied.
- [ ] File is downloaded immediately; no email delivery needed.
- [ ] Empty order history produces an empty CSV with headers only (no error).

## Notes

- Confirm max row limit with PO - large accounts may have thousands of orders.
- Related: [PROJ-123] Order filtering feature.
```
