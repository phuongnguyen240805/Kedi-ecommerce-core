# Checkout: sửa lựa chọn thanh toán và đánh giá UX

Đánh giá chuyên gia dựa trên code, giao diện checkout hiện tại và thử nghiệm chức năng. Chưa phỏng vấn người mua hoặc chạy nghiên cứu usability với người dùng thật; các ảnh hưởng tới chuyển đổi dưới đây là giả thuyết cần đo.

## Thay đổi trong đợt này

- Trước xác nhận: khách có thể đổi lựa chọn Stripe/QR/COD. Chuyển giữa COD và prepaid phải tính lại phí, không dùng lại báo giá khác phương thức.
- Khi đã mở QR hoặc bắt đầu Stripe nhưng chưa trả tiền: có nút **Đổi phương thức thanh toán**, xác nhận chưa thanh toán/chuyển khoản, và nút giữ lựa chọn hiện tại. Không tự thanh toán sau khi đổi.
- Server đóng phiên Stripe open bằng API expire, kiểm tra trạng thái thật; complete/paid/đang xử lý/không rõ kết quả đều không được coi là chưa trả tiền. Nếu expire trả lỗi thì retrieve lại; chỉ tiếp tục khi xác minh expired+unpaid.
- Đổi tạo một checkout thay thế có cùng sản phẩm, số lượng, email, địa chỉ; bỏ báo giá vận chuyển cũ, yêu cầu tính lại tổng và xác nhận. Phiên/đơn cũ được hủy, trả lại đúng phần giữ tồn, giữ nguyên lịch sử và mã chuyển khoản để xử lý tiền tới muộn. Tiền tới QR cũ phải kiểm tra thủ công, không tự ghi paid.
- Yêu cầu đổi lặp/đồng thời trả về cùng checkout thay thế. Đơn đã thanh toán hoặc COD đã xác nhận/đang xử lý không bị tự ý đổi. COD có hướng dẫn liên hệ cửa hàng để cập nhật đơn hiện tại.
- BFF kiểm tra cookie sở hữu, cùng origin, POST, payload nghiêm ngặt và xác nhận rõ ràng; cấp lại cookie cho checkout thay thế.

## Các điểm chưa phù hợp và hướng khắc phục

| Ưu tiên | Quan sát hiện tại | Ảnh hưởng dự kiến | Hướng khắc phục | Trạng thái |
|---|---|---|---|---|
| P0 | QR/Stripe khóa phương thức sau khi mở, thiếu đường quay lại | Người chọn nhầm có thể bỏ cuộc hoặc tạo thêm đơn | Đường đổi có kiểm tra trạng thái, giữ dữ liệu, ngăn hai phiên cùng nhận tiền | Đã sửa cho phiên chưa thanh toán |
| P0 | COD checkout hiển thị `completed` dù chưa thu tiền | Dễ hiểu nhầm đã thanh toán/giao xong | Dùng nhãn riêng: Đã xác nhận đơn / Chờ thu hộ / Đang chuẩn bị / Đã giao; ẩn mã trạng thái nội bộ | Đã có nội dung giải thích COD; cần chuẩn hóa toàn bộ nhãn |
| P1 | Phương thức là dropdown và có lựa chọn mặc định | Dễ bỏ qua phương thức phù hợp hoặc không nhận ra khác biệt | Radio cards có logo, chi phí/điều kiện và mô tả; không tự chọn khi khách đang chủ động chọn lại | Đề xuất |
| P1 | Nhập địa chỉ, tính phí, chọn dịch vụ rồi phải bấm tính lại | Nhiều thao tác và dễ nhìn nhầm tổng cũ | Tự báo giá khi địa chỉ đủ dữ liệu, debounce và hủy request cũ; chọn dịch vụ cập nhật tổng; giữ bước xác nhận tổng cuối | Đề xuất, phải giữ version/quote TTL và phí COD chính xác |
| P1 | Trộn tiếng Việt/Anh và `complete_in_progress`, `synced`, `pending` | Tăng công sức đọc, gây lo lắng khi tiền/đơn có trạng thái khác nhau | Một ngôn ngữ theo locale; nhãn thân thiện và hành động tiếp theo; mã kỹ thuật chỉ ở log hỗ trợ | Đề xuất |
| P1 | Tóm tắt có thể chỉ hiện tên biến thể như Black/Size S | Khó xác minh đã mua đúng mẫu | Tên sản phẩm + ảnh + màu/size + số lượng + link sửa, không làm mất địa chỉ | Đề xuất |
| P1 | Nhiều trường địa chỉ kỹ thuật; mã quốc gia VN/US và postal code bắt buộc | Khách nội địa có thể điền sai hoặc dừng lại | Chọn quốc gia bằng tên, trường theo quốc gia, autocomplete đúng loại; postcode chỉ bắt buộc khi thị trường/hãng cần | Đề xuất, không tự bỏ yêu cầu carrier/backend |
| P1 | QR có hướng dẫn nhưng chưa có nút sao chép mã/số tiền và thời gian chờ rõ | Sai nội dung chuyển khoản hoặc trả tiền lại khi chưa thấy xác nhận | Copy mã/số tiền/tài khoản, nhãn Chờ cửa hàng đối chiếu, nêu bước liên hệ; không dùng nút “Tôi đã trả” để tự đánh dấu paid | Đề xuất |
| P2 | Form dài, tổng và hành động nằm dưới màn hình mobile | Khó nhớ tổng và bước hiện tại | Thu gọn bước hoàn tất, thanh tổng + hành động trên mobile không che form, focus vào lỗi cần sửa | Đề xuất |

## Cơ sở tham khảo

- [NN/g — User Control and Freedom](https://www.nngroup.com/articles/user-control-and-freedom/): lối thoát rõ ràng và khả năng quay lại/sửa lựa chọn.
- [NN/g — Error-Message Guidelines](https://www.nngroup.com/articles/error-message-guidelines/): ngôn ngữ người dùng, giải thích lỗi và hành động khắc phục.
- [Baymard — Checkout UX](https://baymard.com/blog/checkout-flow-ux-optimization): giữ dữ liệu khi quay lại, sửa trực tiếp tại bước review, giảm trường nhập.
- [Baymard — Payment UX](https://baymard.com/blog/payment-ux): phần chọn phương thức riêng trong checkout.
- [Stripe — Expire Checkout Session](https://docs.stripe.com/api/checkout/sessions/expire): chỉ expire phiên open; phiên đã expire không thể hoàn tất thanh toán.

## Cách đo sau triển khai

Đo số lần mở/hoàn tất đổi phương thức, tỷ lệ hoàn tất checkout sau đổi, lỗi báo giá, số lần bấm trả tiền lại và đơn trùng. Không thu số thẻ, số tài khoản, địa chỉ hoặc nội dung QR vào analytics. Kiểm tra riêng mobile và ba phương thức; phỏng vấn/quan sát người dùng trước khi kết luận thay đổi giúp tăng chuyển đổi.

Không bật vận đơn GHN thật, không thay đổi cấu hình ngân hàng, không chuyển Stripe sang live trong đợt này.
