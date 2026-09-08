# Bug Ticket

Description template, bug-specific rules, and example. The shared rules (Language, Tracker dialect, Filing, Tone, Assumptions, Format / delivery) and the Title format live in `SKILL.md`.

## Title

Phrase as a statement of the problem, not a question.

Examples:
- `[API] POST /orders returns 500 when payload contains null shipping address`
- `[Auth] User session is not invalidated after password change`
- `[UI] Date picker resets to current date after form validation failure`

## Description template

```
## Problem

[One line, no wrapping. What is wrong - observable behavior, not root cause. State facts, not assumptions.]

[Optional second line: where it was observed - environment, affected IDs, browser/OS, log id + timestamp.]

## Steps to Reproduce

1. [Specific step]
2. [Specific step]
3. [Specific step]

**Expected:** [What should happen]
**Actual:** [What actually happens]

## Impact

[One line, no wrapping. Who is affected, how severely, what is broken or degraded. Note data-integrity or business impact if relevant.]

[Optional, only when a stack trace or source map is available - a bullet list, not a table or code fence:]
Relevant call chain (from <source>):
- path/to/file.ext:LINE - `code at that line`
- path/to/file.ext:LINE - `code at that line`   ← annotate the failing line
```

## Bug-specific rules

- **Stack-agnostic**: serves any programming language and stack - never bias toward one. Keep wording and `symbol:line` / `file:line` notation language-neutral and adapt it to the language the bug is actually in; the example below is illustrative, not a default stack.
- **Code**: Include a code snippet only if it is the clearest way to show the problem (e.g., a failing request body, a specific SQL query). If it can be explained in plain text, skip the code. For a stack trace / call chain, do not paste the raw trace - distil it to a `- file:line - code` bullet list (see the structure above).
- **Steps to Reproduce**: If exact steps are not provided, infer them from context. If they truly cannot be determined, write 'Steps not yet identified - needs investigation.'
- **Impact**: Always include this. If not specified, infer from context (e.g., if a login flow is broken, impact is 'All users unable to authenticate').

## Example

**Input (from user):**
> The order detail page crashes for some orders - something about reading country on a missing address. Happens in prod for orders with no shipping address.

**Output:** (language-neutral - adapt the notation to whatever language the bug is in)

**Title:**
`[Orders] Order detail page throws a null-reference error when shippingAddress is missing`

**Description:**
```
## Problem

The order detail page (`/orders/:id`) throws an unhandled null-reference error for orders with no shipping address. It originates in `OrderSummaryService.formatAddress`, where `address` is null/empty when `address.country` is read while building the summary view model.

Observed on production, OrderId 88213. Log Id: 7c2f1a90-... (2026-06-13T20:11:17Z).

## Steps to Reproduce

1. Open an order that has no shipping address (e.g. a digital-only order), such as OrderId 88213.
2. Navigate to Orders -> Order Detail (`/orders/88213`).
3. The page builds the summary and calls `OrderSummaryService.formatAddress(order.shippingAddress)`.

**Expected:** The summary renders; a missing shipping address is handled gracefully (omitted or shown as '-') without throwing.
**Actual:** A null-reference error is thrown because `address` is null, breaking the order-summary pipeline.

## Impact

Users cannot view the detail page for any order without a shipping address, blocking access to order data. Every digital-only order triggers the failure while building the summary.

Relevant call chain (from the stack trace):
- OrderListView.render:141 - builds a summary for each order in the list
- OrderSummaryService.formatAddress:73 - formats the order's shipping address
- OrderSummaryService.formatAddress:96 - reads `address.country`   ← null deref
```
