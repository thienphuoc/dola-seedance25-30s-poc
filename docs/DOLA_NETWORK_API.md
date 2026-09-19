# Dola Web Network API — Ghi chú giao thức (D2 baseline)

> Nguồn: quan sát mạng **thụ động** trên phiên đăng nhập của chính người dùng,
> qua CDP debugger gắn vào webview trong `apps/desktop` (bộ quan sát trong
> `apps/desktop/src/main.js`, ghi JSONL đã làm sạch vào `captures/raw/` — thư mục
> gitignored). Không có request nào bị chế tạo hay phát lại để thu thập dữ liệu này.
>
> Ký hiệu nguồn thông tin theo kỷ luật repo: `observed` (bắt thấy trực tiếp),
> `inferred` (suy luận có căn cứ), `UNKNOWN` (chưa xác minh). Mọi giá trị
> định danh cá nhân (device id, uuid, conversation id…) đã thay bằng
> `<placeholder>`.

---

## 1. Ba kênh truyền

| Kênh | Địa chỉ | Vai trò |
| --- | --- | --- |
| REST JSON (IM-style) | `https://www.dola.com/im/*`, `/alice/*`, `/samantha/*` | Cấu hình, danh sách hội thoại, poll trạng thái, mark read… |
| Completion stream | `POST https://www.dola.com/chat/completion` | **Gửi tin nhắn / submit task** (prompt, kỹ năng, tham số tạo video). Response là stream |
| WebSocket push | `wss://wss-normal-i18n.dola.com/ws/v2` | Đẩy realtime (tiến độ, tin nhắn mới). Frame rỗng định kỳ = heartbeat; frame dữ liệu dạng nhị phân |

Quan sát được **không có HTTP SSE riêng cho phần IM** — tiến độ task đến qua
WebSocket push và/hoặc vòng poll REST. Response của `/chat/completion` là
stream (chưa lấy được nội dung — xem mục 8).

## 2. Hằng số trên URL (app-level, `observed`)

Query string phổ biến trên các endpoint:

```text
aid=495671              # app id của Dola web
real_aid=495671
version_code=20800
pc_version=3.36.6       # doubao_pc_version tương tự
device_platform=web
doubao_device_platform=web
language=en
region=VN               # theo IP/tài khoản
sys_region=VN
tz_name=Asia%2FSaigon
samantha_web=1
use-olympus-account=1
device_id=<device_id>   # định danh trình duyệt của phiên — KHÔNG ghi ra git
web_id=<web_id>         # như trên
tea_uuid=<tea_uuid>
fp=verify_<random>      # dấu vết xác thực thiết bị — KHÔNG ghi ra git
web_tab_id=<uuid>
```

Các giá trị `<device_id>` / `<web_id>` / `<tea_uuid>` / `fp` là định danh phiên
của người dùng: chỉ tồn tại trong capture local, không đưa vào repo.

## 3. POST `/chat/completion` — submit task tạo video (chi tiết nhất)

Đây là endpoint duy nhất để gửi tin nhắn/task lên bot Dola. Cấu trúc dưới đây
được trích từ gói tin **thật** khi tạo video Seedance 2.5 / 10s / T2V
(nguồn: `observed`, đã làm sạch).

### 3.1 URL

```text
POST https://www.dola.com/chat/completion?
     aid=495671 & device_id=<device_id> & device_platform=web &
     doubao_device_platform=web & doubao_pc_version=3.36.6 &
     fp=verify_<random> & language=en & pc_version=3.36.6 &
     pkg_type=release_version & real_aid=495671 & region=VN &
     samantha_web=1 & sys_region=VN & tea_uuid=<tea_uuid> &
     tz_name=Asia%2FSaigon & use-olympus-account=1 & version_code=20800 &
     web_id=<web_id> & web_platform=browser & web_tab_id=<uuid>
```

### 3.2 Bố cục body (top-level)

```jsonc
{
  "client_meta":  { /* hội thoại + quyền thiết bị */ },
  "messages":     [ /* tin nhắn người dùng dạng content_block */ ],
  "option":       { /* cờ gửi: regen, sse, create conversation… */ },
  "chat_ability": { /* KHU VỰC QUAN TRỌNG NHẤT: kỹ năng + tham số video */ },
  "user_context": [],          // mảng rỗng khi quan sát
  "ext":          { /* metadata vận hành: skill, model, region, phiên */ }
}
```

