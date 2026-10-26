# Báo cáo triển khai Fufuni đa store và chuyển Printerval

Đã hoàn thiện code local và kiểm thử phần chuyển đổi. Chưa deploy production, chưa kết nối shop POS Printerval thật.

## Thay đổi chính

- Một Worker `halifruit-backend` phục vụ nhiều store. Halifruit tiếp tục dùng URL cũ và Durable Object `default`; Printerval dùng `/stores/printerval/...` và database riêng. Thêm store bằng cấu hình, không thêm nhánh xử lý riêng theo tên frontend.
- Registry là JSON có cấu trúc trong `wrangler.halifruit.jsonc`. Secret của từng store tách trong `STORE_SECRETS_JSON`. Store mới không kế thừa cấu hình POS, Auth0, thanh toán hoặc token ký của Halifruit.
- Cache/KV, giới hạn request, cache ảnh và đường dẫn R2 được phân phạm vi. Public key được kiểm tra trước khi trả cache. URL API, OAuth và OpenAPI được tạo theo store.
- Đồng bộ POS chạy riêng từng shop/store. Sản phẩm mới hỗ trợ `physical`, `digital`, `ai_tokens`; sản phẩm số không yêu cầu vận chuyển. Đồng bộ tiếp theo giữ loại biến thể đã chỉnh và metadata giao sản phẩm.
- Printerval đã bỏ client và router gọi Medusa, cùng hai dependency SDK trực tiếp. Router tRPC vẫn có tên `api.medusa` để các component hiện tại tiếp tục hoạt động, nhưng toàn bộ transport của router này dùng Fufuni.
- Tái sử dụng client, schema, adapter sản phẩm/giỏ hàng và router từ Halifruit; bỏ phần phân loại trái cây không phù hợp. Metadata AI/campaign/video được đọc qua API nội dung của store, bằng key nằm phía server.
- Bổ sung đăng ký/đăng nhập email và mật khẩu cho Printerval: mật khẩu có salt, session được lưu dạng hash, có hạn sử dụng và giới hạn thử đăng nhập. Adapter giữ các trường profile mà frontend đang đọc.
- Key giỏ hàng được thống nhất giữa nơi tạo giỏ, header và trang giỏ hàng, dùng namespace Fufuni. Region ID cũ dạng `reg_...` chuyển sang vùng mặc định của store; UUID Fufuni vẫn được xử lý trực tiếp.

## Giữ nguyên giao diện

Đối chiếu bằng TypeScript parser và checksum các đoạn JSX giữa HEAD và working tree: JSX của cả 4 file TSX có thay đổi đều giữ nguyên sau khi chuẩn hóa newline. Không sửa CSS/SCSS. Thay đổi trong những file này chỉ ở import và logic đọc dữ liệu/lưu trữ.

Các trang AI giữ layout, card, route, bộ lọc và checkout preview hiện có. Không thêm giao diện cấp tài khoản/license tự động.

## Kết quả kiểm thử

| Kiểm tra | Kết quả |
|---|---|
| Backend: store, POS, smart shipping, schema SQL, CDN, runtime Worker | **45/45 pass** |
| Printerval: adapter/transport, danh mục AI, component UI | **20/20 pass** |
| Typecheck phần backend chuyển đổi | **Pass** |
| Typecheck lớp dữ liệu Printerval chuyển đổi | **Pass** |
| Build Printerval | **Pass** |
| Wrangler dry-run với config Halifruit | **Pass** |
| JSX/CSS và kiểm tra whitespace diff | **Pass** |
| Đối chiếu dependencies manifest và npm lockfile | **Pass** |
| Quét source TS/TSX tìm SDK/client/config transport Medusa cũ | Không còn kết quả |

Tổng: **65 test pass**. Các lệnh test/build/typecheck được chạy qua RTK.

Runtime test khởi chạy Worker local với SQLite/KV riêng và credential fixture. Đã kiểm tra bootstrap từng store, khởi tạo VND/region hai lần không tạo trùng, đọc sản phẩm riêng, từ chối key của store khác, tách campaign, đăng nhập/profile/session, URL OpenAPI theo store và tuyến download dành cho customer. Test dừng Worker và chỉ xóa thư mục tạm do chính test tạo.

POS API được kiểm thử bằng fixture/mock; chưa kiểm chứng shop POS thật hay thực hiện thanh toán thật.

## Các kiểm tra toàn repo chưa xanh

- Full typecheck backend vẫn có 12 lỗi trong phần cũ: generic không định kiểu ở `ai-tokens.ts`, kiểu response ở `categories.ts`/`orders.ts`, và tên type Stripe ở `checkout.ts`. Không còn lỗi type mới ở phần routing/docs. Typecheck riêng phần chuyển đổi đã pass.
- Full typecheck Printerval gặp router mẫu `bought-together.ts` chứa cú pháp `[...]` và cấu hình `ignoreDeprecations` không phù hợp TypeScript đang cài. Build hiện dùng cấu hình bỏ qua lỗi type có sẵn trong repo; không thay đổi cấu hình đó để che lỗi. Scoped typecheck đã pass.
- Bộ Vitest cũ chưa chạy được vì không có dependency Vitest local; đã dừng lệnh. Các test đó không được tính vào tổng 65 test.

## Cần cấu hình trước khi chạy thật

1. Shop ID và warehouse ID của shop POS Printerval riêng.
2. `PANCAKE_API_KEY`, bootstrap token và signing secret riêng trong `STORE_SECRETS_JSON`.
3. Domain/store URL và origin phù hợp; bật `PANCAKE_SYNC_ENABLED` sau khi cấu hình xong. Hiện Printerval sync được tắt chủ động để tránh gọi nhầm nguồn.
4. Provision key public/admin và VND/region bằng `scripts/init-store.mjs`, sau đó đặt các biến server-only trong `.env.fufuni.example` của Printerval.
5. Deploy backend/FE theo bước riêng, đồng bộ và kiểm tra dữ liệu thật. Khách hàng/token Medusa cũ và metadata hiển thị cũ cần kế hoạch import/reset riêng; code không tự chuyển chúng.

Nội dung campaign/promotion là dữ liệu hiển thị. Discount checkout vẫn dùng API discount của Fufuni. Giá cá nhân hóa theo metadata cần quy tắc nghiệp vụ trước khi bật; adapter trả lỗi rõ khi chưa có quy tắc. File tải xuống dùng cơ chế digital asset hiện có; cấp account/license/subscription bên ngoài không thuộc lần chuyển đổi này.

Hướng dẫn vận hành và thêm store: [MULTI_STORE.md](./MULTI_STORE.md). Template kết nối frontend nằm tại `D:/workspace/printerval-dev-main/printerval-dev/.env.fufuni.example`.
