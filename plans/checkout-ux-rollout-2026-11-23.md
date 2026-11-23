# Triển khai cải thiện checkout UX — 23/11/2026

## Phase 1 — Lựa chọn thanh toán và trạng thái

- Thay dropdown bằng các ô radio Stripe / Techcombank QR / COD, có giải thích và ký hiệu nhận diện; không chọn phương thức mặc định.
- Chọn lại trước xác nhận không đặt đơn hoặc thu tiền; QR/Stripe đang chờ giữ nguyên đường đổi an toàn từ bản trước. COD đã xác nhận cần liên hệ cửa hàng.
- Thay mã trạng thái nội bộ bằng nhãn dễ hiểu; COD xác nhận đơn không được mô tả là đã thanh toán. Không hiển thị tên hệ thống POS hoặc trạng thái kỹ thuật cho người mua.
- Tất cả nội dung checkout có bản Việt/Anh, chọn theo trình duyệt hoặc tùy chọn đã lưu. Đổi ngôn ngữ không xóa dữ liệu.
- Test phase 1: radio không tự chọn, khóa đúng lựa chọn và nhãn COD/tiền tệ/URL ảnh — xanh.

## Phase 2 — Tóm tắt sản phẩm và chuyển khoản QR

- Backend bổ sung tên sản phẩm, tên biến thể và ảnh từ catalog chính thức (ưu tiên biến thể/thumbnail, rồi ảnh sản phẩm hoặc metadata hiển thị của cửa hàng); payload khách không thể tự đưa metadata vào báo giá. FE giữ tương thích các snapshot cũ.
- FE hiển thị tên, ảnh nếu có, màu/size, số lượng và tiền hàng. Chỉ nhận URL ảnh HTTPS không có credentials.
- QR có nút sao chép tài khoản, số tiền nguyên và nội dung; báo sao chép thành công/thất bại. Đồng hồ chỉ là thông tin giao diện, không phải bằng chứng trả tiền.
- QR hết hạn tự ẩn hình và vô hiệu nút sao chép; giữ thông tin hướng dẫn kiểm tra khoản đã gửi. Không thêm nút tự nhận đã thanh toán.
- Test phase 2: metadata canonical, cấm metadata tự nhập; sao chép nguyên số tiền, hết hạn, không tạo xác nhận tiền từ client — xanh.

## Phase 3 — Báo giá và mobile

- Tự tính phí sau khi thông tin hợp lệ ổn định 650ms; chọn dịch vụ tự cập nhật tổng. Giữ nút cập nhật thủ công để retry.
- Các mutation báo giá chạy tuần tự và giữ version/idempotency. Kết quả về muộn không ghi đè địa chỉ mới; vẫn nhận version server để gửi tiếp. Không abort một mutation rồi phỏng đoán rằng server chưa xử lý.
- Lỗi không gây vòng lặp gọi lại vô hạn; khi có thể, đọc lại version từ server trước retry. Request danh mục địa chỉ cũ được abort khi đổi tỉnh/huyện.
- Đổi COD/prepaid xóa dịch vụ cũ và yêu cầu báo giá đúng phương thức. Không tự chọn dịch vụ mới hoặc tự thanh toán.
- Backend trả thời hạn báo giá thực. Hết hạn vô hiệu thanh toán, xóa lựa chọn cũ, báo giá lại và yêu cầu khách kiểm tra/xác nhận tổng mới. Backend vẫn là nơi quyết định phí, tồn kho và điều kiện trả tiền.
- Tên quốc gia thay mã nhập tay, autocomplete phù hợp, căn hộ không bắt buộc mặc định thu gọn. **Mã bưu chính vẫn bắt buộc** theo contract backend đang chạy; không tự bỏ một ràng buộc shipping.
- Tóm tắt địa chỉ có nút sửa/thu gọn; mobile có thanh tổng tiền và nút tới bước kiểm tra. Nút này không gửi yêu cầu pay. Giữ khoảng trống cho thanh cố định và safe area.
- Đã sửa vùng nội dung để không tạo main lồng main.

## Kiểm thử phát hành

- Backend **219/219 xanh** + typecheck; frontend Jest + typecheck/lint/boundaries + OpenNext production build xanh.
- Browser suite: **22/22 xanh**, gồm báo giá tự động tuần tự, sửa địa chỉ trong lúc request đang chạy, COD đổi phí, quote hết hạn, chặn thiếu điện thoại nội địa, radio chủ động, Việt/Anh sau reload, sao chép QR, đổi phương thức, cart handoff và AI shopping không auto-pay.
- Frontend regression: **331/331 xanh**. Backend có thêm regression cho snapshot cũ không có metadata ảnh, đồng thời vẫn chặn thay đổi giá thật.
- Chỉ push/deploy sau khi bộ kiểm thử tương ứng xanh; nghiệm thu production bằng dữ liệu TEST NO SHIPPING, không chuyển tiền và không tạo vận đơn.

MCP/R2/POD production, Stripe live và GHN dispatch thật tiếp tục giữ trạng thái cũ. Không đổi tài khoản ngân hàng, phí, thuế hoặc credential trong đợt UX này.

Đây là cải thiện từ đánh giá chuyên gia và test chức năng, chưa phải kết quả nghiên cứu với khách hàng thật hoặc chứng minh tỷ lệ chuyển đổi tăng. Tham khảo và giả thuyết đo lường nằm trong `checkout-payment-choice-ux-2026-11-23.md`.
