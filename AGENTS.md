# AGENTS.md

This file constrains how ChatGPT / Codex / other code agents operate in this repository.

## Original goal

Within the scope of accounts the user personally and legally owns and can use normally, verify submission, SSE, conversation chain, and result retrieval for Dola Seedance 2.5 native 30-second T2V, and ultimately deliver a user-operable Windows multi-account desktop tool.

## Current architecture (updated 2026-08-29)

Clean-room static analysis of the "Xiaochai multi-instance launcher" (小柴多开器) installer provided by the user has confirmed: the product shape that actually fits multi-account + 30-second POC is an **Electron Desktop** app, not a plain Chrome Extension.

New default product path:

```text
Electron Desktop
→ Account Manager
→ independent persistent session partition per account
→ one Dola WebView/WebContents per account
→ user logs in manually, once per account
→ Dola request observer / CDP
→ Seedance task lifecycle
→ result/history/download
```

The original `extension/` is retained as a protocol-observation / debug tool; it is no longer the final product architecture.

## Why the change

Static analysis shows the target software's Seedance 2.5 30-second path is not just a modified `duration`: it treats the Dola page as the login/UI layer while the desktop main process handles a separate request envelope, SSE, and conversation-chain lifecycle.

See:

- `docs/XIAOCHAI_STATIC_ANALYSIS.md`
- `docs/MULTI_ACCOUNT_DESKTOP_ARCHITECTURE.md`

## Safety and product boundaries

Do not commit cookies, tokens, sessions, browser profiles, raw HAR, or unredacted responses to Git.

## Development Gates

### D0 — Electron shell

- Electron main window launches
- Account Manager UI
- Create / delete / switch accounts
- Persistent partition per account

### D1 — Manual login persistence

- Account A logs in to Dola manually
- Still logged in after restart
- Account B's session is fully isolated from A's

### D2 — 10s baseline observation

- User generates Seedance 2.5 10s T2V normally through the Dola UI
- Capture and normalize model / duration / ratio / conversation lifecycle

### D3 — 30s capability POC

- Attempt Seedance 2.5 30s T2V only where the account itself permits it
- On success, save SSE/conversation/task evidence
- On server rejection, record the real error and stop

### D4 — Result lifecycle

- conversation chain polling
- terminal-state detection
- media result parsing
- local task history

### D5 — Multi-account task queue

- The user explicitly chooses the account for a task
- Default: 1 concurrent generation task per account
- Do not rotate accounts automatically based on remaining quota

### D6 — Windows package

- Package a portable/installable Windows x64 app
- Ordinary users must not need to install Node.js

If any Gate has not passed, it must not be written up as "implemented".

## Suggested tech stack

- Electron
- TypeScript
- Renderer: lightweight HTML or React, maintainability first
- Electron persistent `session` partitions
- WebContents / WebView
- Chrome DevTools Protocol, only for observing the current account's own pages and for normal task integration
- SQLite or local JSON (JSON first for v1)
- Vitest

`playwright` is allowed only as a test/debug tool, not as a long-running container for accounts.

## Provider design

Do not hard-wire the business logic entirely into Dola:

```text
VideoProvider
├── DolaWebProvider
└── BytePlusSeedanceProvider (future / official)
```

This way the official Seedance 2.5 API can later serve directly as a stable production route.

## Change discipline

- Commit in small steps; one commit solves exactly one Gate.
- The provenance of every protocol field must be stated: `observed` / `inferred` / `verified`.
- Sync test results into `docs/TEST_LOG.md`.
- Do not copy proprietary source code from the commercial software the user uploaded; implement independently from clean-room behavioral/architectural conclusions only.
- Do not commit platform security signatures, anti-abuse fields, or real identity tokens to the repository.

## Safety self-check

Before every commit, search for the following:

- `sessionid`
- `ttwid`
- `s_v_web_id`
- `cookie:` / `Cookie:`
- `authorization:` / `Authorization:`
- real access/refresh tokens
- real user IDs, session IDs, device IDs
- Google password / TOTP secret

If a real value is found, delete or replace it with `<REDACTED>` immediately.
