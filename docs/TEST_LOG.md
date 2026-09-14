# Test Log

所有真实测试按时间追加，不覆盖历史结果。

## 2026-08-29 — Repository bootstrap

- Gate: G0
- Status: PASS
- Result:
  - Public test repository confirmed.
  - Safety rules established.
  - Raw credentials/captures/browser profiles excluded from Git.
  - POC acceptance gates defined.
- Evidence: repository files and commit history.

## 2026-08-29 — CI static validation

- Gate: pre-G1 static validation
- Status: PASS
- Environment: GitHub Actions / Ubuntu / Node.js 20
- Result:
  - `npm install` passed.
  - `npm run typecheck` passed.
  - `npm test` passed.
  - Redaction unit tests passed.
- Scope note:
  - This validates code compilation and sanitizer behavior only.
  - It does **not** prove Dola browser connectivity, request capture, Seedance 2.5 lifecycle mapping, or 30-second generation.

## 2026-08-29 — Default architecture switched to current Chrome Extension

- Gate: pre-G1 architecture validation
- Status: IMPLEMENTED / awaiting user browser test
- Result:
  - Default Playwright/new-profile path removed from normal user flow.
  - `START_WEB.bat` removed.
  - Debug localhost launcher renamed to `DEBUG_START_WEB.bat`.
  - `extension/manifest.json` switched to Manifest V3 MAIN-world `page-hook.js` at `document_start`.
  - `content.js` remains isolated-world UI/storage layer.
  - Inspector defaults to capture ON for first use.
  - Existing Google/Dola login state in the user's current Chrome is preserved by design.
  - fetch/XHR request and text/json response observation is sanitized before being stored by the extension UI.
- Scope note:
  - Static architecture is implemented.
  - G1 is not PASS until the extension is manually loaded in the user's current Chrome and the Inspector is visibly present on Dola.

## 2026-09-14 — D2 baseline: Dola Web submit capture (Seedance 2.5 / 10s / T2V)

- Gate: D2 (request side OBSERVED; generation itself failed — see evidence)
- Status: OBSERVED / PARTIAL
- Environment: Seedance Desktop Studio (Electron 44), Windows, user's own logged-in sessions via persistent partitions
- Method: CDP Network observer attached to the account's own webview; sanitized JSONL in `captures/raw/` (gitignored); cookies/tokens/signing params auto-redacted
- Result:
  - Submit endpoint: `POST /chat/completion` with query `aid=495671`, `device_id`, `region=VN`, `sys_region=VN`, `samantha_web=1`, `version_code=20800`
  - Video config travels in `chat_ability.ability_type = 17` and `chat_ability.ability_param` (JSON string): `{"model":"seedance_v2.5","duration":10,"input_box_content":{"user_input_content":"<prompt>","reply_message_format":"Generated video: %s"}}` — field source: `observed`
  - Skill marker: `ext.input_skill = {"skill_id":"17","skill_type":17}` — `observed`
  - User message body: `content_block[0].block_type = 10000` with `text_block.text = "Generated video: <prompt>"` — `observed`
  - Bot `bot_id` is the public Dola assistant id — `observed`
  - Aspect ratio has NO structured field in the submit envelope (`UNKNOWN`); bot restated "16:9" in text — `inferred`: UI ratio is carried via prompt text or server default
  - Realtime transport: `wss://wss-normal-i18n.dola.com/ws/v2` push channel (heartbeat frames observed; data frames binary) plus IM polling loop: `im/chain/recent_conv` (cmd 3200), `im/conversation/info` (cmd 1110), `im/chain/single` (cmd 3100), `im/message/send_rate_limit` (cmd 2260) — `observed`
  - Failure evidence: first generation attempt returned "Something went wrong. Please try again."; retry was acknowledged ("will use 4 credits and be ready in 5 minutes") while the account concurrently reported "0 video credits left today" — recorded, not retried further
- Known limitations:
  - Response bodies (including the completion stream) are not captured yet: Electron `webContents.debugger` does not emit `Network.loadingFinished`; submit body capture solved via `Network.getRequestPostData`
- Next action: re-run when an account has video credits remaining; capture completion push, media URL, and map result lifecycle to D4

## 下一测试：G1 Current Chrome Extension

目标：

1. 在用户平时正在使用、已经登录 Google 的 Chrome 打开 `chrome://extensions/`。
2. 开启开发者模式并“加载已解压的扩展程序”。
3. 选择仓库中的 `extension` 文件夹。
4. 在同一个 Chrome 打开 `https://www.dola.com/`。
5. 确认右侧出现 `Seedance Inspector`。
6. 确认页面显示 `当前 Chrome 会话 · 无需重新登录` 和 `自动记录已开启`。
7. 正常进行 Google/Dola 登录或直接复用已有登录态。

G1 通过后进入 G2：正常生成一次 Seedance 2.5 / 10s / T2V，并验证请求/响应捕获。

### 测试记录模板

```text
Date:
Gate:
Environment:
Action:
Expected:
Observed:
PASS/FAIL:
Evidence:
Known limitations:
Next action:
```