### 3.3 `client_meta` — `observed`

```jsonc
{
  "conversation_id": "<conversation_id>",   // conv hiện tại (server tạo khi chat mới)
  "bot_id":          "<bot_id>",            // id bot trợ lý Dola (hằng số chung, không phải user id)
  "last_section_id": "<section_id>",
  "last_message_index": 5,
  "local_permissions": [                    // quyền thiết bị client khai báo
    { "permission_name": "ACCESS_COARSE_LOCATION",  "status": 1 },
    { "permission_name": "ACCESS_FINE_LOCATION",    "status": 1 },
    { "permission_name": "ACCESS_BACKGROUND_LOCATION", "status": 1 }
  ]
}
```

### 3.4 `messages` — tin nhắn người dùng, `observed`

```jsonc
[
  {
    "local_message_id": "<uuid>",
    "content_block": [
      {
        "block_type": 10000,               // khối văn bản thuần
        "block_id": "<uuid>",
        "parent_id": "",
        "content": {
          "text_block": {
            "text": "Generated video: <prompt người dùng>",
            "icon_url": "", "icon_url_dark": "", "summary": ""
          }
          // ~90 block type khác đều = null (search/image/code/artifact…)
        },
        "meta_info": [],
        "is_finish": true
      }
    ],
    "message_status": 0
  }
]
```

Ghi chú: với task video, UI tự gắn tiền tố `Generated video: ` vào prompt
trong khối văn bản. Danh sách block type đầy đủ (`creation_block`,
`super_task_block`, `gen_image_block`…) cho thấy cùng một endpoint phục vụ
mọi loại kỹ năng.

### 3.5 `option` — `observed` (trích trường đáng chú ý)

```jsonc
{
  "create_time_ms": 1789357971855,
  "is_regen": true,                        // gói này là lần bấm Retry
  "need_create_conversation": false,       // true khi tin đầu tiên của conv mới
  "need_deep_think": 0,
  "conversation_init_option": { "need_ack_conversation": true },
  "sse_recv_event_options": { "support_chunk_delta": true },
  "message_from": 0,
  "scene_type": 0,
  "unique_key": "<uuid>",
  "model_config":  { "model_item_key": "0", "model_extra_params": {} },
  "aggregate_params": {
    "conversation_mode": "", "mode_id": "", "model_item_key": "0",
    "agent_mode": "", "reasoning_effort": "", "provider_id": ""
  }
  // … các cờ còn lại: is_audio, tts_switch, click_clear_context,
  // from_suggest, is_replace, resend_for_regen, recovery_option…
}
```

### 3.6 `chat_ability` — tham số tạo video (trọng tâm)

```jsonc
{
  "ability_type": 17,     // 17 = kỹ năng Create Videos — observed
  "ability_param": "…"    // chuỗi JSON lồng nhau, parse ở dưới
}
```

`ability_param` sau khi parse — `observed`:

```jsonc
{
  "model": "seedance_v2.5",        // tên model phía server: dấu gạch dưới!
                                   // UI hiển thị "Dreamina Seedance 2.5"
  "duration": 10,                  // giây — đúng giá trị UI cho phép
  "input_box_content": {
    "user_input_content": "<prompt>",
    "reply_message_format": "Generated video: %s"
  }
}
```

Phát hiện quan trọng cho provider:

1. **Không có field ratio/resolution** trong envelope (`UNKNOWN`): bot trả lời
   "16:9" chỉ là suy luận từ prompt/mặc định server (`inferred`). Cần bắt thêm
   task có đổi Ratio trên UI để xác minh nó đi theo đường nào.
2. **Tên model** ở server là `seedance_v2.5` (underscore), không phải tên hiển thị.
3. Kỹ năng khác sẽ có `ability_type` khác (chưa khảo sát — `UNKNOWN`).

### 3.7 `ext` — `observed` (trích trường chính)

