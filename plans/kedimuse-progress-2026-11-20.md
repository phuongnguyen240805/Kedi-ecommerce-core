# Báo cáo triển khai KediMuse / Fufuni — 20/11/2026

## Phạm vi được xác nhận

- Backend chính: D:/monorepo-project-workspace/fufuni, repo phuongnguyen240805/Kedi-ecommerce-core, nhánh main.
- Frontend tiếp tục dùng repo phuongnguyen240805/kedimuse-fe.
- Tạm hoãn triển khai MCP. Không bật shopping connector, không cấu hình nền tảng AI bên ngoài.
- Chưa sử dụng R2. Bản Worker triển khai không có IMAGES hoặc DIGITAL_ASSETS_BUCKET; upload artwork, POD production và tài sản số chưa vận hành.
- Test mỗi bước, chỉ push sau khi gate local đạt. CI và smoke production được báo riêng.

## Các bước thực hiện trong đợt này

### 1. Khóa deploy MCP

Workflow deploy-mcp chỉ được bắt đầu khi repository variable MCP_DEPLOY_ENABLED được đặt chính xác bằng true. Mặc định các trigger push, lịch và manual không triển khai MCP. Mã pilot từ đợt trước vẫn giữ để tiếp tục sau; chưa tích hợp ChatGPT/OpenAI marketplace.

Kiểm tra: YAML workflow parse thành công; kiểm tra trực tiếp điều kiện job. Không thực hiện thao tác tài khoản MCP.

### 2. Sửa điều kiện và dữ liệu checkout UCP

- Bổ sung giới hạn body 64 KB, tối đa 100 dòng và 99 sản phẩm mỗi dòng, kiểm tra currency và chặn field giá do client tự truyền.
- Chỉ chọn product/variant active; ngăn một SKU được gửi hai lần bằng SKU và variant ID.
- PUT kiểm tra tồn kho; PATCH kiểm tra toàn bộ dòng hàng, ID lạ/trùng, tồn kho, trạng thái sản phẩm và thời hạn phiên.
- Chỉ báo ready_for_complete khi có email; PATCH có thể bổ sung buyer để hoàn thiện phiên.
- PATCH giữ phí giao hàng đã có, tính lại thuế/tổng và dùng điều kiện nội dung cũ để phát hiện cập nhật đồng thời.
- Không chỉnh sửa phiên đã hủy, đã trả tiền hoặc đang tạo thanh toán. Phiên hết hạn không được chỉnh sửa/khởi tạo thanh toán mới.
- Khi chưa cấu hình payment handler, trả 503 và giữ phiên nguyên trạng; bỏ continue_url dẫn tới trang checkout backend không tồn tại.
- Trước tạo Stripe attempt mới, kiểm tra lại tồn khả dụng. Không tạo payment attempt hoặc đơn nếu stock đã thay đổi.

Kiểm tra HTTP với Worker + Durable Object/SQLite thật: tạo/đọc/PUT/PATCH/hủy; input sai, duplicate alias, sản phẩm draft, thiếu stock, cập nhật buyer, phiên hết hạn và không có payment handler. Không gọi Stripe thật.

### 3. Sửa thuế và phí giao hàng theo schema thực

Hàm thuế cũ truy vấn rate/name/region_id không còn tồn tại. Bản sửa dùng rate_percentage/display_name và cấu hình active. Adapter hiện chỉ xử lý cấu hình một mức thuế global, không inclusive. Nếu cần quốc gia, tax code hoặc thuế inclusive, từ chối tiếp tục trong adapter này thay vì đoán thuế. Đây là giới hạn được xác nhận, chưa phải hoàn thiện hệ thống thuế quốc tế.

Shipping estimate cũ dùng các trường sr.name/price_cents/region_id và c.iso_code không đúng schema. Bản sửa dùng region_shipping_rates, shipping_rate_prices, region_countries và countries.code. Giá được lấy đúng đồng tiền checkout; lọc region/country/currency/rate active, giới hạn khối lượng. Thiếu trọng lượng hoặc shipping class đặc thù yêu cầu luồng merchant checkout có đủ ngữ cảnh. Chưa chọn/lưu shipping option vào session hoặc tạo vận đơn từ endpoint estimate.

