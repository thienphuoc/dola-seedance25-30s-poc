# Seedance Desktop Studio v0.1

Đây là clean-room 桌面版 POC 的第一阶段。

当前只验证一件事：

> 在一个 Electron 桌面程序中创建多个 Dola 账号，每个账号使用独立 persistent Chromium partition，并由用户在可见 Dola 页面中手动登录。

## Bàn điều khiển web (chạy local)

Mở ứng dụng lên, rồi mở trình duyệt tới:

```text
http://127.0.0.1:3211/
```

Trên đó có đủ một vòng việc:

1. **Tài khoản** — dán mảng cookie JSON của dola.com để nhận tài khoản mới (hoặc chọn
   tài khoản đã lưu, bấm "Kiểm tra đăng nhập" để xem tên tài khoản, bấm "Xoá tài khoản"
   để bỏ). Không thích thì dán bộ cookie khác là xong.
2. **Nội dung** — dán đoạn mô tả.
3. **Ảnh mẫu** — kéo thả hoặc chọn ảnh (png/jpg/webp, tối đa 6 ảnh).
4. **Tuỳ chọn** — số giây (5/10/15/30, mặc định 30), khung hình (16:9/9:16/1:1/3:4/4:3/21:9,
   mặc định 16:9), mô hình (mặc định Dreamina Seedance 2.5).
5. **Gửi** — việc chạy trên chính khung Dola có sẵn trong ứng dụng (không mở thêm cửa sổ
   trình duyệt nào). Theo dõi tiến trình ngay trên trang; xong thì hiện khung xem video,
   kèm nút tải bản sạch `...-unwatermarked.mp4` (file nằm trong thư mục `outputs`).
6. **Lấy video từ hội thoại cũ** — nạp danh sách hội thoại, chọn một hội thoại, bấm
   "Lấy video": ứng dụng mở hội thoại đó trong một **cửa sổ ẩn** (anh không thấy),
   bóc hết video có trong đó và tải cả hai bản về `outputs`. Dùng để lấy lại video của
   những việc đã làm trước đó hoặc của phiên chạy bị gián đoạn.

Ghi chú kỹ thuật:

- **Popup "Tạo video"**: rộng `min(1180px, 94vw)`, cao tối đa `100vh - 32px`, chia hai cột
  (mô tả + số giây/khung hình/mô hình + ảnh ở bên trái; lấy video hội thoại cũ + việc đang
  chạy + danh sách việc + kết quả ở bên phải). Phần thân tự cuộn, hàng nút
  `Đóng / Mở thư mục video / Gửi` là chân trang cố định nên luôn bấm được; dưới 900px tự
  dồn về một cột. Danh sách việc và ảnh thu nhỏ cũng tự cuộn trong khung của nó.
- **Nút "Bật lựa chọn 30 giây"** (có cả trong cửa sổ ứng dụng và trên bàn điều khiển web):
  bấm một lần là trang Dola của tài khoản đó tự có thêm lựa chọn `5s/10s/15s/30s` trong ô
  chọn số giây — dùng được cả khi anh tự thao tác tay trong ứng dụng. Nút này chỉ sửa
  **câu trả lời cấu hình** ở tầng mạng rồi tải lại trang, không gửi gì nên không tốn credit.
  Phải bấm lại sau khi khởi động lại ứng dụng (cơ chế này sống trong phiên chạy của ứng dụng).
- Số giây không có trong bảng chọn của tài khoản được thêm vào **câu trả lời cấu hình**
  ở tầng mạng (CDP `Fetch`, giai đoạn Response) rồi tải lại trang một lần, để chính trang
  tự chọn và tự gửi — yêu cầu gửi đi không bị sửa. Nếu tài khoản không nhận, hệ thống tự
  lùi về đường sửa yêu cầu trước khi gửi (đường đã chạy được ngày 2026-09-14).
- Cửa sổ ứng dụng vẫn là nơi xử lý xác minh: khi Dola hỏi, mở ứng dụng lên làm tay rồi chạy lại.
- Việc đang chạy được lưu ở `user-data/client/jobs.json` (trong thư mục dữ liệu ứng dụng),
  ảnh tải lên ở `client/uploads/`, video ở `outputs/` — đều không vào git.
