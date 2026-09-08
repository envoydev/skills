# Epic Ticket

Description template, epic-specific rules, and example. The shared rules (Language, Tracker dialect, Filing, Tone, Assumptions, Format / delivery) and the Title format live in `SKILL.md`.

## Title

Phrase as a capability, system, or outcome - not a task.

Examples:
- `[Auth] User authentication and authorization system`
- `[Reporting] Advanced analytics and export module`
- `[Payments] Multi-provider payment integration`

## Description template

```
## Objective

[2-4 sentences. What are we building and why? Focus on business or product value.
 Answer: what problem does this solve, for whom, and what's the expected outcome.]

## Scope

**In scope:**
- [High-level capability or area 1]
- [High-level capability or area 2]
- [High-level capability or area 3]

**Out of scope:**
- [Explicitly excluded item - prevents scope creep]
- [Explicitly excluded item]

## Success Metrics

- [ ] [Measurable outcome 1 - e.g., 'Users can complete checkout without leaving the app']
- [ ] [Measurable outcome 2 - e.g., 'p95 API response time < 300ms under expected load']
- [ ] [Measurable outcome 3]

## Proposed Stories / Breakdown

- [ ] [Story or task 1 - high level]
- [ ] [Story or task 2 - high level]
- [ ] [Story or task 3 - high level]

## Notes

[Optional. Dependencies, risks, related epics, timeline constraints, open decisions.
 Skip if nothing relevant.]
```

## Epic-specific rules

- **Objective**: Focus on value and outcome, not implementation details. Don't start with 'We need to build...' - frame it around the problem being solved.
- **Scope**: Always include both in-scope and out-of-scope sections. Out of scope is often the most valuable part - it forces explicit decisions.
- **Success Metrics**: At least 2. Make them observable and testable, not vague ('users are happy' is not a metric).
- **Proposed Stories**: High-level breakdown only - no implementation details. These are suggestions to seed the backlog, not a final list.
- **Notes**: Only include if genuinely useful. Don't pad.

## Example

**Input (from user):**
> We need to add a full notification system - email, in-app, push. Users should be able to manage their preferences.

**Output:**

**Title:**
`[Notifications] Multi-channel notification system with user preferences`

**Description:**
```
## Objective

Users currently receive no proactive communication from the platform, leading to missed updates and low re-engagement.
This epic covers building a multi-channel notification system (email, in-app, push) and giving users control over what they receive and how.
Expected outcome: improved user retention and reduced support load from missed events.

## Scope

**In scope:**
- In-app notification center (list, read/unread state)
- Email notifications via transactional provider (e.g., SendGrid)
- Push notifications for mobile clients
- User notification preferences page (per-channel, per-event-type toggles)
- Admin ability to trigger manual notifications

**Out of scope:**
- SMS notifications
- Marketing/bulk campaign notifications
- Notification analytics or open-rate tracking

## Success Metrics

- [ ] Users receive in-app, email, and push notifications for all defined trigger events
- [ ] Users can enable/disable any notification type independently
- [ ] Notification delivery latency < 5s for in-app and push; < 60s for email
- [ ] Zero duplicate notifications delivered per event

## Proposed Stories / Breakdown

- [ ] [Story] Design notification data model and event trigger architecture
- [ ] [Story] Implement in-app notification center (backend + UI)
- [ ] [Story] Integrate transactional email provider and templates
- [ ] [Story] Integrate push notification service for mobile
- [ ] [Story] Build user notification preferences page
- [ ] [Task] Set up notification delivery monitoring and alerting
- [ ] [Story] Admin panel: manual notification trigger

## Notes

- Confirm mobile push provider with the mobile team before starting (Firebase vs APNs direct).
- Email template design needs sign-off from product before implementation starts.
- Related: [PROJ-88] User profile settings epic - preferences UI may be built there.
```

The worked example above is illustrative, not a default stack - adapt provider and tool names to the project the epic is for.
