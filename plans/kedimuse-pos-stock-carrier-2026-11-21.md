# Pancake stock và báo giá GHN checkout — 2026-11-21

## Dữ liệu và cấu hình đã xác minh

Shop Pancake Printerval 715160501; kho 17e77e47-689e-4b37-a55c-d1abbfba5d11 tại 22 Lê Thiện Trị. API key lấy từ cấu hình tenant có sẵn, không in/log giá trị. Đã đối chiếu 927/927 variant ID, không thay SKU; có 59 sản phẩm, 922 SKU tồn dương trong lần snapshot, tổng POS remain_quantity=50.153. Áo Black/S trong ảnh có34 ở lần snapshot; giá trị live có thể đổi theo POS.

Tồn được đồng bộ qua stock-only mode: giữ nguyên giá, nội dung, ảnh, loại sản phẩm và reservation của merchant, không tạo catalog mới. Kho khác hoặc mapping variant/SKU/product không khớp bị từ chối. Bản đầy đủ chỉ retire tồn những biến thể đã được quản lý bởi đúng shop đó. Cron15phút đã bật cho nguồn direct, không dùng MCP; thao tác sync thủ công lần đầu trả200, variants927, retired0, cache invalidated.

GitHub Actions repo Kedi-ecommerce-core đã nhận PANCAKE_API_KEY dưới dạng mã hóa, các biến shop/kho/direct/stock_only/sync. Workflow đã được nối để nhận cấu hình này, không phụ thuộc Halifruit backend hoặc tự đổi tenant/database.

Người dùng chọn kho22 Lê Thiện Trị, giá chưa thuế, tạm áp dụng0%. Đã tạo countryVN, regionVND tax_exclusive và tax rule0% rõ ràng; không tạo shipping rate cố định/miễn phí giả. GHN đã xuất hiện tài khoản kết nối trên shopPrinterval. TokenGHN có sẵn khớp số liên hệ tài khoản này. KhoGHN hiện có số20 cùng quận/phường; không đổi kho này và không tạo địa điểmGHN mới do chưa có phê duyệt riêng. Chỉ đọc phí theo mã quận/phường có thể dùng account hiện có, còn địa chỉ lấy hàng giữ tại khoPOS22; tự động tạo vận đơn vẫn tắt.

## Code

Cart hỗ trợ currency được cấu hình và kiểm tra khớp region khi có region; FE gửi đúng currency của SKU, tránh rơi vềUSD. FE kiểm tra tồn theo batchSKU, không bị giới hạn500 sản phẩm đầu catalog. SKU có stock nhưng thiếu delivery/tax chỉ được thêm cart và xem draft; payment vẫn không thể hoàn tất khi chưa có quote hợp lệ.

Checkout chuẩn bổ sung tỉnh/quận/phườngGHN, phí thực có thời hạn5phút. Quote được server lưu theo checkout, SKU/số lượng/giá và địa chỉ; browser chỉ chọn option ID, không gửi phí. Hết hạn, sai session, giá/tồn/địa chỉ hoặc policy/kho thay đổi đều chặn trả tiền. Retry dùng idempotency và đọc trạng thái hiện tại. Carrierquote chỉVND/VN; dynamic shipping tax hỗ trợ rule0% được cấu hình rõ, không tự suy đoán thuế khác. LuồngGHN read-only không tạo vận đơn; GHN trả leadtime0 ở live nên chế độ preferred lấy phí mà không hứa ngày giao, chế độ strict yêu cầu hãng xác nhận deadline.

## Kiểm thử và giới hạn

Backend203/203 test và typecheck đạt (bản sửa b43c45f); test stock-only bảo toàn dữ liệu/reservation, currencycart và HTTPWorker/DO carrier quote binding/expiry/context/pay safety. Python deployment-settings3/3 đạt. FE316/316 test,17/17 browser, boundary/typecheck/lint/OpenNext build đạt. FE e380b97 đã deploy phiên bản d85a7ce6-6225-4b2b-b8c3-51206d087869 và CI xanh; remote main41e6531 còn merge UI từ chat khác, đã giữ nguyên. BEa3346ca và các commit trước đã CI/deploy xanh.

Còn chờ người dùng cho phép ghi GHN_TOKEN/CARRIER_SECRETS_JSON vào GitHub Actions secrets của Kedi-ecommerce-core và bật carrier settings production. Automatic approval review đã từ chối lệnh vì cần xác nhận đích lưu khóa và cấu hình production; lệnh chưa chạy. Không dùng cách khác để ghi những khóa này. Tạo địa điểmGHN mới cũng chưa được thực hiện. Các câu hỏi pending không đồng nghĩa đã được phê duyệt.


## Kiểm tra web thật và database cũ

Browser production xác nhận Buy Now được bật theo tồnPOS nhưng thêm giỏ gặp500. Tail đã lọc request headers cho thấy database cũ thiếu cart_items.currency; schema CREATE TABLE IF NOT EXISTS không cập nhật bảng đã tồn tại. Bản b43c45f bổ sung migration chạy trong transaction trước nhận request, backfill theo currency của từng cart, giữ nguyên dòng/giá/tổng và chạy lại idempotent. Fixture cũ có cảVND/USD đã được kiểm thử;203/203 test backend đạt. Chờ kiểm tra lại PDP→cart→draft sau deploy; không coi test browser mock là bằng chứng toàn luồng production.

Stock-only giữ trừ số hàng Fufuni đã paid/consumed chưa đối soát vềPOS, không cộng trả vào tồn ở lần sync tiếp theo; reserved khác được bảo toàn. Đây là khấu trừ bảo thủ, cần hoàn thiện cơ chế xác nhận đồng bộ POS trước khi tự giải phóng paid debit.