- API local (chỉ nghe 127.0.0.1): `GET /api/state`, `POST /api/accounts`,
  `POST /api/accounts/:id/check`, `POST /api/accounts/:id/probe` (kiểm tra miễn phí xem
  bảng chọn đã có số giây chưa), `POST /api/uploads`, `POST /api/jobs`, `GET /api/jobs`,
  `POST /api/jobs/:id/cancel`, `GET /api/media/:jobId/(unwatermarked|client)`.
- **Chạy song song nhiều tài khoản**: khoá "đang có việc chạy" tính **theo từng tài khoản**,
  không phải toàn ứng dụng. Tài khoản 1 đang vẽ thì vẫn gửi được việc ở tài khoản 2, và
  ngược lại. Lý do: mỗi tài khoản đã có khung Dola, Chromium partition và cửa sổ ẩn riêng,
  nên chúng không dùng chung tài nguyên nào. Trong cùng một tài khoản thì vẫn chặn — hai việc
  trên một tài khoản sẽ giành nhau cùng một trang Dola và cùng bộ đệm hội thoại.
  "Lấy video từ hội thoại cũ" và "cứu kết quả" cũng theo luật đó: nó xoá và nạp lại bộ đệm
  hội thoại của tài khoản, nên bị chặn khi chính tài khoản đó đang chạy việc, nhưng vẫn chạy
  được trên tài khoản khác. Bấm dừng một việc thì tài khoản đó được giải phóng ngay, không
  phải chờ vòng lặp theo dõi thức dậy.
- **Khung Dola của tài khoản không được chọn vẫn chạy hết nhịp**: webview đặt
  `backgroundThrottling=false`. Không có dòng đó, Chromium bóp hẹn giờ của trang bị ẩn (và cả
  trang đang mở khi cửa sổ ứng dụng mất tiêu điểm) xuống còn ~1 giây/lần — đo được chỉ 3–5
  nhịp thay vì 60 trong 3 giây, chậm 20 lần.
- Cần soi giao diện thì chạy `SEEDANCE_DEBUG_PORT=9333 npm start`; cổng gỡ lỗi chỉ mở trên
  127.0.0.1, dùng để chụp/đo bố cục popup bằng CDP (`user-data/shot-composer.cjs`). Hai phép
  thử cho tính năng chạy song song: `user-data/check-parallel-accounts.cjs` (chạy bằng node
  thường, không cần Electron, không gửi gì) và `user-data/check-parallel-live.cjs` (cần cổng
  gỡ lỗi, đo cả nhịp hẹn giờ và nút Gửi).

## 当前已实现

- Electron 桌面壳；
- 添加多个 Dola 账号；
- 每账号独立 `persist:dola_<id>` partition；
- 每账号一个长期存在的 Dola WebView；
- 账号切换；
- Chromium 自动保留 Cookie / Local Storage；
- 单独清除某个账号的本地会话；
- 不接收、不保存 Google 密码或 TOTP；
- 不实现指纹伪装；
- 不实现账号自动轮换；
- 不实现隐藏 Dola 30s 协议。

## Windows 测试

进入：

```text
apps/desktop
```

执行：

```powershell
npm install
npm start
```

程序启动后：

1. 点击“添加 Dola 账号”；
2. 为账号命名，例如 `Dola A`；
3. 在右侧真实 Dola 页面中自行使用 Google 登录；
4. 再添加 `Dola B`；
5. 用另一个账号登录；
6. 在 A/B 间切换，确认登录态互不影响；
7. 关闭并重新启动应用，确认两个账号仍保持各自登录态。

## G1 验收

```text
[ ] Desktop launches
[ ] Account A can log in manually
[ ] Account B can log in manually
[ ] A/B sessions do not leak into each other
[ ] Switching accounts does not require re-login
[ ] Restart keeps both Chromium sessions
[ ] Clear session only clears the selected account
```

## 任务执行器（本地工具）

`tools/dola-task.js` 用账号自己的 persistent partition 直接跑任务，不导出
Cookie/Token，也不伪造任何签名。它复用页面自身的会话与配置端点，默认只读。

