# Hướng dẫn lấy và cấu hình biến Marketing KediMuse

Cập nhật: 22/11/2026. Áp dụng cho backend `Kedi-ecommerce-core` và frontend `kedimuse-fe` cùng nhánh `codex/kedimuse-marketing-lifecycle-20261122`.

Các file mẫu chỉ có tên biến và giá trị an toàn. Chưa thay secret trên Cloudflare/GitHub, chưa bật gửi thư. Không copy file mẫu đè toàn bộ `.env` đang dùng; chỉ gộp các biến cần thiết và giữ nguyên giá trị thật đã có.

## 1. Chuẩn bị năm thông tin của cửa hàng

| Thông tin | Cách có giá trị | Ví dụ minh họa, không dùng nguyên khi deploy |
|---|---|---|
| Domain gửi | Bạn sở hữu tên miền; tạo subdomain và thêm vào Mailgun | `mg.example.com` |
| Email From | Bạn chọn danh tính gửi thuộc domain đã xác minh; nên có hộp thư/alias nhận được phản hồi | `KediMuse <hello@mg.example.com>` |
| Địa chỉ doanh nghiệp | Địa chỉ liên hệ thật của cửa hàng; hiển thị ở cuối email | Tên cửa hàng, số nhà/đường, thành phố, quốc gia |
| Privacy policy | URL HTTPS công khai của chính sách quyền riêng tư được cửa hàng duyệt | `https://example.com/privacy` |
| Hộp thư test | Email bạn kiểm soát và cho phép nhận thư thử | Hộp thư Gmail/Outlook của bạn |

Không lấy domain gửi từ `workers.dev` vì bạn không quản lý DNS của domain đó. Website vẫn có thể chạy trên workers.dev trong khi email dùng domain riêng. Email test là thông tin nghiệm thu, không phải biến runtime `MARKETING_TEST_EMAIL`: hiện hệ thống không có biến allowlist này. Để test mà không gửi tới subscriber cũ, dùng store/môi trường thử riêng.

## 2. Lấy thông tin từ Mailgun

1. Mở Mailgun → **Sending → Domains**, chọn/thêm domain bạn sở hữu. Chọn đúng khu vực US hoặc EU của domain.
2. Vào phần DNS/Domain verification, thêm đúng SPF/DKIM và các record Mailgun cung cấp tại nhà quản lý DNS. Không copy giá trị minh họa chung; không thay MX của mailbox đang dùng nếu bạn không định chuyển luồng nhận thư. Bấm Verify cho tới khi domain được xác minh.
3. Trong domain đó → **Sending keys → Add Sending Key**. Lưu khóa mới vào BE `MAILGUN_API_KEY`. Nếu backend đã có khóa hợp lệ cho email giao dịch, kiểm tra phạm vi domain trước khi thay: đây là helper/key dùng chung, đổi sang khóa chỉ gửi được domain marketing có thể làm hỏng email giao dịch ở domain khác.
4. Vào **Settings → API Security → HTTP webhook signing key**; lưu vào BE `MAILGUN_WEBHOOK_SIGNING_KEY`. Khóa này khác API key và Sending Key; không tự tạo ngẫu nhiên thay cho khóa Mailgun.
5. Điền domain vào `MARKETING_MAILGUN_DOMAIN` (không có `https://`), endpoint vùng US `https://api.mailgun.net` hoặc EU `https://api.eu.mailgun.net` vào `MARKETING_MAILGUN_BASE_URL`.
6. Cấu hình event webhook tại `<STORE_PUBLIC_API_URL>/v1/marketing/mailgun`: accepted, delivered, failed (temporary/permanent), complained, unsubscribed; thêm clicked khi sử dụng tracking phù hợp với chính sách của cửa hàng. Chọn event webhooks, không dùng inbound Routes để thay thế.

