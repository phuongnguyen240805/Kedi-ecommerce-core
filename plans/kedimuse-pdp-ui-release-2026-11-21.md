# Đồng bộ PDP UI mới lên production — 2026-11-21

## Nguyên nhân

Repo dùng deploy kedimuse-fe có code checkout/canonical availability mới nhưng CSS PDP cũ. Checkout local khác D:/workspace/kedimuse/kedimuse có ProductDetail.module.css, PdpSelect và kedimuse-brand-system.css mới chưa được ghép sang repo phát hành. Vì vậy hình ảnh báo lỗi là regression giao diện có thật; không phải lý do bắt người dùng xóa cache.

## Đã sửa

Frontend commit `32cf0c7` ghép UI PDP và import brand-system, thêm marker Add/Buy và purchaseActions, control dropdown và quantity +/- từ UI nguồn. Giữ nguyên livePurchaseState/canonical availability mới, cart ownership, giá/tồn, Stripe/QR và gate POD. Không sao chép code/keys/env Halifruit cũ từ checkout UI.

Worker printerval deployed version `16d93e0b-e55d-4b66-96ec-6e5c94866f36`. Backend không thay đổi trong bản UI này, vẫn sử dụng merchant với canonical availability đã deploy.

## Kiểm thử

- 315/315 unit/regression tests, boundary/typecheck/lint, production OpenNext build đạt.
- 16/16 browser commerce regression đạt: cart bridge, quote, payment choice/confirmation/pending, QR, handoff, recovery và stock gate.
- Kiểm tra Chrome production: Add to Cart computed background rgb(255,102,0), radius10px, height52px, font Inter; Buy Now nền trắng, viền cam; khoảng cách hai nút12px.
- Dropdown mở/chọn option và nút tăng quantity hoạt động; canonical stock0 vẫn chặn mua.
- CSS request không lỗi, mobile390px không overflow.
- Đã chụp và xem lại screenshot desktop/mobile từ production. Evidence local: tmp/kedimuse-implementation/pdp-ui-production-desktop.png và pdp-ui-production-mobile.png trong workspace triển khai.

CI cho commit và link kết quả được bổ sung khi hoàn tất. Các mẫu thử hết tồn chưa đủ điều kiện bán; không thu tiền hoặc tạo fulfilment trong kiểm thử.

CI frontend [44892599829](https://github.com/phuongnguyen240805/kedimuse-fe/actions/runs/44892599829), commit 32cf0c7 đã completed/success; gồm modular checks, production build và commerce browser regression.
