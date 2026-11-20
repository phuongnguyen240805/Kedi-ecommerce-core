# Cấu hình dịch vụ KediMuse / Fufuni

Không gửi secret vào chat. Repo backend: phuongnguyen240805/Kedi-ecommerce-core → Settings → Secrets and variables → Actions. Secrets chứa khóa; Variables chứa cấu hình công khai. Sau khi lưu, chạy CloudflareWorkerDeploy trên main. Những biến marketing/feed bên dưới đã được nối vào create-env-artifact. Giữ các cờ bật bằng false cho đến nghiệm thu.

## 1. Stripe — đã có test mode

Secrets: STRIPE_SECRET_KEY (sk_test_...) và STRIPE_WEBHOOK_SECRET (whsec_...). Lấy API key từ Stripe Dashboard → đúng Sandbox → Developers/Workbench → API keys. Webhook signing secret lấy riêng tại Workbench → Webhooks → destination → Reveal secret.

Endpoint: https://merchant.gofiber-phuongnguyen.workers.dev/v1/webhooks/stripe ; payload Snapshot; Your account. Ba event: checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.expired. API key và endpoint phải cùng Sandbox. Workflow Stripe read-only verification kiểm tra xác thực key, mode, endpoint và event, không kiểm chứng một thanh toán hoặc chữ ký delivery thật.

Để nghiệm thu xuyên suốt cần SKU được phép bán/test, giá theo currency, tồn, trọng lượng, khu vực và phí giao hàng, cùng quy tắc thuế rõ ràng. Không nhập khóa live trước khi kiểm thử đạt. Mẫu áo Pancake hiện chỉ là fixture cô lập; không dùng tồn giả làm hàng có sẵn production.

Tham khảo: https://docs.stripe.com/keys ; https://docs.stripe.com/webhooks

## 2. Mailgun — cấu hình cần bổ sung

1. Mailgun Dashboard → Sending → Domains → thêm/chọn domain gửi thuộc quyền quản lý. Khuyến nghị subdomain riêng (ví dụ mg.<domain-cua-ban>). Thêm đúng SPF/DKIM và DNS Mailgun cung cấp, rồi Verify; không tự đoán DNS values. Chọn đúng khu vực US/EU.
2. Tạo Domain Sending Key cho domain đó: Sending → domain → Sending/API keys theo giao diện tài khoản. Đặt trong GitHub Secret MAILGUN_API_KEY. Đây là key gửi, không phải webhook signing key.
3. Settings → API Security → HTTP webhook signing key: sao chép vào Secret MAILGUN_WEBHOOK_SIGNING_KEY.
4. Sending → domain → Webhooks: URL https://merchant.gofiber-phuongnguyen.workers.dev/v1/marketing/mailgun ; cấu hình accepted, delivered, permanent/temporary failure, complained, unsubscribed, clicked theo loại event Mailgun cung cấp. Chỉ bật click tracking khi phù hợp với consent/privacy policy; không coi open/click là doanh thu tăng thêm.
5. GitHub Variables:

| Tên | Giá trị phải cung cấp |
|---|---|
| MARKETING_MAILGUN_DOMAIN | Domain gửi đã Verify, không có https:// |
| MARKETING_MAILGUN_BASE_URL | https://api.mailgun.net (US) hoặc https://api.eu.mailgun.net (EU) |
| MARKETING_FROM_EMAIL | Email From thật, thuộc domain đã xác minh |
| MARKETING_CONTACT_ADDRESS | Địa chỉ doanh nghiệp thật, một dòng |
| MARKETING_POLICY_VERSION | Mã phiên bản consent policy đã phê duyệt |
| STORE_PUBLIC_API_URL | https://merchant.gofiber-phuongnguyen.workers.dev |
| MARKETING_WELCOME_DISCOUNT_CODE | Tùy chọn: mã discount đã tồn tại và active |
| MARKETING_ENABLED | false trong lúc chuẩn bị; bật true khi form/consent sẵn sàng |
| MARKETING_SEND_ENABLED | false cho đến khi được phép gửi và test delivery/suppression đạt |

Frontend cần URL privacy policy thật tại NEXT_PUBLIC_PRINTERVAL_PRIVACY_URL khi build; không tự tạo thông tin pháp lý. Backend dùng bridge subscribe riêng, không đưa Admin key ra trình duyệt. Đăng ký cần consent rõ ràng và xác nhận mailbox; unsubscribe/recovery không tự thực hiện khi mở trang.

Mailgun sandbox chỉ gửi tới recipients đã được xác minh, không dùng để gửi hàng loạt. Địa chỉ nhận email kiểm thử phải được người dùng chỉ định. Đợt triển khai này không gửi email khách hàng.

Tham khảo:
- https://documentation.mailgun.com/docs/mailgun/user-manual/domains/domains-verify
- https://documentation.mailgun.com/docs/mailgun/user-manual/api-key-mgmt/rbac-mgmt
- https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks
- https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/configuring-webhooks

## 3. Marketing AI — tùy chọn, chỉ tạo bản nháp

