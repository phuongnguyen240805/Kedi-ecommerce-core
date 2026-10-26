# Kết nối POS Printerval vào mục AI

Ngày kiểm chứng: 14/10/2026.

## Bản chạy thật

- Frontend: https://printerval.gofiber-phuongnguyen.workers.dev/tai-khoan-ai
- Catalog: https://printerval.gofiber-phuongnguyen.workers.dev/api/ai-catalog
- Backend: https://halifruit-backend.gofiber-phuongnguyen.workers.dev/stores/printerval
- Shop POS: `715160501`; kho: `17e77e47-689e-4b37-a55c-d1abbfba5d11`.
- Backend version: `a0a446c5-0bf1-4d80-9532-c4f499e5e7f9`.
- Frontend version: `734e0c14-95f3-4da1-a961-65c1799f4b8d`.

## Kết quả

Đã khởi tạo key public/admin riêng cho Printerval, tiền tệ VND và region. Secret được lưu trong file local bị Git bỏ qua và secret Worker; không ghi giá trị vào báo cáo hoặc source.

Đồng bộ đủ 318 sản phẩm, 318 biến thể loại digital và 318 bản ghi tồn kho. Giá và số lượng của từng biến thể được đối chiếu khớp với POS. Lịch đồng bộ POS sang Fufuni chạy mỗi giờ.

POS chưa có ảnh và mã mẫu tùy chỉnh. Backend dùng SKU dự phòng ổn định theo shop/variation ID. Đã bổ sung 318 product metadata và 318 variant metadata theo mã sản phẩm POS đối chiếu với ZIP crawl. Ảnh dùng `source_image_url` khi POS chưa có ảnh; nếu POS có ảnh, ảnh POS được ưu tiên. Metadata không ghi đè giá hoặc tồn kho và được giữ qua các lần sync.

Frontend giữ layout/CSS. Catalog chỉ trả trạng thái `inStock`, không trả số lượng tài khoản. Tồn khả dụng bằng `max(0, on_hand - reserved)`; khi bằng 0, hiện Hết hàng và khóa nút mua. Catalog được tải lại mỗi phút và khi cửa sổ được focus; thay đổi ở POS vẫn cần sync trước.

## Kiểm chứng

- 26 test frontend pass, scoped typecheck Fufuni pass.
- Test backend stores/POS pass; backend dry-run pass.
- OpenNext build và frontend dry-run pass; đã deploy cả backend và frontend.
- API public trả HTTP 200, 318 sản phẩm có giá, 318 ảnh và 318 trạng thái tồn đã xác định.
- Không có `inventory_quantity`, `on_hand`, `reserved` trong API AI catalog.
- Không có key Fufuni server trong các browser assets được kiểm tra.
- Key Printerval hợp lệ bị từ chối ở catalog Halifruit (HTTP 401).
- Trình duyệt đã xác nhận trang public, bộ lọc AI, ảnh tải thành công và trang chi tiết có giá/thời hạn thật.

## Cấu hình triển khai

Frontend cần `global_fetch_strictly_public` bên cạnh `nodejs_compat` để gọi Worker backend cùng zone qua URL công khai. Bản đầu thiếu cờ này trả lỗi catalog; bổ sung cờ và redeploy đã trả HTTP 200.

Build command OpenNext gọi Next.js đã cài trực tiếp để tránh pnpm tự kiểm tra dependency qua registry mirror. Wrangler frontend 4.82.2 bị treo ở bước deploy; đã dùng Wrangler 4.90.1 có sẵn trong workspace Fufuni để đóng gói/deploy, không nâng version dependency.

Next build vẫn dùng cấu hình có sẵn bỏ qua full typecheck; scoped Fufuni typecheck được chạy riêng. Không kiểm chứng thanh toán, tự cấp tài khoản/license hoặc khả năng sở hữu kho tài khoản nguồn; phạm vi lần này là kết nối và hiển thị sản phẩm từ POS.

## Cập nhật nhóm gói AI

Frontend version `e2c430be-9716-4423-8095-1b4bc963f912` đã triển khai ngày 14/10/2026.

Catalog hiện hiển thị 6 nhóm: Claude 115 gói, Cursor 54, Replit 44, Higgsfield 41, DeepL 33 và Kling 31. Fufuni/POS vẫn giữ 318 sản phẩm/biến thể độc lập; nhóm chỉ là cách trình bày frontend.

Mỗi thẻ xem nhanh tối đa 4 gói. Xem tất cả mở danh sách đầy đủ của nhóm, giữ ID, giá VND, người bán, thời hạn và trạng thái riêng từng gói. Bộ lọc được xây dựng từ toàn bộ gói. Không nhân bản danh sách đầy đủ theo từng URL cũ trong API; URL cũ được nhận diện qua member IDs/handles và mở nhóm tương ứng. URL nhóm giữ ổn định khi thay đổi thứ tự dữ liệu hoặc thêm gói.

Ưu tiên `group_id/group_name`, tiếp đến URL dịch vụ cha trong metadata, sau đó tên sản phẩm giống nhau sau chuẩn hóa. Không ghép theo tiền tố gần giống, và không ghép qua category/type khác nhau. Không sửa dữ liệu POS hoặc giá/tồn để tạo nhóm.

31 test frontend pass; scoped typecheck và OpenNext build pass. API public HTTP 200: 6 nhóm, 6 danh sách chi tiết, 318 gói và 318 ID duy nhất, không trả số lượng tồn. Trình duyệt đã xác nhận 6 thẻ, Xem tất cả Claude hiển thị 115 gói và trang 20 chứa gói cuối cùng.

## Cập nhật hiển thị xen kẽ

Frontend version `0ece3088-8b73-4175-98fa-e6e9d1fa2e5b` đã triển khai ngày 14/10/2026.

Catalog hiển thị xen kẽ một thẻ nhóm và một gói lẻ ngẫu nhiên của nhóm: hiện có 6 nhóm và 6 gói lẻ. Chọn từ toàn bộ ưu đãi có giá dương hợp lệ, đúng tiền tệ và xác nhận còn hàng. Lựa chọn ổn định trong một lần mở trang, thay đổi ngẫu nhiên ở lần mở tiếp theo; bộ lọc chỉ hiển thị gói thuộc nhóm đang lọc. Không sửa giá, dữ liệu POS hoặc hiển thị số lượng tồn.

Gói lẻ sử dụng thẻ và CSS sẵn có, có nút Mua ngay. Nút truyền đúng variant ID, giá, thời hạn, người bán và bảo hành vào luồng chọn gói hiện có. Xem tất cả của thẻ nhóm vẫn mở toàn bộ ưu đãi. Luồng mua hiện tại vẫn là mô phỏng/preview, chưa tích hợp thanh toán hoặc tạo đơn thật.

35 test frontend (7 suites), scoped Fufuni typecheck và OpenNext build pass; deploy thành công. Trình duyệt public xác nhận 12 thẻ theo thứ tự group/single xen kẽ và Mua ngay mở đúng Kling Standard, 258.799 VND, 1 tháng, người bán InstantClick, bảo hành 20 ngày. Ảnh kiểm chứng: `outputs/printerval-pos-crawl-20261014/printerval-ai-interleaved.png`.

Ổ D hết dung lượng khi bắt đầu chỉnh sửa; đã chuyển cache build có thể tái tạo sang `C:/Users/ADMIN/AppData/Local/Temp/printerval-cache-20261014-interleaved` và tạo junction tại `.next/cache`. Không xóa source hoặc dữ liệu người dùng.