Kiểm tra: giá hàng 2 x 2500 + thuế 10% = 5500; sau sửa thành 3 sản phẩm tổng 8250. Shipping fixture đúng US/USD trả 700; country không được phục vụ hoặc vượt trọng lượng trả danh sách rỗng. Thuế cần quốc gia bị chặn rõ ràng.

### 4. Gate triển khai và kiểm tra sau deploy

Bổ sung test vòng đời HTTP UCP vào gate backend. Workflow Worker sau deploy gọi discovery và catalog qua HTTPS; lỗi HTTP sẽ làm job fail để tránh coi upload code là hoạt động thành công.

Gate local: 151 test backend đạt; 6 test Admin UI và 7 test cấu hình deploy; TypeScript merchant và client đạt. Kết quả CI/deploy bản mới sẽ được bổ sung sau khi hoàn tất.

## Những phần đã có từ các đợt trước

- Payment Core UCP: request Stripe bất biến, idempotency, xác minh paid/amount/currency/binding; ghi order/items/receipt/outbox và stock atomically trong store DO.
- Nội địa: QR/COD, flow quản trị Commerce/Shipping, bằng chứng thanh toán, đối soát/lease/idempotency; không coi QR hay redirect của khách là đã thu tiền.
- Marketing: subscriber/email normalization, consent/version/double opt-in, suppression/unsubscribe, queue/lease/retry và không tự gửi lại khi kết quả chưa rõ; welcome, abandoned, post-purchase, win-back.
- Marketing Admin: RFM theo 365 ngày, A/B phân nhóm cố định theo khách, nội dung frozen theo job; gợi ý AI chỉ là draft để duyệt; revenue last-click sau refund theo currency, không tính COD chưa thu tiền.
- Feed: OpenAI JSONL và Google XML từ cùng canonical offer/giá; diagnostics và metadata approval. Chưa submit/đăng ký feed vào tài khoản merchant thật; checkout eligibility vẫn false.
- Frontend: newsletter/preference flow và POD/AI shopping pilot từ đợt trước đã có kiểm thử, nhưng chưa bật MCP/R2/live POD trong đợt này.

## Phần còn thiếu / cần điều kiện bên ngoài

1. UCP vẫn là adapter version 2026-01-11; chưa tuyên bố tương thích đầy đủ specification mới nhất. Còn destination/shipping selection, tax policy đầy đủ và end-to-end checkout với phương thức thanh toán đã cấu hình.
2. Chưa chạy giao dịch Stripe thật hoặc kiểm thử test-mode với tài khoản merchant. Chưa xác minh shipping address persistence cho mọi luồng UCP.
3. Kiểm tra stock trước payment giảm lỗi sớm, nhưng chưa giữ reservation riêng cho từng UCP session trong suốt Stripe checkout. Đồng thời nhiều người trả tiền cho stock cuối vẫn có thể cần đối soát vận hành; không tuyên bố giải quyết oversell toàn diện.
4. Techcombank auto-reconciliation chờ nguồn giao dịch ngân hàng đáng tin cậy. Hiện giữ xác minh thủ công và bằng chứng; không tự đánh dấu paid.
5. Pancake/GHN/COD live cần mapping/tài khoản và kiểm thử đối soát bằng dữ liệu thực. Không đưa POD quốc tế vào POS nội địa.
6. Mailgun domain/sender/webhook/click tracking và chính sách/contact cần được xác minh trước bật gửi. Đợt này không gửi email thật hoặc gọi AI có phí.
7. Google Merchant Center/OpenAI feed cần merchant account/domain verification/catalog metadata thật. ACP và quyền checkout OpenAI chưa được xác lập; không suy diễn quyền từ MCP code.
8. R2/POD và MCP tiếp tục tạm hoãn theo yêu cầu. Không tạo bucket, production order hoặc vận đơn trong kiểm thử.

## Bằng chứng triển khai trước đợt này

Worker merchant đã deploy thành công bản f2c033f. Kiểm tra GET production sau migration legacy: /.well-known/ucp HTTP 200; /ucp/v1/products HTTP 200 (3 sản phẩm có sẵn); /v1/pod/status HTTP 200 với enabled=false. Đây không phải xác nhận 3 sản phẩm đó là catalog KediMuse đã duyệt hoặc checkout đã sẵn sàng bán thật.
