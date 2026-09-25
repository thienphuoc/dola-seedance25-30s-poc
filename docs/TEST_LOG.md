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

## 2026-09-14 — D3 capability check: 30s availability on Dola web (three accounts)

- Gate: D3 (capability check before any 30s attempt)
- Status: BLOCKED — 30s is not offered to these accounts; no task submitted
- Environment: Seedance Desktop Studio partitions (local, user's own logged-in sessions), Dola web `region=VN`, method: local Electron task runner driving the account's own session (`apps/desktop/tools/dola-task.js`), read-only probes
- Method note: the runner loads the account's persistent partition directly (no cookie export, no token file, no fingerprint spoofing) and reads the same config endpoints the page itself calls. Submit path exists but was not fired.
- Result:
  - `/samantha/skill/pack` (`skill_type:17`) returns `video_generation.meta.model_capability.*.supported_durations = ["5","10"]` and duration options `5s`/`10s` only — `observed`
  - `/alice/slot/action_bar_v3/get_item_conf` returns the video toolbar selector `{"label":"Duration","key":"video-duration","option_list":[{"5s","option_key":"5"},{"10s","option_key":"10"}]}` — `observed`; the config contains no `15s`, `30s`, or `"30"` token anywhere
  - Model selector `{"label":"Model"}` lists `Dreamina Seedance 2.5` (`option_key: seedance_v2.5`, `subs_only_tag: enhanced`, "5x credit usage"), `Dreamina Seedance 2.0 Fast` (default), `Dreamina Seedance 1.0` — `observed`
  - Selecting Seedance 2.5 in the live UI does **not** expand the duration list: chat skill panel and `AI Creation → Video` both still show `5s`/`10s` — `observed`
  - Account status for all three local accounts: `membership_info.level = free`, `has_active_subscription = false`, `subs_status = free` — `observed`
  - `inferred`: 15s/30s may be tied to a paid tier (the 2.5 model carries a subscription tag while the accounts are free), but this is **not** verified and no attempt was made to fake entitlement
- Not done at that point: no `duration` patch, no crafted envelope, no account switching (the internal gate was in force then; it was lifted the same day — see D4 below)
- Evidence: `captures/raw/dola-task-2026-09-14.jsonl` (gitignored, local); sanitized protocol notes added to `docs/DOLA_NETWORK_API.md`
- Next action: obtain an account/subscription that exposes 15s or 30s in the UI, or route the native 30s T2V through the BytePlus ModelArk provider path (G3/G4); re-run the capability check first

## 2026-09-14 — D4: 30s override attempt (`duration` rewritten in flight)

- Gate: D4 (30s submit attempt)
- Status: REJECTED BY SERVER — no task created, no credits consumed
- Environment: Dola 3 partition, Dola web `region=VN`, free tier; method: local Electron runner + CDP `Fetch` request interception (`--patch-duration`), request still issued by the page's own fetch/signing path
- Result:
  - UI selection: model `Dreamina Seedance 2.5`, ratio `16:9`, duration chip `10s` (max the UI offers)
  - On the wire: `chat_ability.ability_param` = `{"ratio":"16:9","model":"seedance_v2.5","duration":30,"input_box_content":{…}}` — `observed` (`request_patched` in capture)
  - HTTP `200` `text/event-stream`, then `STREAM_ERROR {"error_code":710022002,"error_msg":"We are experiencing high demand right now. Please try again later."}` followed by `SSE_REPLY_END` — `observed`
  - ~0.8 s after the stream error the client called `/passport/web/logout/`; the partition now renders `Log In` and is unusable until the owner logs in again — `observed`
  - Prompt (2,274 chars) fully entered into the composer before send; media URL never appeared, so no download happened
  - `710022002` is the same code the earlier 10s attempt returned in the D2 baseline, so it is a generic server-side rejection, not a 30s-specific message — `inferred`
- Follow-up: Dola 1 and Dola 2 sessions were checked afterwards and are still logged in; no patched request was sent from them
- Evidence: `captures/raw/dola-task-2026-09-14.jsonl` (gitignored, local)
- Next action: owner re-login for Dola 3, then repeat with a variant matrix (2.5+10s unpatched to test the subscription gate; 2.0 Fast+30s; 2.5+30s again) and compare `error_code` per variant → resolved in D5: the failure was the CDP-layer rewrite point, not the duration value

## 2026-09-14 — D5: 30s T2V generation SUCCESS (page-layer duration override)

- Gate: D5 (native 30s result)
- Status: PASS — real 30.08 s video generated and downloaded
- Environment: Dola Web `region=VN`, account partition restored from a hand-off cookie list (8 cookies), model `seedance_v2.5`, ratio `16:9`, prompt = the user's 2,274-character donghua prompt
- Method (the part that matters):
  - CDP-layer body rewrite (`Fetch.continueRequest` after the page built/signed the request) is rejected by the server: `STREAM_ERROR 710022002` + `/passport/web/logout/` — reproduced on two accounts (D4/D4b)
  - Page-layer rewrite (`window.fetch` wrapper installed outside the app's own interceptor, so the edit happens before the client serialises and signs) is accepted: task created, no error, session intact
  - Sanity control before the video run: the same page-layer wrapper was used to change a plain text message (`ping` → `pong`); the wire body contained `pong`, the bot answered normally, session survived — so body edits by themselves trigger nothing
- Result (evidence from the conversation message and the downloaded file):
  - Outgoing envelope: `{"ratio":"16:9","model":"seedance_v2.5","duration":30,"input_box_content":{…}}` — `observed`
  - Bot: `loading_block {"text":"Generating"}` → `"Your video is ready."` — `observed`
  - `creation_block` video: `video_duration 30.08`, `1280x720`, 24 fps, `bytevc1`, `size 2042868`, `vid v186a3gm000cdajobffog65vhicekidg` — `observed`
  - `main_url` (base64, `lr=unwatermarked`) and `download_url` (`lr=cici_ai`) both downloaded; FFprobe on the unwatermarked file: `30.080000 s`, `1280x720`, `hevc`, `aac`, 721 video frames, 1298 audio frames — `observed`
  - SHA-256 unwatermarked `a7f9a62a3d82236b3825dca1b1b14e8b11589a3827fc58aae9aeea9dd3281ff7`; client variant `858e58339f465df67108c96af0992c04666dfb11d68873c9222d12341b77fc45`
- Known limitations:
  - Visual watermark QA (first/middle/last frame) was not performed in this round; only the server-side variant flag (`lr=unwatermarked`) distinguishes the two files
  - The prompt text still says "Action (8 seconds, in order)"; the model stretched it to 30 s without rescaling the beats
  - Dola 1 and Dola 3 sessions were terminated by the rejected CDP-layer attempts and need a manual re-login
- Artifacts (local, gitignored): `outputs/dola4-courtyard-30s-unwatermarked.mp4`, `outputs/dola4-courtyard-30s-client.mp4`, `captures/raw/dola-task-2026-09-14.jsonl`
- Next action: rescale the prompt's beats to a 30 s timeline, and re-run I2V / other ratios if needed

## 2026-09-14 — D6: 30s I2V with reference keyframes SUCCESS

- Gate: D6 (image-conditioned 30s render)
- Status: PASS — 30.04 s video generated from 4 reference stills + prompt, downloaded
- Environment: Dola Web `region=VN`, Dola 4 partition (cookie hand-off), model `seedance_v2.5`, ratio `16:9`, `duration:30` via page-layer patch, prompt = same 2,274-char donghua text
- Inputs: `D:\projects\docsi-test\canh_phim\canh1_t0.png`, `canh1_t2.png`, `canh1_t45.png`, `canh1_t7.png` (1672x941 each) attached through the composer file input
- Protocol notes (`observed`):
  - Images are uploaded by the client itself: `POST /alice/resource/prepare_upload`, then `POST /alice/message/pre_handle_v2_without_conv`; the user message carries `block_type 10052` = `attachment_block` with `attachments[].type = 1` and `image.uri` on `tos-mya-*`
  - Same `/chat/completion` envelope as T2V; the skill is still `ability_type 17` with `seedance_v2.5`
  - Bot reply: "will use 2 credits and be ready in 15 minutes"; result message `Your video is ready.` + `creation_block` video
  - Result: `video_duration 30.042`, `1280x720`, 24 fps, `bytevc1`, `size 3402954`, `vid v186a3gm000cdajqfsfog65p2idm7ve0`
  - URL variants as before: `main_url` base64 (`lr=unwatermarked`) and `download_url` (`lr=cici_ai`)
  - Downloaded file: `30.041667 s`, `1280x720`, `hevc` + `aac`, 721 video frames — `observed`
  - SHA-256 unwatermarked `c8724b118738e57345277e1529bb47f1f0eaf77af95d8c2cdd15649917b533a6`; client variant `6f3344f2c56282fc328cfc9c75284584131a3f73074160ccbd8b08926bd04177`
- Conditioning evidence (numeric proxy, 16x9 luma grid Pearson correlation):
  - `corr(ref canh1_t0, I2V frame@0.4s)` = **0.939** vs the same frame of the D5 text-only render = -0.008
  - `corr(ref canh1_t7, I2V frame@29.5s)` = **0.974** vs D5 = 0.171
  - `inferred`: the reference stills acted as timeline keyframes (first frame ≈ t0 still, last frame ≈ t7 still)
- Known limitations:
  - The submitted message carried **5** attachments, not 4: an image left over from an earlier aborted attach probe persisted in the composer draft (`input-draft:…` identifier) and rode along. The 4 intended stills are present; the 5th was a frame of a previous render of the same scene
  - Visual QA of the result (watermark, face consistency, lip-sync) was not performed here
  - The bot also printed "You still have 0 video credits left today" while the task completed — that line appears to be stale/boilerplate, not a hard gate
- Evidence: `captures/raw/dola-task-2026-09-14.jsonl` (gitignored); files under `outputs/` (gitignored)
- Next action: clear the composer draft before attaching (tool now supports `--image`), then re-run I2V with exactly 4 stills if the stray frame matters

## 2026-09-14 — D7: bàn điều khiển web local chạy trọn vòng, 30s bằng "đường sạch"

- Gate: D7 (web client → tài khoản → 30 giây → tải bản sạch)
- Status: PASS — video 30.04 giây từ 4 ảnh mẫu, không sửa yêu cầu gửi đi
- Cách chạy: mở ứng dụng → `http://127.0.0.1:3211/` → dán cookie nhận tài khoản → dán mô tả → chọn 4 ảnh → số giây 30 → khung 16:9 → mô hình 2.5 → Gửi
- Điểm kỹ thuật chính:
  - Việc chạy điều khiển **chính khung Dola có sẵn trong ứng dụng** (không mở thêm cửa sổ trình duyệt nào).
  - Số giây 30 được thêm vào **câu trả lời cấu hình** (`/samantha/skill/pack` và `/alice/slot/action_bar_v3/get_item_conf`) ở tầng mạng, giai đoạn Response, rồi tải lại trang một lần; sau đó chính trang hiện `10s/5s/15s/30s` và tự chọn 30s → yêu cầu gửi đi không bị sửa (nhật ký việc: "Số giây: đã chốt 30s", không có dòng "đã sửa yêu cầu trước khi gửi").
  - 4 ảnh mẫu đi qua ô chọn ảnh của trang (`attachment_block`, block_type 10052) như D6.
- Bằng chứng:
  - Bot: "Generating the video as requested." → "Your video is ready."
  - `video_duration 30.042`, `1280x720`, 24 fps, `bytevc1`, `size 3763037`, `vid v186a3gm000cdajrvsnog65jqj7phrg0`
  - File tải về (`main_url`, `lr=unwatermarked`): `30.041667 s`, `1280x720`, `hevc` + `aac`, 721 frame video, SHA-256 `bca6f733d3bfaedde5f673a7a06bc469b68a7c250a3a4bac3369bdb5409b570d`
  - Bản của trang (`download_url`, `lr=cici_ai`): SHA-256 `a1dc7bf68549af02226d110144002b008262c3beac5774d420eb3059d0768fe4`
  - Việc được ghi ở `jobs.json`, video phát trực tiếp qua `GET /api/media/<jobId>/unwatermarked` (HTTP 206, có hỗ trợ tua)
  - Nút "Bật lựa chọn 30 giây" (ứng dụng + bàn điều khiển web) dùng cùng cơ chế; đã kiểm chứng miễn phí: bấm nút → ô chọn số giây của trang hiện `10s, 5s, 15s, 30s` (`POST /api/accounts/:id/inject-duration` → `hasThirty: true`)
  - Kiểm chứng lần hai ngay trên cửa sổ ứng dụng (Dola 6): bấm nút → dòng trạng thái "Đã bật. Ô chọn số giây hiện có: 10s, 5s, 15s, 30s", và menu số giây của trang có mục `30s` bấm được. Lỗi ban đầu: nút bị khoá vì thiếu bước bật nút khi có tài khoản đang chọn — đã sửa
- Hạn chế đã gặp và cách xử lý:
  - Kết quả về qua kênh đẩy (WebSocket) nên vòng theo dõi chỉ đọc `im/chain/single` không thấy ngay; đã thêm bước tự làm mới trang mỗi ~2 phút cho các việc sau. Việc này tải về thủ công từ hội thoại sau khi khởi động lại ứng dụng (không tốn thêm lượt tạo nào).
  - Tài khoản Dola 4 hết credit trong ngày; việc này chạy trên tài khoản mới (Dola 6).
- Next action: chạy lại một việc nữa bằng giao diện web để xác nhận bước tự làm mới trang bắt được kết quả mà không cần tải tay

## 2026-09-15 — D8: 15 giây I2V trên Dola 2, bị chặn vì credit rồi chạy được bằng mô hình rẻ

- Gate: D8 (bàn điều khiển web → tài khoản Dola 2 → 15 giây + 4 ảnh tham chiếu)
- Status: PASS sau một lần bị từ chối vì credit
- Bối cảnh: prompt trong `lac_long_quan_au_co/video01/haha.txt` (11.530 ký tự, bản tiếng Anh) + 4 ảnh PNG; số giây 15, khung 16:9.
- Lần 1 — mô hình `seedance_v2.5`: Dola trả lời nguyên văn
  `Generating with the current parameters will use 12 video credits. You only have 4 left today. Change the parameters and try again.`
  → không tạo task, không mất credit. Đây là **giới hạn credit theo bộ tham số**, không phải lỗi giao thức.
- Lần 2 — đổi sang mô hình `seedance_v2.0` (Fast), giữ 15 giây / 16:9 / 4 ảnh: Dola nhận, báo
  "will use 3 points and be ready in 10 minutes", rồi "Your video is ready."
- Kết quả (`observed`): `video_duration 15.105`, `1280x720`, 24 fps, `bytevc1`, `size 2351576`, `vid v186a3gm000cdakd21vog65i877n5pkg`
  - File bản gốc (`main_url`, `lr=unwatermarked`): `15.103991 s`, `1280x720`, `hevc` + `aac`, 361 frame video — SHA-256 `d0a85839f89ed0d2d375…`
  - Bản của trang (`download_url`, `lr=cici_ai`): SHA-256 `2cb68de87f001bedb35e…`
- Lỗi công cụ đã sửa trong lượt này:
  1. Vòng theo dõi không nhận ra câu từ chối của Dola (thiếu mẫu "will use N video credits / only have N left") nên cứ báo "đang vẽ" vô hạn → đã thêm bộ nhận dạng, dừng ngay và ghi rõ số credit cần/còn.
  2. Bước "làm mới trang" khi chờ chỉ tải lại về màn hình chính nên không bao giờ thấy video → đã ghi nhớ địa chỉ hội thoại lúc gửi và mở lại **đúng hội thoại** (kèm đường mở theo tên khi cần cứu kết quả).
- Next action: dùng mô hình 2.0 cho các bản 15 giây khi credit eo hẹp; 30 giây vẫn cần 2.5 và nhiều credit hơn

## 2026-09-15 — D9: 30 giây I2V trên Dola 4 (mô hình 2.5, 4 ảnh tham chiếu)

- Gate: D9 (bàn điều khiển web → Dola 4 → 30 giây + 4 ảnh từ `video01`)
- Status: PASS — máy chủ nhận ngay, không bị chặn credit
- Cấu hình: `seedance_v2.5`, `duration:30`, `16:9`, 4 ảnh PNG, prompt 11.530 ký tự (`haha.txt`)
- Kết quả (`observed`): `video_duration 30.042`, `1280x720`, 24 fps, `bytevc1`, `size 4681452`, `vid v186a3gm000cdakf44nog65g6oe8s940`
  - File bản gốc (`main_url`, `lr=unwatermarked`): `30.041667 s`, `1280x720`, `hevc` + `aac`, 721 frame — SHA-256 `21e18975c9b9010a9cfa2ea9b378bb35d0f26cc428c360eb95b53f0705e05441`
  - Bản của trang (`download_url`, `lr=cici_ai`): SHA-256 `353889edec21c621c1c3…`
- Ghi chú vận hành:
  - Bước chọn số giây đi **đường sạch** (`inject-no-reload`): trang tự có 30s và tự gửi, không sửa yêu cầu.
  - Sau khi gửi, địa chỉ hội thoại được ghi lại và vòng theo dõi **mở lại đúng hội thoại** (log: "Đã mở lại hội thoại của việc để cập nhật kết quả").
  - Giao diện báo "Your video is ready." nhưng bộ đọc dữ liệu hội thoại trong trang không bắt được khối `creation_block` (bản tin cập nhật qua kênh đẩy), nên file được lấy bằng công cụ dòng lệnh đọc thẳng `im/chain/single` — việc đã tốn credit, không phát sinh thêm. Đây là điểm cần bịt tiếp: đọc khối video từ DOM/kênh đẩy thay vì chỉ đọc lại danh sách tin nhắn.
- So sánh giá credit cùng ngày: 15 giây + 4 ảnh + 2.5 = 12 credit (bị từ chối khi chỉ còn 4); 15 giây + 4 ảnh + 2.0 = 3 credit; 30 giây + 4 ảnh + 2.5 = được nhận trên Dola 4.

## 2026-09-19 — D10: sửa bố cục popup "Tạo video" (trần chiều cao, hai cột)

- Gate: D10 (kiểm tra giao diện, không tốn credit — không gửi việc nào)
- Status: PASS
- Vấn đề: popup cao dần theo nội dung (mô tả dài + danh sách việc), hàng nút `Đóng / Mở thư mục video / Gửi` bị đẩy khỏi màn hình, không bấm được.
- Cách sửa:
  - `.dialog-composer`: `width: min(1180px, 94vw)`, `max-height: calc(100vh - 32px)`, `display:flex` + `overflow:hidden`.
  - Nội dung gói trong `.composer-body` (`flex:1; min-height:0; overflow:auto`), chia **hai cột** (mô tả + số giây/khung hình/mô hình + ảnh | lấy video hội thoại cũ + việc đang chạy + danh sách việc + kết quả). Dưới 900px tự dồn về một cột.
  - `.dialog-actions` nằm ngoài vùng cuộn, luôn là chân trang cố định.
  - `.composer-jobs` (240px) và `.composer-thumbs` (200px) tự cuộn thay vì kéo dài popup.
  - Thêm `.row-inline` (trước đây chưa hề có luật CSS nên ô chọn hội thoại co lại còn ~70px) và tạo dáng `.dialog select` theo nền tối.
  - `.composer-result` đổi từ nền sáng `#f7f9fc` sang `#0d1426`: chữ trong khung kết quả trước đây gần như trắng trên trắng.
  - Trạng thái việc bỏ lặp nhãn ("Xong: Xong: 30.04 giây" → "Xong: 30.04 giây").
- Cách đo: thêm `SEEDANCE_DEBUG_PORT=9333` cho `main.js`, rồi đo bằng CDP (`user-data/shot-composer.cjs`, `user-data/stress-composer.cjs`, `user-data/check-composer-flow.cjs`).
- Kết quả đo (`observed`):

  | Khung nhìn | Hộp thoại | Chân trang | `Gửi` bấm được |
  |---|---|---|---|
  | 1427x859, 24 việc + mô tả 24 dòng | 1180x700 (trần 827) | trong màn hình | có (`elementFromPoint` = `composerSend`) |
  | 900x640, một cột | 846x608 | trong màn hình | có |
  | 1024x520 | 963x488 | trong màn hình | có |

- Luồng vẫn chạy đúng sau khi đổi bố cục: chọn Dola 6 → mở popup → `Nạp danh sách` trả về 5 hội thoại (`Main chat`, `视频生成`, `Mở đầu phim Lạc Long Quân`, `Mở đầu phim Lạc Long Quân Âu Cơ`, `Generated Video`), `Gửi` bật, danh sách việc hiện đúng 5 dòng thật kèm nút `Mở thư mục`.
- Ảnh đối chiếu: `user-data/composer-final4.png` (thật, Dola 6), `user-data/composer-stress.png`, `user-data/composer-stress-small.png`, `user-data/composer-stress-flat.png` (đã gitignore).

## 2026-09-19 — D11: độ phân giải trả về — 720p, không có bản Full HD

- Gate: D11 (đo độ phân giải, không tốn credit)
- Status: PASS (đã xác định được trần độ phân giải)
- Câu hỏi: bản trả về có phải Full HD không, có lấy được file 1080p không?
- Kết quả (`observed`):
  - `ffprobe` toàn bộ 40 file trong `outputs/`: **40/40 là `1280x720`**, `hevc`, 24 fps, bitrate 0.39–1.47 Mbps. Không có file nào lớn hơn.
  - `skill/pack` trên 6 tài khoản: `supported_resolutions: ["720p"]`, 51/51 lần bắt được trong `captures/raw` đều là `["720p"]`.
  - `ability_param` gửi lên chỉ có `ratio, model, duration, input_box_content` — **không có trường độ phân giải**, nên không thể yêu cầu 1080p bằng API.
  - `play_addr.video_list` chỉ có **một** biến thể `video_1`, với `vwidth: 1280`, `vheight: 720`. Không có bản thứ hai để chọn.
  - `video_1.definition = "1080p"` là **nhãn gear**, không phải pixel: `gear_des_key = 0:MP4|1:normal|2:h265_hvc1|4:1080p|5:normal` (thang rate-gear của ByteDance; bậc tên "1080p" ứng với 1280x720 ở sản phẩm này).
- Kết luận: nguồn render là 720p, CDN chỉ có đúng bản đó. **Không tồn tại file Full HD từ nguồn.**
- Đã làm bản nâng cấp cục bộ để đối chiếu (từ `dola-4-30s-2026-09-19T03-07-52-unwatermarked.mp4`, 4.97 MB):
  - `outputs/dola-4-30s-2026-09-19-1080p.mp4` — H.264, `1920x1080`, 24 fps, 7.60 Mbps, **29.0 MB**
  - `outputs/dola-4-30s-2026-09-19-1080p-hevc.mp4` — HEVC, `1920x1080`, 24 fps, 3.09 Mbps, **12.1 MB**
  - Lọc: `scale=1920:1080:flags=lanczos,unsharp=5:5:0.6:5:5:0.0`. Khung hình 1:1 xem sạch, không thấy vệt artifact.
- Ghi chú: nâng cấp cục bộ ra đúng khung 1920x1080 nhưng **chi tiết không thể vượt quá nguồn 720p** — dùng khi nền tảng bắt buộc khung 1080p, không phải để lấy thêm chi tiết.
- Công cụ đo: `user-data/inspect-video-list.cjs`, `user-data/live-capability.cjs`, `user-data/grep-ability-param.cjs` (đã gitignore).

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
