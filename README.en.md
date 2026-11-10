# dsh-deferred-approvals

Non-blocking approvals for DeepSeek Harness: when a tool needs your permission, the
request is parked as a pending item (`#A1`, `#A2`, …) **and the model keeps working** in
the same turn. You answer whenever you come back — the pending card sits where the
native approval prompt appears, above the composer — and the approved call can be
retried with a one-shot grant.

## What changes

- Before: an approval request froze the whole turn until you clicked.
- Now: the request becomes a background to-do. The model continues with other subtasks,
  or picks a route that needs no escalation.
- After you approve: a host event tells the model to retry the original call, and the
  host lets it through under a one-shot grant (no second dialog).

## When it stays out of the way

Approval is a host permission, not conversation content. The plugin only intercepts
approvals the native policy was already going to ask for; with a `never` policy or no
native approval, it does nothing and never raises the session policy on its own
(`forceAskPolicy` defaults to `false`).

## How it works

1. **Intercept** at the outermost `approval/request` waterfall: record tool name,
   argument fingerprint, permission level and justification, immediately return
   `rejected` to that call, and show it as "parked, not executed".
2. **Rewrite the tool result** so the model sees "parked as #A1 — do not wait, do not
   retry blindly; cancel it if you solved it another way".
3. **Continue**: the same assistant turn carries on with other work.
4. **Decide**: allow once (one-shot grant, fingerprint-matched, 5-minute TTL, consumed
   on use), allow every same-class request for this conversation, deny with a note, or
   dismiss.
5. **Deliver**: a host event (`source.kind = 'deferred-approval'`) wakes or steers the
   model; a session that is offline queues the event for its next resume.
6. **Ledger**: every decision is recorded, so `pending` answers definitively ("already
   approved — do not cancel") and late clicks on an expired card are still honoured.
7. **Expiry**: pending items expire after 15 minutes, silently, without waking the model.

## Requirements

- DeepSeek Harness 0.2.1 or newer with a Web profile.
- No runtime dependencies: Host uses `node:crypto` plus `tools` / `approval` / `agents` /
  `systemPrompt` (optionally `connection`, `typertGateway`); the Client uses `slots` /
  `locale` / `uiSession`.

## Install

```sh
dsh plugin --profile web add github:Hao0311/dsh-deferred-approvals
```

## Notes

- The Host half is loaded at startup; restart DSH after changing its source.
- The Client half appears as an orange badge and a "pending" count in the composer row,
  plus the native-style orange dot on sessions that have a parked approval.

MIT licensed.


## Timed questions (merged from dsh-timed-questions)

The same bundle also switches `ask_user_question` in the standard preset to **timed mode**:

- after asking, the model waits at most `timeout` seconds (default 20); on timeout the tool
  returns `{pending:true, callId}` and the model keeps working;
- the question card stays on screen and can be answered any time; the answer reaches the
  model as a user message (next step while running, a new turn when idle);
- a single call may pass its own `timeout`; `-1` means "wait for an answer";
- this is built-in DSH capability (`mode: timed` on `@deepseek-ai/dsh-tool-ask-user`).

Scope: **new sessions**. Existing sessions keep the preset they started with.

### After a DSH upgrade

`cordis.patch.yml` is a whole-preset override, so it can go stale when DSH ships a new
standard preset. The host half compares the shipped preset with this copy at startup and
regenerates it when it drifts (keeping `mode: timed` and `timeout`), then asks the user to
restart DSH so new sessions pick it up. Manually: `node check-preset-drift.mjs --regenerate`.