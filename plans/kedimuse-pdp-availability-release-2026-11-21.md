# PDP availability — phát hành 2026-11-21

## Đã sửa và deploy Cloudflare

Backend `5a9af8e` bổ sung API checkout availability theo SKU, đọc canonical inventory và checkoutReadiness thay vì đòi hỏi bản ghi warehouse_inventory. FE `53d991c` dùng API này cho cả SSR PDP và getProduct; ghép id/SKU, kiểm tra schema, loại metadata tồn cũ khi upstream lỗi, xử lý theo batch 24 SKU. Không cần quét toàn bộ catalog mỗi lượt xem PDP.

Worker merchant đã deploy qua workflow [44891465830](https://github.com/phuongnguyen240805/Kedi-ecommerce-core/actions/runs/44891465830), completed/success. Worker printerval đã deploy version `7456c842-4a99-4692-b099-c228afd21ae0`.

Trạng thái nút mua và thông báo dùng cùng rule: unknown, hết tồn, vượt quantity, thiếu delivery/tax/price, POD cần quote/artwork, thiếu option là các lý do khác nhau. Không còn dùng Choose a size cho trường hợp không xác minh được tồn. Quote/payment tiếp tục kiểm tra giá và tồn tại backend.

## Kiểm thử

- Backend typecheck và 196/196 tests đạt: canonical stock không cần warehouse row, zero stock, SKU filter SQL parameterized, auth 401/403, input 400, tối đa 24 SKU, private/no-store và không trả integration secrets.
- FE boundary, modular typecheck, lint, 315/315 tests trong 69 suites và production OpenNext build đạt; test stale metadata/response thiếu hoặc sai/mất kết nối, positive stock, hết tồn, delivery blocker, >24 variants và thông báo UI.
- 16/16 browser commerce regression đạt; 2/2 manifest regression đạt. Fixture xác nhận cart nhiều SKU, quote, Stripe/QR choice và pending status; không tạo giao dịch provider thật.
- Live API mới trả 200 cho SKU `P2779220364-M-BLA-MEN-12572Q06`, available=0, reasons stock_unavailable/delivery_configuration_missing.
- Live PDP áo Custom Monster Truck: HTTP200; SSR có metadata availability rõ ràng; không còn câu Availability has not been verified hoặc Choose a size before ordering. Hiện đúng This option is currently out of stock và Add to cart/Buy now bị disabled. Chrome không uncaught JS error và không tràn mobile 390px.
- Link PDP: https://printerval.gofiber-phuongnguyen.workers.dev/product/custom-monster-truck-birthday-shirt-shark-theme-party-matching-family-shirts-c5e5e767-6662-5dbb-b7b2-61a4eff2ec72

## Giới hạn và vận hành

Không bật tồn giả để làm nút mua sáng. Các SKU mẫu/POD chưa có stock thực và cấu hình delivery/tax vẫn không thể bán. SKU thực đủ stock/cấu hình được phép tiếp tục qua cart và checkout chuẩn; cần nghiệm thu Stripe test hosted-payment/webhook thật sau khi có SKU và chính sách được duyệt. Không charge tiền, không chuyển khoản, không sản xuất/giao vận. Không thay đổi registry tenant, bank, Pancake, POD/MCP/R2 hoặc khóa ký đang dùng.

Chi tiết FE: plans/pdp-availability-fix-2026-11-21.md trong kedimuse-fe. CI frontend được ghi bổ sung khi hoàn tất.

CI frontend [44891667771](https://github.com/phuongnguyen240805/kedimuse-fe/actions/runs/44891667771), commit 53d991c: completed/success, gồm full modular checks, production build và commerce browser regression.
