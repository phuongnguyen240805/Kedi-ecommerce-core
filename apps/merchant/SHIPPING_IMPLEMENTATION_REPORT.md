# Báo cáo triển khai vận chuyển Halifruit — 12/11/2026

## Kết quả và phạm vi nghiệm thu

Đã triển khai lớp cấu hình tài khoản, lựa chọn dịch vụ, điều phối lệnh bền vững, webhook/polling, tích hợp yêu cầu hậu mãi và giao diện vận chuyển. Giữ nguyên bố cục/màu thương hiệu storefront. Không thay thế ledger tiền, cơ chế xác nhận ngân hàng hay nguồn tồn kho POS.

**Đây là nghiệm thu code và môi trường local. Chưa phải xác nhận hệ thống production đã tự động hoàn toàn.** Chưa deploy, chưa gửi booking/hủy/thu tiền/hoàn tiền thật. Quyền tài khoản và các thao tác hãng chưa có hợp đồng được xác minh tiếp tục bị chặn hoặc chuyển hàng đợi xử lý.

## Theo từng phase

| Phase | Kết quả triển khai | Phạm vi bằng chứng |
| --- | --- | --- |
| G0 — Hợp đồng | Đối chiếu tài liệu GHN và Pancake; phân biệt trạng thái POS với xác nhận vận đơn; công bố các API điều phối trong OpenAPI | Tài liệu chính thức + contract fixtures; chưa xác nhận quyền tài khoản thật |
| G1 — Đa hãng/tài khoản | Registry theo store/kho/tài khoản/môi trường; quote song song, timeout từng adapter, eligibility, tiết kiệm/nhanh/cân bằng, circuit breaker theo tài khoản | 1–3 provider giả lập và adapter GHN; runtime hiện chỉ đăng ký GHN |
| G2 — Điều phối | Legs, commands, inbox, conflicts, account health trong SQLite DO; idempotency, lease, dấu attempted trước I/O, kiểm tra lại payload trước gửi | Node SQLite + RPC trên Worker/DO thật tại local |
| G3 — Chiều vào | Nhận webhook GHN/POS với secret header; lưu trước, xử lý sau; đọc lại API có xác thực; chống lặp/sai shop/cũ/lùi trạng thái; polling dự phòng | HTTP fixtures + kiểm thử biên auth + runtime DO; chưa thử webhook delivery thật |
| G4 — Nghiệp vụ | Booking direct; hủy có xác minh; đổi địa chỉ gắn báo giá/thu hoàn chênh lệch; COD cần xác thực; chuyển hoàn/giao lại theo trạng thái; chặng thu hồi/giao bù riêng; liên kết QC và yêu cầu khách | Luồng hợp lệ và lỗi có kiểm thử; các giới hạn bên dưới vẫn áp dụng |
| G5 — QA/rollout | Test hồi quy, typecheck, UI desktop/mobile, CI và hướng dẫn cấu hình | Đạt local; pilot và nghiệm thu production chưa thực hiện |

## Hành vi sau triển khai