```jsonc
{
  "input_skill":  "{\"skill_id\":\"17\",\"skill_type\":17}",
  "llm_model_type": "1751879255",
  "model_type":     "1751879255",
  "bot_id": "<bot_id>", "bot_source": "BotStudio",
  "inner_app_id": "495671", "inner_real_app_id": "495671",
  "inner_region": "VN", "inner_env": "prod",
  "inner_platform": "web", "inner_pc_version": "3.36.6",
  "inner_samantha_web": "true",
  "inner_did": "<device_id>", "inner_ttwid": "<ttwid>", "inner_tt_wid": "<ttwid>",
  "inner_tea_uuid": "<tea_uuid>",
  "inner_log_id": "<server_log_id>",
  "chat_id": "<conversation_id>",
  "brief": "<80 ký tự đầu của prompt>",
  "enc_strategy": "noop", "archive_state": "mask_init",
  "msg_lang…", "libra_versions…"
  // …
}
```

### 3.8 Nguồn cấu hình UI của kỹ năng video (model / ratio / duration) — `observed`

Hai endpoint quyết định những gì người dùng nhìn thấy trong panel Create Videos
và trong `AI Creation → Video`:

| Endpoint | Vai trò | Trường khóa |
| --- | --- | --- |
| `POST /samantha/skill/pack` body `{"skill_type":17}` | Khả năng theo model | `data.video_generation.meta.model_capability.<model>.supported_durations` / `supported_resolutions` |
| `POST /alice/slot/action_bar_v3/get_item_conf` body `{"language_code","bot_id","item_ids":[…]}` | Toolbar thật của composer | `item_list.<id>.instruction_conf.template` (JSON lồng) → `selector_list` |

Trong `selector_list` có các selector `item_type:3`:

```jsonc
{ "label": "Model",    "key": "model",          "option_list": [
    { "display_text": "Dreamina Seedance 2.5",       "option_key": "seedance_v2.5", "extra": { "model": "seedance_v2.5", "subs_only_tag": "enhanced", "sub_display": "Best quality • 5x credit usage" } },
    { "display_text": "Dreamina Seedance 2.0 Fast",  "option_key": "seedance_v2.0" },
    { "display_text": "Dreamina Seedance 1.0",       "option_key": "seedance_v1.0" } ] }
{ "label": "Duration", "key": "video-duration", "option_list": [
    { "display_text": "5s",  "option_key": "5" },
    { "display_text": "10s", "option_key": "10" } ] }
{ "label": "Ratio",    "key": "…",              "option_list": [ "1:1", "3:4", "4:3", "9:16", "16:9", "21:9" ] }
```

Ghi chú (`observed`, 2026-09-14, `region=VN`, tài khoản free):

- `option_key` của duration chính là giá trị `duration` gửi lên server: `"5"` / `"10"`.
- Danh sách duration **không** đổi khi chọn `seedance_v2.5` — vẫn chỉ 5s/10s.
- Cấu hình không chứa `15s`, `30s` hay giá trị `30` nào.
- Model 2.5 mang `subs_only_tag: "enhanced"` trong khi profile trả
  `membership_info.level = "free"` (`inferred`: đây có thể là gói quyết định
  15s/30s; chưa kiểm chứng).
- Đổi model/duration/ratio trên UI đi kèm các request
  `/alice/slot/action_bar_v3/update_order` (ghi nhớ lựa chọn) như mục 4.

## 4. Vòng đời một task video (quan sát từ network)

```text
1. POST /alice/slot/action_bar_v3/update_order     — ghi nhớ lựa chọn toolbar
2. POST /samantha/skill/pack        {"skill_type":17}  — nạp pack kỹ năng video
3. POST /im/message/send_rate_limit {"cmd":2260}       — kiểm tra giới hạn gửi
4. POST /chat/completion                              — SUBMIT (mục 3)
5. Conv mới xuất hiện: /im/conversation/info {"cmd":1110},
   /im/chain/single {"cmd":3100} (pull tin nhắn), mark_conv_read {"cmd":2100}
6. Vòng poll lặp: /im/chain/recent_conv {"cmd":3200} + /im/conversation/info
   mỗi vài giây; tiến độ thật được đẩy qua WebSocket (mục 5)
7. Hoàn thành: tin nhắn kết quả (chứa media URL) — CHƯA bắt được body
   (mục 8) → ánh xạ sang D4 còn thiếu bằng chứng này
```

## 5. WebSocket `wss://wss-normal-i18n.dola.com/ws/v2`

- Kết nối kèm query: `device_platform=web`, `version_code=20800`,
  `access_key=<access_key>`, `fpid=1289`, `aid=489823`, `ttwid=<ttwid>` …
