# KediMuse — báo cáo thống nhất backend, 2026-11-21

## Đã phát hành

KediMuse FE trên Worker `printerval` dùng duy nhất backend Fufuni `merchant`: https://merchant.gofiber-phuongnguyen.workers.dev. Các client catalog/cart/account, checkout và marketing dùng chung cấu hình server `FUFUNI_BACKEND_URL`; alias checkout/POD lệch địa chỉ sẽ bị từ chối. POD vẫn có khóa riêng và vẫn tắt. Đã thay khóa catalog sang khóa của merchant; public role đọc catalog được nhưng không truy cập Admin.

Backend code: `fdc96db`. Frontend code: `d263cfa` trong `phuongnguyen240805/kedimuse-fe`. Frontend deployment version: `714be47a-2fc4-48bb-ab1a-f48f7680f296`.

## Phạm vi dữ liệu

Chỉ tenant `stores/printerval` được đọc từ backend Halifruit cũ. Tenant có 1.007 sản phẩm, 1.875 biến thể, không có customer/order lịch sử cần chuyển. Đã nhập và đối chiếu toàn bộ ID, SKU, giá, currency và trạng thái; chuyển thêm 318 product metadata và 318 variant metadata. Merchant có tổng 1.010 sản phẩm (3 sản phẩm demo có sẵn được giữ), read model FE có 62 sản phẩm active. Hình ảnh vẫn ở CDN `printerval-cdn`, không phải Halifruit backend bán hàng.

Migration có preflight toàn bộ 101 batch, transaction, receipt chống nhập trùng, từ chối ghi đè dữ liệu ngoài migration. Toàn bộ 1.875 SKU nhập có available=0: đây là mẫu POD/dữ liệu thử, không chuyển lượng tồn mẫu thành hàng có thể bán. Không sao chép tài khoản ngân hàng, khóa nguồn, thuế/phí vận chuyển hoặc tự tạo mapping Printify. Hệ thống nguồn không bị sửa/xóa. Snapshot SHA256: `8beb05ad0cf0c78c80ef938e360b4e3e0d44d168c8414f0688eb1be859d22b46`.

Giỏ hàng có namespace và khóa ký riêng của merchant; người dùng phải tạo lại cart cũ. Checkout secret hiện tại được giữ. Snapshot dữ liệu và backup cấu hình trước cutover nằm ngoài Git, không có giá trị secrets trong báo cáo.

## Kiểm thử

- Backend typecheck đạt; 195/195 tests đạt, có kiểm thử rollback/idempotency/no-overwrite/stock-zero/public-role. Bộ test đầy đủ được chạy tuần tự sau một lỗi socket ECONNRESET khi chạy nhiều Worker đồng thời; test lỗi cũng đã được chạy lại riêng và đạt, không đổi assertion/timeout để bỏ qua lỗi.
- Backend CI/deploy [44858638805](https://github.com/phuongnguyen240805/Kedi-ecommerce-core/actions/runs/44858638805) đạt.
- FE boundary, modular typecheck, lint, 285/285 tests và production OpenNext build đạt; build lấy catalog từ merchant.
- 12/12 browser regression đạt qua fixture riêng, không thanh toán hoặc fulfilment thật. Sandbox ban đầu chặn socket localhost; chạy lại cùng test với quyền mạng đã đạt.
- Live: `/api/checkout/status` 200, enabled=true, stripe_configured=true, storefront_configured=true, backend_configured=true, shopping_ai_available=false.
- Live: `/api/storefront/products?limit=100` trả 62 sản phẩm active, có sản phẩm nhập từ nguồn.
- Live: `/api/checkout/catalog` và `/api/ai-catalog` trả 200, danh sách rỗng theo eligibility hiện tại.
- Live Chrome: home, collection/all, PDP của sản phẩm đã chuyển, cart, commerce-checkout, shop-assistant đều 200; 0 request trình duyệt đến host Halifruit, 0 uncaught JavaScript error.

## Chưa phải nghiệm thu bán hàng thật

Đã hoàn tất chuyển nguồn backend và dữ liệu hiển thị. Sản phẩm thử/POD chưa có stock bán thực, chính sách thuế/vận chuyển duyệt và provider mapping nên không tự bật bán. Chưa chạy charge Stripe, chuyển khoản, sản xuất hoặc giao vận thật. MCP, R2, POD production và các gate marketing/AI/feed/ACP chưa đủ cấu hình vẫn giữ trạng thái hiện tại. Kết nối Printify do chat khác phụ trách được giữ nguyên.

Rollback phải khôi phục đồng thời bản FE, URL và khóa cùng nguồn, không đổi riêng URL sang database cũ. Backend nguồn và snapshot còn nguyên. Chi tiết truy vết source FE: `plans/unified-merchant-cutover-2026-11-21.md` trong repo kedimuse-fe.

Frontend CI [44864112741](https://github.com/phuongnguyen240805/kedimuse-fe/actions/runs/44864112741) cho commit d263cfa đã hoàn tất thành công, gồm modular checks, production build và commerce browser regression.