Secret MARKETING_OPENAI_API_KEY là key riêng cho gợi ý marketing. Variables MARKETING_AI_MODEL là model được tài khoản hỗ trợ; MARKETING_AI_ENABLED=false cho đến khi cấu hình/xác nhận sử dụng. Chỉ gửi brief do admin nhập, không gửi dữ liệu cá nhân khách hàng. AI không gửi email, không tự công bố giá/khuyến mãi, không tự bật campaign. Việc tạo key/tài khoản và chấp nhận điều khoản do chủ tài khoản thực hiện.

## 4. OpenAI Feed và Google Merchant Center

GitHub Variable FEEDS_ENABLED=false cho đến khi offers được phê duyệt. Nạp metadata qua Admin API /v1/feeds/admin/offers/:sku với quyền admin:store; kiểm tra /v1/feeds/admin/diagnostics. Không dùng dữ liệu mẫu để công bố tồn kho thật.

URL feed khi bật:
- https://merchant.gofiber-phuongnguyen.workers.dev/v1/feeds/openai.jsonl
- https://merchant.gofiber-phuongnguyen.workers.dev/v1/feeds/google.xml

Mỗi variant cần giá và currency đúng landing page, ảnh public, thương hiệu/seller thật, quốc gia đích, identifiers được nhà sản xuất cấp nếu có, thông tin size/color/group chính xác, chính sách trả hàng. Không tạo GTIN/MPN giả. API hiện giới hạn 2000 offers và báo lỗi vượt giới hạn; chưa có publisher lớn hơn.

Google Merchant Center: đăng nhập tài khoản merchant → Business information / Online store → thêm website và xác minh/claim domain bằng phương pháp Google cung cấp. Khai báo shipping/returns và quốc gia bán thực tế → Products/Data sources → thêm XML URL theo scheduled fetch, kiểm tra diagnostics sau xử lý. Domain phụ workers.dev hiện là môi trường thử; phải xác nhận khả năng claim/domain chính thức trước submit. Không tuyên bố được duyệt chỉ vì XML hợp lệ.

OpenAI: thực hiện onboarding tại https://developers.openai.com/commerce/guides/submit-product-feeds theo quyền merchant account thực tế; hosted URL/SFTP/file upload tùy phương thức được cấp. Feed để discovery, is_eligible_checkout=false. Feed không thay thế quyền ACP/direct checkout.

Tham khảo:
- https://developers.openai.com/commerce/specs/file-upload/products
- https://developers.openai.com/commerce/guides/submit-product-feeds
- https://support.google.com/merchants/answer/7052112

## 5. Techcombank, Pancake và GHN

Techcombank: chỉ sử dụng nguồn giao dịch có xác thực do ngân hàng hoặc nhà cung cấp hợp lệ hỗ trợ. Chuẩn bị tài khoản nhận, tài liệu API/webhook, thông tin xác thực và dữ liệu mẫu được phép dùng. Nếu không có nguồn đáng tin cậy, QR vẫn cần xác minh thủ công. Không dùng ảnh QR, redirect của browser hoặc nội dung chuyển khoản do khách gửi để tự đánh dấu paid.

Pancake: shop được người dùng gửi 715160501 khác cấu hình local 715159313. API key hiện tại trả 404 khi đọc shop 715160501. Chủ shop có thể lấy Shop API key tại Settings → Apps → Webhook/API → API Key và lưu dưới secret đúng môi trường/store. Cần warehouse ID đúng, mapping phương thức thanh toán và trạng thái. Không chuyển global shop hoặc đồng bộ MCP để vượt quyền. Shop 715160501 được xác nhận là mẫu POD/dữ liệu thử, không được tạo shipment/production từ đó.

GHN: lấy thông tin kết nối từ tài khoản GHN chính thức/đầu mối hợp đồng; cấu hình đúng sandbox/production, token, shop ID và địa chỉ gửi. Trước khi bật vận đơn, nghiệm thu đồng bộ trạng thái, phí, COD và chống trùng bằng dữ liệu thử được phép. Secret của các provider không đưa vào FE hoặc chat.

MCP, R2/POD và Printify được tách khỏi đợt này. Không tạo đơn nội địa cho đơn POD quốc tế.

## 6. Shopping vật lý, tách khỏi MCP/POD

Trang /shop-assistant tìm SKU từ catalog checkout vật lý active, còn tồn khả dụng, có trọng lượng và giá currency rõ ràng; không cần bật SHOPPING_ENABLED hoặc MCP. Bấm Review this product chỉ tạo draft, không thanh toán.

AI tùy chọn dùng Secret SHOPPING_OPENAI_API_KEY và Variables SHOPPING_AI_MODEL, SHOPPING_AI_ENABLED. Để false khi chưa có key/model được tài khoản hỗ trợ. Frontend chỉ hiển thị checkbox khi backend xác nhận có cấu hình; checkbox mặc định không chọn. Chỉ gửi search text khi người dùng chọn AI và submit; không gửi địa chỉ/email hoặc cho AI ghi giá/tạo đơn. Budget hiện tại giới hạn 10 lần/client/giờ và 200 lần/store/ngày. Không tuyên bố AI live đã nghiệm thu khi chưa cấu hình.