1. Checkout dùng registry thay vì truyền cứng một adapter tại route. Kết quả lưu account, owner, service, môi trường, kho lấy hàng và lý do lựa chọn vào quote/order. Đổi policy/cấu hình làm quote chưa đặt hết hiệu lực; đơn đã xác nhận giữ snapshot.
2. Account không đáp ứng COD, trọng lượng, khu vực, kho hoặc quyền đã xác minh bị loại trước khi lấy giá. Một account lỗi/chậm không xóa báo giá hợp lệ của account khác. Không tạo ETA, giá hoặc điểm uy tín giả.
3. Booking chỉ gửi qua đúng owner. Đơn cũ mặc định tiếp tục thuộc Pancake. Không dùng adapter direct để sửa/hủy vận đơn Pancake và không tự đổi hãng sau timeout.
4. Trước booking direct, hệ thống đọc lại POS và kiểm tra tham chiếu, tổng tiền, COD, trạng thái, vận đơn đã có, kho, sản phẩm/số lượng và địa chỉ. Sau đó mới đánh dấu attempted và gửi GHN. Nếu quá trình chết hoặc timeout, lần sau chỉ tra cứu theo mã tham chiếu ổn định.
5. Tạo/hủy/sửa không được coi là thành công chỉ vì HTTP 200. Kết quả thao tác GHN được kiểm tra, sau đó đọc lại vận đơn. Bản đồng bộ POS cũng phải được đọc lại xác nhận. Đường direct không gửi cờ tạo vận đơn GHN sang POS.
6. Hủy/đổi địa chỉ đã được duyệt được đưa vào hàng đợi tự động khi cấu hình cho phép. Chỉ hoàn tất yêu cầu khách sau khi có bằng chứng hãng và POS. Ô xác nhận `external_cleared` không thể bỏ qua kiểm tra này đối với đơn direct.
7. Hủy trước booking cần cả bằng chứng DO chưa gửi create, phản hồi không tồn tại rõ ràng từ GHN và đọc lại POS đã ngừng xử lý. Timeout/403 không phải bằng chứng không tồn tại.
8. Đổi địa chỉ giữ đúng account/service. Báo giá phải còn hạn lúc gửi. Chênh lệch chuyển khoản/hoàn tiền phải đối soát xong; COD mới phải khớp giá trị hãng đã xác nhận. Không tự ghi có ngân hàng hoặc thực hiện hoàn tiền giả.
9. Webhook chỉ cung cấp tín hiệu để tra cứu. Thay đổi hủy trên POS được đọc lại qua API trước khi tạo yêu cầu/lệnh hủy. Địa chỉ sửa ngoài POS được ghi nhận ngoại lệ cần báo giá/xác nhận, không tự áp vào vận đơn khi chưa xác định chi phí và sự đồng ý của khách.
10. Giao thành công, webhook COD hay trạng thái hoàn hàng không tự xác nhận đã nhận tiền, đã chuyển COD về ngân hàng, đã hoàn tiền hoặc đã tăng tồn bán được. Ledger/đối soát và kiểm tra lô vẫn độc lập.
11. Thu hồi sau giao và giao bù có leg riêng, mã tham chiếu riêng, nhiều lần theo sequence. Không ghi đè vận đơn gốc. Chặng đặt ngoài hệ thống chỉ được liên kết sau khi đọc lại đúng account/shop/client code. QC có leg thu hồi phải chờ xác nhận nhận hàng; giao bù trên đơn direct phải tham chiếu leg đã xác minh.
12. Admin có hàng đợi lỗi, trạng thái từng lệnh/chặng, ngoại lệ và thao tác kiểm tra lại giữ nguyên attempted. Trang tra cứu hiển thị các vận đơn riêng, mã dài không tràn ngang. Không đưa token hãng hoặc thông tin tài khoản nội bộ vào UI khách.

## Giới hạn có chủ đích và phần chưa nghiệm thu

- **Chưa mở thêm hãng production:** GHN là adapter thật duy nhất. Test 1–3 provider chứng minh engine tổng hợp/cô lập lỗi, không chứng minh GHN/Viettel Post/GHTK đều đã kết nối. Hãng mới cần adapter, resolver địa chỉ, capability và contract tests; không thể chỉ thêm tên hãng vào JSON.
- **Vận đơn Pancake sở hữu:** vẫn dùng đường cũ cho tạo/theo dõi. Tài liệu PUT trạng thái POS chưa chứng minh việc hủy/sửa vận đơn GHN tự động. Vì vậy, thao tác không có connector đã xác minh trả `manual_review`, không báo thành công giả. Không chuyển hàng loạt owner của đơn cũ.
- **COD/OTP:** không lưu OTP và không dùng endpoint updateCOD làm đường bỏ qua xác thực. Lệnh có thể ở `awaiting_auth`; người có quyền xác thực trên GHN, sau đó hệ thống đọc lại giá trị mong muốn. Chưa có dịch vụ payout ngân hàng được tích hợp để hoàn tiền tự động.
- **Chuyển hoàn khác thu hồi sau giao:** GHN return áp dụng trạng thái được phép của vận đơn đang lưu chuyển. Chặng thu hồi sau giao/giao bù hiện được chuẩn bị để đặt qua quy trình ngoài có kiểm soát, rồi tra cứu liên kết; chưa tự booking reverse pickup hoặc tự xuất kho giao bù.
- **Sửa địa chỉ trên POS:** được phát hiện và chặn xuất hàng/ghi ngoại lệ. Chưa tự chấp nhận địa chỉ mới hoặc cước mới từ POS. Cần quy trình báo giá và xác nhận tương ứng; envelope webhook không nhận diện được được giữ ở `unmatched`.
- **Handover owner, chia kiện và tự đổi hãng của vận đơn đã tồn tại** chưa được mở. Việc chuẩn bị leg mới không phải một lệnh bàn giao owner hay bằng chứng đã hủy leg cũ.
- Chưa chạy pilot với tài khoản GHN/Pancake thật; chưa xác nhận quyền sửa/hủy, cấu hình callback thực tế, SLA hoặc quyền ánh xạ tracking ngoài vào POS. Các flag `verified` phải phản ánh nghiệm thu thực tế, không tự bật để vượt lỗi.

## Kết quả kiểm thử cuối

