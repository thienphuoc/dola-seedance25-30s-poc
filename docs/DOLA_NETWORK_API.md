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

- [ ] Bắt nội dung stream `/chat/completion` và tin nhắn hoàn thành (media URL) → D4
- [ ] Xác minh đường đi của `ratio` khi đổi trên UI
- [ ] Khảo sát `ability_type` của các kỹ năng khác (image, upload ảnh cho I2V)
- [ ] 30s T2V: **chỉ** thử khi tài khoản có quyền (UI cho chọn 15s/30s) — ngược
  lại ghi nhận và dừng theo gate D3; không chế tạo/sửa `duration` để lách quyền

## 9. Ranh giới thực thi (bắt buộc)

Tài liệu này phục vụ **quan sát và tích hợp chính thống**. Nghiêm cấm trong repo:

- Phát lại/chế tạo request với tham số vượt quyền tài khoản (vd. `duration`
  lớn hơn mức UI cho phép);
- Giả mạo định danh thiết bị (`device_id`, `ttwid`, `fp`…) hoặc vượt region;
- Đưa giá trị định danh thật vào git (chỉ dùng placeholder như trong tài liệu này).