Nguồn chính thức: [Domain verification](https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-verify), [Domain Sending Keys](https://documentation.mailgun.com/docs/mailgun/user-manual/api-key-mgmt/rbac-mgmt), [Webhook signing key](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks).

## 3. Backend — biến và nơi lưu

File mẫu: `apps/merchant/.env.marketing.example`. Gộp giá trị vào `.env` root mà script deploy đang đọc; với Wrangler local, đặt secret trong `.dev.vars` của Worker theo cách chạy hiện tại. File overlay `.env.marketing.example` không được runtime tự nạp.

GitHub repo **phuongnguyen240805/Kedi-ecommerce-core → Settings → Secrets and variables → Actions**:

| Biến | Nơi lưu trong GitHub Actions | Lấy/điền như thế nào |
|---|---|---|
| `MAILGUN_API_KEY` | Secret | Sending Key có quyền gửi domain tương ứng; kiểm tra email giao dịch trước khi thay |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | Secret | Mailgun Settings → API Security |
| `MARKETING_BFF_TOKEN` | Secret | Tạo random riêng, tối thiểu 32 ký tự; dùng chung giá trị với FE `FUFUNI_MARKETING_BFF_TOKEN` |
| `ORDER_TOKEN_SECRET` | Secret, giữ nguyên nếu đã có | Khóa ký token hiện có; chỉ tạo mới nếu store chưa có. Đổi khóa làm token cũ hết hiệu lực |
| `MARKETING_ENABLED` | Variable | `false` khi chuẩn bị; `true` mới thu subscriber và chạy planner |
| `MARKETING_SEND_ENABLED` | Variable | `false` khi chuẩn bị; bật sau khi sẵn sàng test gửi có kiểm soát |
| `MARKETING_POLICY_VERSION` | Variable | Mã phiên bản consent do bạn đặt sau duyệt nội dung, ví dụ `email-consent-2026-11-v1` |
| `MARKETING_FROM_EMAIL` | Variable | Tên/email gửi thật, ví dụ định dạng `KediMuse <hello@domain>` |
| `MARKETING_CONTACT_ADDRESS` | Variable | Địa chỉ doanh nghiệp thật, một dòng |
| `MARKETING_MAILGUN_DOMAIN` | Variable | Domain đã Verify trong Mailgun |
| `MARKETING_MAILGUN_BASE_URL` | Variable | Endpoint US/EU đúng với domain |
| `STORE_PUBLIC_API_URL` | Variable | Backend URL đầy đủ của đúng store, không có `/v1` |
| `STORE_NAME` | Secret theo workflow hiện tại | Tên cửa hàng; giữ giá trị đã cấu hình |
| `STORE_URL` | Secret theo workflow hiện tại | Origin HTTPS website FE dùng trong link email; không có path |
| `MARKETING_WELCOME_DISCOUNT_CODE` | Variable, tùy chọn | Mã discount đã có trong Fufuni, active và được phép dùng; bỏ trống nếu không tặng mã |

Các biến marketing ở bảng trên đã được nối vào workflow tạo artifact và upload runtime. `STORE_NAME`, `STORE_URL`, `MAILGUN_API_KEY`, `ORDER_TOKEN_SECRET` tiếp tục dùng đường cấu hình hiện có. Thay giá trị trên GitHub chưa tự sửa Worker đang chạy: cần deploy backend theo workflow của repo. Nếu cấu hình trực tiếp Cloudflare, dùng **Workers & Pages → merchant → Settings → Variables and Secrets**, sau đó lưu/deploy; CI phải có cùng giá trị để lần deploy sau không làm mất cấu hình.

AI tạo bản nháp là tùy chọn: `MARKETING_AI_ENABLED=false`; chỉ thêm Secret `MARKETING_OPENAI_API_KEY` và Variable `MARKETING_AI_MODEL` khi muốn dùng. Bốn automation không cần OpenAI key.

## 4. Frontend — biến và nơi lưu

File mẫu: `.env.marketing.example`. Local: gộp vào `.env.local`, khởi động lại dev. Không đưa Mailgun key hoặc webhook signing key vào FE.

| Biến | Phạm vi | Lấy/điền như thế nào |
|---|---|---|
| `MARKETING_FRONTEND_ENABLED` | Server runtime | `false` khi chuẩn bị; `true` để dùng API/form |
| `FUFUNI_MARKETING_BFF_TOKEN` | Worker Secret | Copy đúng giá trị BE `MARKETING_BFF_TOKEN`, đúng tenant |
| `MARKETING_RATE_SECRET` | Worker Secret, tùy chọn | Random riêng >=32 ký tự. Bỏ trống thì dùng BFF token; không cần lấy từ Mailgun |
| `FUFUNI_BACKEND_URL` | Server runtime | Backend merchant đang chứa catalog/checkout/marketing; giữ nguyên hiện tại |
| `CHECKOUT_COOKIE_SECRET` | Worker Secret hiện có | Giữ nguyên khóa ký ownership checkout; tạo mới chỉ nếu chưa có |
| `PRINTERVAL_CART_COOKIE_SECRET` | Worker Secret hiện có | Giữ nguyên khóa ownership cart; khác khóa checkout |
| `FUFUNI_CHECKOUT_ADMIN_KEY` | Worker Secret hiện có | Bridge checkout đang dùng; khớp BE `CHECKOUT_BFF_TOKEN`, không phải Mailgun key |
| `TRUST_CLOUDFLARE_HEADERS` | Server runtime | `true` trên Cloudflare Worker; local hoặc hạ tầng chưa bảo đảm header đáng tin thì `false` |
| `NEXT_PUBLIC_PRINTERVAL_PRIVACY_URL` | Công khai, **lúc build** | URL policy thật; bỏ trống sẽ khóa form đăng ký |
| `NEXT_PUBLIC_PRINTERVAL_SITE_URL` | Công khai, lúc build | Origin HTTPS website thật |
| `NEXT_PUBLIC_PRINTERVAL_SUPPORT_EMAIL` | Công khai, lúc build, tùy chọn | Hộp thư hỗ trợ nhận phản hồi thực tế |

FE chưa có workflow deploy production tự động; `storefront-ci.yml` chỉ kiểm thử/build. Thêm GitHub Secret FE một mình không đưa giá trị vào Worker. Với cách deploy hiện tại:

1. Đặt biến public vào `.env.local`/môi trường build thật rồi build/deploy lại. Next.js đóng gói `NEXT_PUBLIC_*` vào bundle, nên thêm trên dashboard sau build không cập nhật giao diện đã build.
2. Đặt server secrets trên Cloudflare Worker `printerval` qua dashboard. Với Worker `printerval-dev`, nhập lại secrets cho môi trường đó; secrets không tự kế thừa giữa các môi trường.
3. `wrangler.toml` khai báo flags và backend URL; `MARKETING_FRONTEND_ENABLED` của môi trường dev giữ `false` tới khi cấu hình xong.
4. Không copy URL `https://shop.example.test/privacy` trong CI sang production: đó chỉ là fixture để browser test nhìn thấy form.

## 5. Tạo khóa random và ghép hai phía

Chạy lệnh sau riêng cho mỗi khóa cần tạo; sao chép kết quả vào trình quản lý mật khẩu/secret store, không gửi vào chat hoặc commit:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
```

| Phải khớp | Quy tắc |
|---|---|
| BE `MARKETING_BFF_TOKEN` ↔ FE `FUFUNI_MARKETING_BFF_TOKEN` | Cùng một giá trị random mới |
| BE `STORE_URL` ↔ FE public site URL | Cùng website origin |
| FE `FUFUNI_BACKEND_URL` ↔ BE `STORE_PUBLIC_API_URL` | Cùng store/backend, kể cả prefix tenant nếu có |
| BE `MARKETING_POLICY_VERSION` ↔ form | FE tự đọc `/api/marketing/status`; không tự đặt thêm biến public policy version |

Với nhiều store: gộp settings vào đúng store trong `STORES_JSON`, secret vào đúng mục `STORE_SECRETS_JSON`; `name` của store quyết định `STORE_NAME`. Không thay toàn bộ JSON hoặc trông chờ tenant phụ kế thừa Mailgun/BFF/signing key toàn Worker. `STORE_PUBLIC_API_URL` của tenant có dạng `https://backend/stores/<store-id>`; backend mặc định dùng URL không có prefix. Giữ tenant đang chứa catalog/checkout hiện tại.

## 6. Kiểm tra và bật theo thứ tự

1. Hoàn tất giá trị thật, deploy BE trước rồi FE; kiểm tra hai URL status dưới đây cùng trả đúng policy version.
2. Trong Admin Marketing, chỉ bật welcome khi nghiệm thu confirmation/welcome; đặt abandoned/post-purchase/win-back tắt cho giai đoạn đầu. Không sửa đơn/tồn production để tạo test.
3. Bật collection và sending trong store test; đăng ký hộp thư đã chỉ định, nhận confirmation, chủ động xác nhận rồi kiểm tra welcome và mã giảm giá nếu có.
4. Xác minh accepted/delivered webhook và unsubscribe; tiếp tục nghiệm thu abandoned, hậu mãi và win-back riêng rồi mới mở từng automation cho khách.
5. Thời gian campaign nằm trong Admin/DB, không có các biến env giả như `WELCOME_DELAY` hoặc `WIN_BACK_DAYS`. Mặc định: abandoned 1 giờ, hậu mãi 3 ngày sau quan sát delivered, win-back 90 ngày, cap 3 email/24h.

```text
GET https://merchant.gofiber-phuongnguyen.workers.dev/v1/marketing/status
GET https://printerval.gofiber-phuongnguyen.workers.dev/api/marketing/status
```

Status enabled không chứng minh Mailgun đã gửi hoặc thư đã tới inbox. Nếu form khóa: kiểm tra FE flag, policy từ BE và privacy URL lúc build. Nếu job không gửi: kiểm tra flags BE, API key, signing key, sender/domain, store URL, địa chỉ và signing secret. Nếu request subscribe/contact lỗi xác thực: kiểm tra hai BFF token và đúng tenant.

Rollback gửi: đặt `MARKETING_SEND_ENABLED=false`, giữ webhook/unsubscribe để xử lý thư đã phát hành. Không xóa consent, suppression, jobs hoặc đổi `ORDER_TOKEN_SECRET` để dừng chiến dịch.