| Bộ kiểm thử | Kết quả |
| --- | --- |
| Commerce core + local Worker/DO/R2 runtime | 45/45 |
| Shipping workflow mới | 22/22 |
| Smart shipping hiện có | 12/12 |
| Store isolation, gồm registry/secret vận chuyển | 14/14 |
| Admin operations UI | 4/4 |
| FE checkout, phục hồi, progress và order service | 58/58 |
| FE product/storefront policy regression | 20/20 |
| Tổng test tự động | **175/175** |
| Backend TypeScript toàn app merchant | Đạt |
| Admin client TypeScript | Đạt |
| FE `typecheck:checkout` | Đạt |
| Chrome local 1440/768/390/360 px | 4/4; 0 lỗi JavaScript, 0 tràn ngang |

Test runtime dùng Worker, SQLite DO, RPC và R2 tại local. Test gọi GHN/POS dùng phản hồi HTTP giả lập, bao gồm adapter thật và readback mirror; không có giao dịch ngoài. Test browser giả lập tRPC, bao gồm hủy, đổi địa chỉ, đổi trả và nhiều chặng với tracking dài. Không suy rộng kết quả này thành nghiệm thu hãng thật hay load test.

Lượt này không chạy build production/Cloudflare hoặc typecheck toàn bộ FE ngoài phạm vi checkout. Kết quả typecheck checkout không khẳng định các module editor/3D còn lại đều sạch lỗi.

Log QA trong `.wrangler/shipping-*.log` của từng workspace; ảnh và báo cáo browser trong `D:/workspace/halifruit-fe-v1/.wrangler/order-service-qa/`. Các thư mục này là artifact local được ignore. Test được đưa vào CI qua `test:shipping` và `test:shipping:workflow` bên cạnh commerce/store/admin tests.

## Cấu hình và mở production

Thiết lập riêng từng store, không dùng chung secret giữa các shop:

- `CARRIER_REGISTRY_JSON`: account id, `carrier_id`, `execution_owner`, `enabled`, `verified`, `warehouse_id`, `environment`, GHN shop/origin, capabilities, COD và giới hạn kiện.
- `CARRIER_SECRETS_JSON`: map account id → `{ token, webhook_secret }`; quản lý dưới dạng secret. Không đặt token vào registry công khai.
- Account thuộc Pancake phải có `pancake_partner_id`, `pancake_account_id` đã xác minh; account được quote phải khớp tài khoản POS đang cấu hình.
- `SHIPPING_AUTOMATION_ENABLED=true` chỉ sau pilot; booking cũng cần snapshot đơn cho phép dispatch.
- `PANCAKE_TRACKING_MIRROR_VERIFIED=true` chỉ sau khi đã thử PUT/readback tracking ngoài với đúng shop/đối tác. Luồng trả trước vẫn cần `PANCAKE_PAYMENT_MAPPING_VERIFIED`.
- `PANCAKE_ORDER_WEBHOOK_SECRET`: secret riêng tối thiểu 24 ký tự. GHN/POS gửi header `X-Shipping-Secret` đã cấu hình. Callback GHN: `/v1/carrier-events/ghn/{accountId}`; callback POS: `/v1/carrier-events/pancake`. Store không mặc định dùng đúng prefix `/stores/{storeId}`.

Mở theo thứ tự: deploy schema/API nhưng giữ tự động tắt → cấu hình và xác minh account/callback → shadow-read/readback → staging → pilot từng kho/tài khoản → mở từng capability. Đối chiếu số vận đơn, phí/COD, địa chỉ, log inbox và tình trạng POS trước khi tăng phạm vi. Tắt bán mới của account không tắt khả năng nhận callback/đối soát vận đơn cũ.

Rollback bằng tắt tạo/thay đổi mới, giữ reader và cron reconciliation cho lệnh đã gửi. Không xóa attempted, legs, inbox hoặc khôi phục database về trước các giao dịch ngoài để retry booking.

## Tài liệu hợp đồng đã đối chiếu

- [GHN tạo đơn](https://developer.ghn.vn/vi/docs/order/create), [đọc theo mã shop](https://developer.ghn.vn/vi/docs/order/info-by-client-code), [cập nhật và OTP](https://developer.ghn.vn/vi/docs/order/update).
- [GHN hủy](https://developer.ghn.vn/vi/docs/order/cancel), [chuyển hoàn](https://developer.ghn.vn/vi/docs/order/return), [giao lại](https://developer.ghn.vn/vi/docs/order/delivery-again), [webhook](https://developer.ghn.vn/vi/docs/webhook/callback-order-status).
- [Pancake Order API](https://pos.pancake.vn/developers/api/en/order), [Pancake nhận webhook](https://pos.pancake.vn/developers/api/en/webhooks).