```powershell
cd apps/desktop

# 只读：登录态、技能配置、会话列表
npx electron tools/dola-task.js probe --account "Dola 1" --live

# 只读：打开 Create Videos 面板并 dump 可见 UI 文本与选项
npx electron tools/dola-task.js panel --account "Dola 1" --live --visible

# 只读：任意界面点击（真实 CDP 输入，才能打开 Radix 弹层）
npx electron tools/dola-task.js ui --account "Dola 1" --live --trusted --click "AI Creation|Video"

# 只读：列出会话里的 video/img/download 元素，--download 会通过该 partition 下载
npx electron tools/dola-task.js media --account "Dola 1" --live --trusted --click "<会话名>" --download

# 新建账号并导入 cookie（cookie 文件只放本机，如 user-data/cookies/*.json）
npx electron tools/dola-task.js import-cookies --name "Dola 4" --create `
  --cookies-file ../../user-data/cookies/account.json --live

# 准备任务：选 model/duration/ratio 并输入 prompt，但不发送
npx electron tools/dola-task.js submit --account "Dola 1" --live `
  --duration 10 --model "Dreamina Seedance 2.5" --ratio "16:9" `
  --prompt-file ../../user-data/prompts/<prompt>.txt

# 真正发送（会消耗账号额度）
npx electron tools/dola-task.js submit ... --submit

# 发送时改写 envelope 里的 duration（UI 没提供的值也能发出去）
npx electron tools/dola-task.js submit ... --patch-duration 30 --submit

# I2V：先挂参考图再发送（--clear-draft 清掉上次留下的草稿附件）
npx electron tools/dola-task.js submit ... --clear-draft `
  --image "D:/path/a.png|D:/path/b.png" --submit

# 发送后等结果（默认 900 秒），抓到 mp4 就下载到 outputs/
npx electron tools/dola-task.js submit ... --submit --wait-seconds 900

# 不依赖 UI 的轮询：按 conversation id 读消息并下载（先 --click 打开会话拿到 IM URL 模板）
npx electron tools/dola-task.js poll --account "Dola 4" --live `
  --click "会话名" --conversation <conversation_id> --download --name <tên file>
```

注意：`poll` 直接用页面 fetch 发 IM 请求，部分情况下服务端会回
`status_code 712012002`（不支持编码类型，缺了 app 自己的请求形态）。这时用
`ui --click "<会话名>"` 打开会话，让页面自己拉 chain，再从
`captures/raw/` 里取消息即可（D6 就是这样拿到的）。

约束：

- `--live` 表示直接用桌面应用的 userData 目录；运行期间桌面应用必须关闭
  （Chromium profile 独占锁）。不加 `--live` 时会尝试复制 partition 到
  `user-data/dola-scratch/`（应用在跑时 Cookies 会被锁，复制会失败）。
- `--patch-duration` 默认走 `--patch-mode page`：在页面里包一层 `window.fetch`，
  在 client 序列化/签名**之前**改写 `chat_ability.ability_param.duration`。
  实测这样 server 接受，能拿到 30s 视频（`duration:30` + `seedance_v2.5`）。
- 不要用 `--patch-mode cdp` 发视频任务：CDP 层是在页面签完之后改 body，
  server 会回 `STREAM_ERROR 710022002` 并让 session 登出（两台账号都复现过）。
  该模式只用于复现/对比这个失败路径。
- 运行记录写入 `captures/raw/dola-task-<日期>.jsonl`（gitignored）。

## 下一阶段

G1 通过后才进入：

- Task Manager
- 官方 BytePlus ModelArk Seedance 2.5 Provider
- 4 秒 smoke test
- 原生 30 秒 T2V
- 原生 30 秒 I2V
- 结果下载
- Windows 打包

相关设计：`../../docs/DESKTOP_MULTI_ACCOUNT_PLAN.md`

## 5 秒 Dola 生产账本

当前生产测试固定为 `seedance-v2.5`、请求时长 5 秒。桌面端提供本地容量账本，
将生成成功与 clean 文件交付分开统计。统计按 `Asia/Shanghai` 00:00 换日，
但服务端额度仍以真实 provider evidence 为准。

服务端明确报告 `daily_complete` 时，轮询器会进入下一个正常账号；账号归属与切换
最终由用户决定。详见：

- `../../docs/DOLA_D01_D02_PRODUCTION.md`
- `../../docs/DOLA_DAILY_CAPACITY_AND_ROTATION.md`