- Frame heartbeat rỗng gửi/nhận đều đặn (`observed`); frame dữ liệu nhị phân
  (trang tự decode) — không decode nội dung, chỉ ghi nhận có truyền.
- Mỗi lần reload trang tạo 1 kết nối mới.

## 6. Endpoint phụ trợ quan sát được (tóm tắt)

| Nhóm | Endpoint | Nội dung |
| --- | --- | --- |
| Boot | `/alice/basic/launch`, `/alice/user/launch`, `/alice/im/launch`, `/alice/profile/self*` | Cấu hình phiên, user brief |
| Toolbar | `/alice/slot/action_bar_v3/*` | Cấu hình nút nhanh, ghi nhớ lựa chọn |
| Skill | `/samantha/skill/recommend`, `/samantha/skill/pack` | Gợi ý / nạp kỹ năng |
| Commerce | `/alice/commerce/sale/subscription/entry/config/` | Cấu hình gói/credit |
| IM | `im/chain/recent_conv` (3200), `im/conversation/info` (1110), `im/conversation/batch_get` (1111), `im/chain/single` (3100), `im/message/send_rate_limit` (2260), `im/message/mark_conv_read` (2100) | Lõi hội thoại |
| Telemetry | `POST /chat/`, `POST /chat/local_*` với `{"ev_type":"batch","list":[…]}` | Log hành vi gộpbatch |

Body IM chuẩn: `{"cmd":<số>,"uplink_body":{…},"sequence_id":"<uuid>","channel":2,"version":"1"}`.

## 7. Phương pháp quan sát + làm sạch

- Observer gắn `webContents.debugger` (CDP 1.3) vào từng webview của tài khoản
  trong `apps/desktop/src/main.js`; chỉ ghi: method, URL (đã redact query
  nhạy cảm), status, mimeType, body (tối đa 8KB, redact key
  cookie/token/authorization/password/sessionid).
- Sự kiện WebSocket: `ws_created`, `ws_frame_sent/recv` (truncated).
- File: `captures/raw/desktop-<YYYY-MM-DD>.jsonl` — **gitignored**, không rời máy.
- Hạn chế đã biết: Electron debugger không phát `Network.loadingFinished` nên
  **chưa lấy được response body** (kể cả stream completion). Submit body được
  lấy nhờ `Network.getRequestPostData`.

## 8. Việc còn thiếu / bước tiếp theo

- [x] Bắt nội dung stream `/chat/completion` và tin nhắn hoàn thành (media URL) → D5
- [ ] Xác minh đường đi của `ratio` khi đổi trên UI
- [x] I2V: ảnh tham chiếu đi qua attachment_block (block_type 10052) — xem mục 10
- [x] 30s T2V: hoàn tất (2026-09-14) — xem mục 9. UI ba tài khoản local chỉ có
  `5s`/`10s` (D3); override `duration` ở **tầng page** được server chấp nhận và
  trả về video 30.08s (D5). Override ở **tầng CDP** thì bị từ chối và mất session (D4).

## 9. Override `duration` — hai tầng can thiệp, hai kết quả khác nhau

Envelope `/chat/completion` là JSON do client dựng, nên sửa được tại chỗ. Nhưng
**sửa ở tầng nào quyết định kết quả**, vì request còn đi qua bước ký của chính
client:

| Tầng | Cách làm | Kết quả đo được (2026-09-14, `seedance_v2.5`, `duration:30`, `ratio:16:9`) |
| --- | --- | --- |
| CDP (`Fetch.enable` → `Fetch.requestPaused` → `Fetch.continueRequest`) | Sửa body **sau** khi trang đã dựng và ký request | `200` + `text/event-stream` + `STREAM_ERROR {"error_code":710022002,"error_msg":"We are experiencing high demand right now. Please try again later."}` + `SSE_REPLY_END`, rồi client gọi `/passport/web/logout/` — session chết. Lặp lại y hệt trên 2 tài khoản khác nhau |
| Page (`window.fetch` wrapper, gắn **ngoài** interceptor của app) | Sửa body **trước** khi client serialize/ký | Request đi qua sạch: bot tạo conversation, trả `loading_block {"text":"Generating"}` rồi `video_duration: 30.08`. Không logout, không lỗi |

