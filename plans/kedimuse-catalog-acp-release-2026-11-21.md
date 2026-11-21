# UCP, Feed, ACP và storefront — 21/11/2026

## Đã triển khai

- [x] UCP/Commerce readiness dùng cùng tax resolver với checkout: thiếu/ambiguous thuế sản phẩm hoặc delivery thì không báo destination ready.
- [x] Canonical offer bổ sung SKU, minor price, decimal places cho landing page; feed vẫn giữ exact price/identity.
- [x] Feed validation từ chối mô tả không có text, kiểm tra apparel cho category 166/1604/187 và trường apparel hiện có.
- [x] Admin /admin/catalog-feeds: danh sách variant có phân trang, cấu hình offer, xác nhận merchant review, diagnostics, preview tối đa 5 offers. Không tự bật publication.
- [x] Authenticated preview XML/JSONL khi public feed đang tắt; public feed vẫn gated; no-store cho admin.
- [x] Public /v1/checkouts/products/:id chỉ trả offer hợp lệ được duyệt, POD được lọc theo gate hiện hành.
- [x] FE /commerce-products/[id]: server-render title/details/price/availability, JSON-LD có escape script, review tạo draft sau hành động rõ ràng. Hết hàng/POD deferred không đi thẳng tới payment.
- [x] ACP GET đúng CheckoutSession schema; pending order không thành completed order. Dedicated auth, version/idempotency, one-use handoff và browser authorization giữ nguyên.
- [x] GitHub Actions nhận ACP_ENABLED, ACP_ACCESS_VERIFIED, ACP_API_TOKEN an toàn; không bật nếu chưa có quyền merchant được OpenAI hỗ trợ.
- [x] Jest bỏ qua .wrangler build snapshots; ESLint root repo không thừa kế cấu hình bên ngoài.

## Kiểm thử đã chạy

- Merchant regression 192/192 xanh; runtime feed preview, auth/public isolation và public offer xanh sau bổ sung preview.
- ACP request + 6 HTTP response states đúng schema pin; invalid required/status controls xanh. Không dùng schema mới tự tạo để nới lỏng contract.
- Deployment/settings Python 8+2 xanh, merchant typecheck xanh.
- Admin UI 19/19 xanh, typecheck xanh trước lần preview cuối; kết quả release gate cập nhật khi hoàn tất.
- FE regression 278/278 xanh trước thêm 2 component tests; hai test mới xanh: không auto-checkout và chặn out-of-stock/POD; tổng cuối cập nhật sau build.
- Build thử trên ổ C với dependencies trên ổ D thất bại do đường dẫn cross-volume; giữ nguyên source và quay về build checkout gốc, dùng temp ổ C/tắt cache. Không bỏ qua gate hay đổi phiên bản dependencies.
- RTK chỉ rút gọn full log; mã thoát kiểm thử lấy từ lệnh thật.

## Giới hạn nghiệm thu

Chưa tự tạo/sửa catalog, thuế, delivery hay dữ liệu merchant production. Chưa nộp feed lên OpenAI/Google, chưa claim domain, chưa bật ACP hoặc model trả phí khi thiếu cấu hình. MCP/R2/POD production chưa bật. Printify/POD do chat riêng thực hiện; các commit 6211c49 và frontend b15035c/ed1eede được giữ nguyên.

Cần bổ sung: offers/SKU được merchant duyệt, domain chính thức và policy/shipping/returns, quyền OpenAI/Google merchant, AI model/key nếu bật interpretation, real Stripe sandbox payment/webhook và nghiệm thu POD sau này.

## Phát hành

Chờ build/browser gate, push main, Actions và smoke live cuối. Không đánh đồng code readiness với account approval hoặc giao dịch thật.
