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
- [x] Jest bỏ qua .wrangler build snapshots; ESLint root repo không thừa kế cấu hình bên ngoài. Build scripts dùng binary từ node_modules của chính repo, tránh npm chọn binary ở workspace cha.

## Kiểm thử đã chạy

- Merchant regression 192/192 xanh; runtime feed preview, auth/public isolation và public offer xanh sau bổ sung preview.
- ACP request + 6 HTTP response states đúng schema pin; invalid required/status controls xanh. Không dùng schema mới tự tạo để nới lỏng contract.
- Deployment/settings Python 8+2 xanh, merchant typecheck xanh.
- Admin UI 19/19 và typecheck xanh sau bổ sung preview cuối.
- FE regression 280/280 trong 63 suites, typecheck/lint/boundaries và OpenNext production build xanh. Hai manifest tests xanh.
- Browser 12/12 xanh: feed landing SSR, exact price/stock, JSON-LD không thực thi script, buyer-only draft, hết hàng/missing 404; Stripe/QR checkout; marketing recovery; AI handoff/search; POD mock/empty catalog.
- Browser bắt được lỗi layout của trang mới trả 500; đã sửa theo wrapper trong _app, rebuild và toàn bộ browser xanh trước deploy. Một locator bị trùng Next route announcer đã được thu hẹp.
- Build thử trên ổ C với dependencies trên ổ D thất bại do đường dẫn cross-volume; giữ nguyên source và quay về build checkout gốc, dùng temp ổ C/tắt cache. Không bỏ qua gate hay đổi phiên bản dependencies.
- RTK chỉ rút gọn full log; mã thoát kiểm thử lấy từ lệnh thật.

## Giới hạn nghiệm thu

Chưa tự tạo/sửa catalog, thuế, delivery hay dữ liệu merchant production. Chưa nộp feed lên OpenAI/Google, chưa claim domain, chưa bật ACP hoặc model trả phí khi thiếu cấu hình. MCP/R2/POD production chưa bật. Printify/POD do chat riêng thực hiện; các commit 6211c49 và frontend b15035c/ed1eede được giữ nguyên.

Cần bổ sung: offers/SKU được merchant duyệt, domain chính thức và policy/shipping/returns, quyền OpenAI/Google merchant, AI model/key nếu bật interpretation, real Stripe sandbox payment/webhook và nghiệm thu POD sau này.

## Phát hành

- Backend 7759c57 push main Kedi-ecommerce-core. CI/Worker deploy success: https://github.com/phuongnguyen240805/Kedi-ecommerce-core/actions/runs/44851322049
- Admin Pages success: https://github.com/phuongnguyen240805/Kedi-ecommerce-core/actions/runs/44851322053
- Frontend ff45811 push main kedimuse-fe; CI run https://github.com/phuongnguyen240805/kedimuse-fe/actions/runs/44851976410 đã success, gồm toàn bộ frontend gates và 12 browser tests.
- Frontend Worker printerval deployed version 8aa9ac1e-a61d-4fc5-baff-814397c0817a.
- Live Chrome viewport 390×844: /commerce-checkout HTTP 200, không lỗi JS/tràn ngang, nút đặt hàng bị khóa khi catalog không đủ dữ liệu; /commerce-products/unapproved HTTP 404 không lỗi JS.
- Live backend: readiness 3 variants, 0 ready; catalog 0; Stripe test configured; shopping AI false; QR false; marketing false.
- Live public feeds và ACP trả 404 khi chưa bật; feed Admin public request trả 401; unsigned Stripe webhook trả 400; BFF token không được xác nhận chuyển khoản; MCP 404; POD production false.

Không đánh đồng code readiness với account approval hoặc giao dịch thật. Nội dung feed thật, domain/merchant approval và khóa dịch vụ chưa được người dùng cung cấp vẫn pending.