Cách gắn wrapper ở tầng page (thứ tự quan trọng — wrapper của mình phải nằm ngoài
wrapper của app để chạy trước khi request được dựng/ký):

```js
const orig = window.fetch;
window.fetch = function (input, init) {
  if (String(input).includes('/chat/completion') && init && typeof init.body === 'string') {
    const outer = JSON.parse(init.body);
    const param = JSON.parse(outer.chat_ability.ability_param);
    param.duration = 30;                       // giá trị UI không cho chọn
    outer.chat_ability.ability_param = JSON.stringify(param);
    init = Object.assign({}, init, { body: JSON.stringify(outer) });
  }
  return orig.call(this, input, init);
};
```

Kết quả D5 (`observed`, tài khoản free, `region=VN`, model `seedance_v2.5`):

```text
request  : {"ratio":"16:9","model":"seedance_v2.5","duration":30,"input_box_content":{…}}
stream   : loading_block {"text":"Generating"} → "Your video is ready."
message  : creation_block type=2, video_duration 30.08, vwidth 1280, vheight 720,
           fps 24, codec bytevc1, size 2042868, vid v186a3gm000cdajobffog65vhicekidg
variants : main_url (base64) với lr=unwatermarked  +  download_url với lr=cici_ai
file     : 30.080 s, 1280x720, hevc + aac, 721 frame video / 1298 frame audio
```

Ghi chú:

- `710022002` là mã lỗi chung của server (lần 10s trong D2 baseline cũng gặp),
  không phải thông báo riêng cho 30s.
- Tầng CDP hỏng trước khi server kịp xử lý nội dung: request bị chặn ở lớp kiểm
  tra toàn vẹn, và hình phạt là đăng xuất session — nên đừng dùng lại cách đó.
- `main_url` trong message là **base64** của URL thật; `download_url` là bản
  client dùng (`lr=cici_ai`). Muốn bản gốc thì decode `main_url` (`lr=unwatermarked`).
- Định danh thật (`device_id`, `ttwid`, `fp`, cookie, token) vẫn chỉ nằm trong
  capture local; tài liệu này giữ placeholder.

Định danh thật (`device_id`, `ttwid`, `fp`, cookie, token) vẫn chỉ nằm trong
capture local; tài liệu này giữ placeholder.

## 10. I2V — ảnh tham chiếu đi đường nào (`observed`, 2026-09-14)

Cùng skill `ability_type 17` và cùng envelope `/chat/completion`; khác biệt nằm ở
message: ảnh được client upload trước, rồi gắn vào message dưới dạng attachment.

```text
1. input[type=file] (accept .jpg/.png/.jpeg/.webp, multiple) — composer attach
2. POST /alice/resource/prepare_upload        — xin chỗ upload
3. POST /alice/message/pre_handle_v2_without_conv — xử lý trước khi gửi (chưa có conv)
4. message content_block: block_type 10052 = attachment_block
   { "attachments": [ { "type": 1,
                        "identifier": "input-draft:<uid>:…:<key>",
                        "image": { "uri": "tos-mya-….png", "image_thumb": {…} } } ] }
5. /chat/completion với chat_ability.ability_param = {"model":"seedance_v2.5","duration":…}
```

Kết quả đo được (4 ảnh keyframe 1672x941 + prompt, `duration:30` patch tầng page):

| Trường | Giá trị |
| --- | --- |
| `video_duration` | `30.042` |
| kích thước | `1280x720`, 24 fps, `bytevc1`, `size 3402954` |
| file sau khi tải | `30.041667 s`, `hevc` + `aac`, 721 frame |
| bot báo trước khi chạy | "will use 2 credits and be ready in 15 minutes" |

Kiểm tra ảnh có thật sự điều khiển nội dung (tương quan luma 16x9):

```text
corr(ảnh t0, frame I2V @0.4s)  = 0.939   |  cùng frame ở bản T2V = -0.008
corr(ảnh t7, frame I2V @29.5s) = 0.974   |  cùng frame ở bản T2V =  0.171
```

`inferred`: ảnh tham chiếu đóng vai trò keyframe theo mốc thời gian (đầu ≈ ảnh t0,
cuối ≈ ảnh t7). Lưu ý: composer có thể còn **draft** từ lần trước — attachment cũ
sẽ đi kèm message mới, nên xoá draft trước khi gửi (`--clear-draft`).

