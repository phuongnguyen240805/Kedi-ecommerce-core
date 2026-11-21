# KediMuse checkout cart bridge — phát hành 2026-11-21

## Đã triển khai

Frontend commit `2589515` tại repo kedimuse-fe đã push main và deploy Worker printerval, version `5a4fc20d-86be-4433-9448-1e333061b237`.

Các nút PDP/cart dẫn vào `/checkout`; cart server giờ có bước review và thao tác tiếp tục rõ ràng để chuyển sang `/commerce-checkout?session=...`, thay cho việc đi nhầm checkout COD/QR nội địa đang tắt. API BFF `/api/checkout/from-cart` đọc cart authoritative từ Fufuni merchant, kiểm tra cookie sở hữu, same-origin POST, xác nhận, hết hạn/trạng thái và nội dung response. SKU/số lượng/currency được giữ; giá do checkout tính lại. Browser không được gửi giá/line/total thay thế. Retry có key HMAC gắn cart, và BFF đọc trạng thái mới nhất trước khi cấp cookie checkout.

Checkout khôi phục không thay sản phẩm bằng đầu catalog. Cả cart một/nhiều SKU và currency giữ nguyên; session không thuộc browser không tự tạo checkout mới. Sau địa chỉ và báo giá delivery/tax, buyer chọn phương thức backend cho phép và xác nhận tổng trước khi pay. QR chỉ dành cho VND/VN khi ngân hàng và gate đủ cấu hình; Stripe giữ hosted checkout. COD vẫn ở nhánh nội địa riêng, chưa tự thêm cho quốc tế/POD.

Đã tách gate giỏ stock khỏi gate POD production. Thêm/sửa line stock chỉ nhận SKU/currency/tồn khả dụng trong catalog checkout merchant. POD/ref design/local customization không được tự biến thành stock; sản xuất POD, R2 và MCP giữ nguyên trạng thái hoãn. Lỗi stock/POD/currency/tax có thông báo buyer rõ hơn, không lộ raw upstream detail.

## Kiểm thử

- 306/306 tests, 67 suites đạt; module boundaries, modular TypeScript, lint và production OpenNext build đạt.
- 16/16 browser tests đạt: cart hai SKU đi qua BFF thật với provider localhost fixture, giữ SKU/số lượng, nhập địa chỉ, delivery quote, chọn Stripe hoặc QR; thiếu stock giữ cart; session lạ không tạo cart mới; một SKU không bị thay bởi catalog khác. Existing Stripe redirect/status, QR pending/reload/mobile, marketing recovery, handoff, stock shopping và POD fixture vẫn đạt.
- 2/2 Cloudflare manifest regression đạt.
- Live web `/api/checkout/status` 200: enabled/stripe_configured/storefront_configured/backend_configured=true. `/api/checkout/catalog` 200 và items=[] theo điều kiện dữ liệu hiện tại.
- Live POST from-cart thiếu ownership hoặc khác origin trả 403.
- Live browser checkout dùng cart UI fixture trả từ route mock, sau đó gọi BFF auth thật: hiển thị review cart mới, buyer tiếp tục bị chặn vì không sở hữu fixture cart, cart storage còn nguyên. 0 request Halifruit, 0 uncaught JS error, không tràn mobile 390px. Đây không phải test chuyển một production cart hợp lệ hoặc giao dịch thật.
- Không charge Stripe, chuyển tiền, tạo đơn fulfilment, sản xuất hoặc giao vận thật.

## Cấu hình còn cần trước khi nhận tiền thực

Repo Kedi-ecommerce-core → Settings → Secrets and variables → Actions → Variables: TECHCOMBANK_ACCOUNT_NUMBER (tài khoản nhận đã xác minh), TECHCOMBANK_ACCOUNT_NAME (tên chủ tài khoản), CHECKOUT_QR_ENABLED=true sau nghiệm thu đối soát; CHECKOUT_PAYMENTS_PAUSED=false khi được phép. Chạy lại workflow CloudflareWorkerDeploy để áp dụng. Không cần bật DOMESTIC_CHECKOUT_FRONTEND_ENABLED hoặc POD_COMMERCE_ENABLED cho QR checkout chuẩn.

STRIPE_SECRET_KEY và STRIPE_WEBHOOK_SECRET tiếp tục là backend Actions secrets, không đưa vào FE. Chưa thực hiện nghiệm thu Stripe test hosted-payment + webhook thật trong thay đổi này. QR vẫn xác minh qua sao kê bởi admin, không tự paid từ claim của buyer.

Các mẫu áo trong ảnh hiện available=0, chưa có delivery/tax được duyệt. Cần stock thực cho SKU stock, default region/currency, country, tax rule và shipping rate tương ứng. POD cần mapping/quote Printify do phần tích hợp riêng phụ trách. Không tự nhập tồn giả hoặc dựng chính sách thuế/phí. Vì vậy hoàn tất nối code không đồng nghĩa đã bật bán các mẫu này.

Chi tiết code và hướng dẫn cấu hình: `plans/cart-checkout-release-2026-11-21.md` trong repo kedimuse-fe. CI cuối được ghi bổ sung khi hoàn tất.

CI storefront [44884389468](https://github.com/phuongnguyen240805/kedimuse-fe/actions/runs/44884389468), commit 2589515: completed/success, bao gồm modular checks, production build và commerce browser regression.
