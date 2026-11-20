# Checkout Stripe + Techcombank QR — triển khai 2026-11-20

## Phạm vi

Một checkout cho sản phẩm vật lý đủ điều kiện, chọn Stripe hoặc QR khi phương thức sẵn sàng. Không bật MCP, R2, sản xuất POD, COD hoặc vận chuyển thật. Printify thuộc chat khác.

## Checklist đã triển khai

- [x] Core: tạo một canonical order pending khi xác nhận thanh toán; một stock hold, immutable quote/payment attempt, retry không nhân đôi order/item/receipt/outbox.
- [x] Stripe cập nhật chính đơn pending sau xác minh provider; giữ tương thích checkout/attempt cũ.
- [x] Chọn phương thức trước payment attempt; khóa sau phát hành, chặn cross-provider attach/settlement/expiration.
- [x] Eligibility theo trạng thái, quốc gia, currency, cấu hình; QR chỉ VN/VND. Không dùng cờ POD để bật domestic checkout.
- [x] QR: đóng băng tài khoản nhận, số tiền, reference và hạn; chỉ admin mới có quyền đối soát sao kê. BFF/storefront không thể xác nhận tiền.
- [x] Kiểm tra amount/reference/account/currency/time/transaction ID. Chứng cứ lệch, chuyển thêm, muộn, lỗi stock/order được lưu manual_review; không tạo đơn thêm hoặc tự coi là paid.
- [x] Chống tái dùng transaction ID giữa QR mới và luồng domestic cũ.
- [x] QR hết hạn không tự suy đoán chưa nhận tiền. Chỉ admin đóng unpaid sau review có chứng cứ; unmatched funds chặn đóng. Sau đóng, khoản tới muộn vẫn lưu review.
- [x] FE selector, buyer confirmation, Stripe redirect allowlist, QR instructions, ownership cookie/CSRF, refresh/reconcile từ backend.
- [x] Admin /admin/bank-payments: danh sách, chi tiết, nhập chứng cứ, nhật ký actor và kết quả; thao tác có xác nhận kiểm tra sao kê.
- [x] Marketing RFM/A-B/attributed revenue nhận thêm biên nhận QR đã đối soát; pending chưa thành doanh thu.
- [x] Công tắc CHECKOUT_PAYMENTS_PAUSED chặn yêu cầu pay mới; reconcile/webhook/admin verification tiếp tục.

## Biến cấu hình bổ sung sau

Repo Kedi-ecommerce-core → Settings → Secrets and variables → Actions → Variables:

| Variable | Giá trị / ý nghĩa |
| --- | --- |
| CHECKOUT_QR_ENABLED | true chỉ khi sẵn sàng nhận và đối soát QR; để trống/false hiện tại |
| TECHCOMBANK_ACCOUNT_NUMBER | Số tài khoản nhận thật, 6–20 chữ số |
| TECHCOMBANK_ACCOUNT_NAME | Tên chủ tài khoản đã xác minh |
| CHECKOUT_PAYMENTS_PAUSED | true để ngừng khởi tạo/tiếp tục pay; false/để trống khi hoạt động |

Workflow chuyển các giá trị trên qua allowlist an toàn sang Worker. Không cần API token ngân hàng để hiển thị QR và xác minh thủ công. Tự động xác nhận ngân hàng chưa triển khai vì chưa có nguồn giao dịch đáng tin cậy.

Stripe: tái dùng STRIPE_SECRET_KEY và STRIPE_WEBHOOK_SECRET hiện có. Chưa yêu cầu live key. FE domestic cũ có cờ riêng DOMESTIC_CHECKOUT_FRONTEND_ENABLED, mặc định tắt; QR mới dùng shared checkout nên không cần bật cờ này hay POD.

## Kiểm thử

- Backend full regression: 187/187; gồm runtime Worker/DO, auth finance, 6 callback đối soát đồng thời, tồn kho, payment settlement, marketing.
- Backend và admin typecheck xanh; Admin UI 8/8 trước các thay đổi đồng thời từ Printify.
- Frontend 271/271 trong 59 suites, module boundaries/typecheck/lint và OpenNext build xanh.
- Browser 9/9: Stripe review/redirect/status; QR selection/instructions/reload/mobile, không tự paid; handoff và các luồng cũ.
- Deploy settings Python 2/2, generator 8/8, ACP request + 3 HTTP response schema xanh; manifest patch test 1/1.
- RTK chỉ thu gọn log; lưu full log local, dùng exit code của lệnh gốc.

## Nghiệm thu cần cấu hình và thao tác thật

- [ ] SKU được merchant duyệt có giá/currency, cân nặng, tồn khả dụng, tax và delivery rõ ràng. Không coi dữ liệu POD thử là hàng bán thật.
- [ ] Hoàn tất một Stripe test payment qua hosted checkout và nhận webhook ký hợp lệ; hiện test tự động dùng fixture, chưa chứng minh giao dịch sandbox thực sự hoàn tất.
- [ ] Cấu hình tài khoản ngân hàng, xác minh QR đúng tài khoản trên app ngân hàng; nếu thử chuyển tiền thật phải do người dùng thực hiện riêng.
- [ ] Kiểm tra admin staff login thực tế và quy trình review/refund/xử lý thừa thiếu, muộn. Các khoản manual_review hiện cần xử lý nghiệp vụ riêng; không có nút tự bỏ qua sai lệch để paid.
- [ ] Bật bán hàng giới hạn sau nghiệm thu; chưa tự tạo vận đơn, sản xuất hoặc gửi email khách.

## Phát hành

- Backend code: 6d1d150 → d225da8 → 148bb26, push main đúng Kedi-ecommerce-core. Bản cuối CI/Worker deploy thành công: https://github.com/phuongnguyen240805/Kedi-ecommerce-core/actions/runs/44744621241
- Admin CI/Pages deploy thành công: https://github.com/phuongnguyen240805/Kedi-ecommerce-core/actions/runs/44743827437
- FE: efd7be8, push main kedimuse-fe; CI thành công: https://github.com/phuongnguyen240805/kedimuse-fe/actions/runs/44743867384
- FE live Worker printerval version 352855a6-ce03-495b-936a-6f769f11fd27; /commerce-checkout HTTP 200.
- Chrome live viewport 390×844: không lỗi JavaScript, không tràn ngang; catalog chưa đủ cấu hình nên nút tạo đơn bị chặn.
- Live backend status: enabled=true, stripe_configured=true (test-mode qua readiness), qr_configured=false, payments_paused=false, payment_methods_version=1.
- Live catalog: 0 SKU đủ điều kiện; readiness 3 variant hiện chưa sẵn sàng. Không thêm giá/thuế/phí vận chuyển giả để mở bán.
- Live finance API: không auth hoặc dùng storefront BFF token bị 401; webhook Stripe không ký bị 400; MCP 404, POD production tắt, marketing tắt.
- Chưa nghiệm thu Stripe test payment thực sự, chuyển khoản ngân hàng hoặc đăng nhập staff thực tế. Các cấu hình và thử nghiệm này giữ pending theo yêu cầu bổ sung sau.
- Không stage/commit các thay đổi Printify đang được chat khác thực hiện trong cùng workspace.

Không xem test xanh là đã nghiệm thu giao dịch tiền thật.
