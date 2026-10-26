# Halifruit: COD và QR Techcombank — bàn giao giai đoạn 1

Ngày: 14/10/2026. **Cập nhật production:** đã deploy backend COD/QR và frontend `/checkout`; kiểm tra trình duyệt production tạo đơn COD và QR với quote GHN thật, sau đó hủy đơn thử để trả tồn. QR chưa có giao dịch ngân hàng thật; POS tự động và payment mapping vẫn tắt chờ nghiệm thu. Báo cáo cập nhật: `C:/Users/ADMIN/.codex/worktrees/halifruit-cart-hotfix/qa/CHECKOUT_PRODUCTION_REPORT.md`. Các ghi chú chưa deploy bên dưới là trạng thái trước bản sửa checkout này.

## Quyết định và phạm vi

- Fufuni giữ đơn, tiền, báo giá, bằng chứng giao dịch và outbox. FE gọi qua tRPC server; không có key POS/ngân hàng trong trình duyệt.
- Chỉ COD và `techcombank_qr` được chấp nhận. Không bật ZaloPay, cọc, Stripe hay Telegram Stars trong checkout mới.
- Techcombank **50398838675 — Nguyễn Xuân Phương**, do chủ shop cung cấp trong chat. Tên dùng trong QR: `NGUYEN XUAN PHUONG`. Chưa xác minh chủ tài khoản với ngân hàng.
- QR dùng Quick Link của VietQR. QR hướng dẫn chuyển khoản; **không xác nhận tiền**. Không có tích hợp API Techcombank/SePay/Casso được cung cấp, nên xác nhận tiền ở giai đoạn này dựa trên sao kê do nhân viên được cấp quyền đối chiếu.
- Pancake sở hữu dispatch. Code không tạo vận đơn, không tự giao hãng, không suy diễn mã địa giới GHN thành mã địa giới Pancake.
- Giữ cấu trúc Worker/DO hiện có, Halifruit dùng DO `default`. Không chuyển DB hoặc thay đổi các store đang được sửa trong workspace.

## Code đã làm

| Nhóm | Kết quả |
|---|---|
| Checkout | Trong `transactionSync`: kiểm giá hiện tại, tồn tại kho POS, độ mới tồn kho 2 giờ, mapping SKU, địa chỉ đã lưu, phương thức, môi trường, policy và TTL; tạo order/items/snapshot/payment metadata/reservation/outbox đồng thời |
| Chống trùng | Một cart → một order; idempotency key unique, retry cùng payload trả đúng đơn; payload khác bị từ chối |
| Tiền | VND đồng nguyên, không nhân/chia 100. Thuế dùng cùng cách tính cho quote và checkout; COD bao gồm tiền hàng, thuế ngoài giá và phí khách trả |
| COD | `unpaid/to_collect` khi đặt; `collected` và `reconciled` cần chứng từ riêng; `delivered` không tự đổi trạng thái tiền |
| QR | Snapshot tài khoản, số tiền, reference unique, hạn 24 giờ. `pending` tới khi đối chiếu sao kê; thiếu/thừa/sai nội dung/đến muộn → `needs_attention` |
| Đối soát | Transaction unique, audit actor/chứng cứ/thời gian. Exception chỉ đóng khi toàn bộ khoản nhận trừ tiền đã hoàn bằng tổng đơn, có chứng từ hoàn khi cần |
| POS | Outbox bền vững, lease, tra exact `custom_id`, mapping SKU/product/giá/ship/thuế/transfer. Đối chiếu tổng và `money_to_collect` trước báo synced |
| POS timeout | Ghi `create_attempted` trước POST. Retry chỉ tra đơn; nếu vẫn chưa thấy thì giữ `needs_attention`, không tự POST thêm |
| Tồn kho | Giữ tồn trong cùng transaction. POS nhận đơn → tiêu thụ phần giữ ở local một lần; snapshot POS sau đó cập nhật lại. Hủy đơn chưa gửi POS/không có tiền → trả phần giữ một lần |
| FE | Form nhận hàng Việt Nam, COD/QR trước quote, khóa xác nhận theo TTL và tổng tiền, retry giữ payload/key trong sessionStorage |
| Tra cứu | HMAC capability riêng từng đơn/store, request token qua body, URL FE dùng fragment; trả trạng thái/tiền/SKU, không trả email/địa chỉ/số điện thoại khách. Hết hạn sau 90 ngày kể từ hạn payment |
| Bảo mật | Checkout BFF yêu cầu cookie cart được ký, HttpOnly/SameSite; xác nhận checkout và thao tác kế toán dùng admin API; body giới hạn 8 KB; bootstrap API không hoạt động nếu thiếu secret; lỗi nội bộ không trả raw SQL |
| CDN | Dùng CDN và allowlist sẵn có; chạy lại test cache/redirect/MIME/size. Không đổi cấu hình R2 hay public hóa ảnh chứng từ |

**Giới hạn có chủ ý:** voucher bị chặn trong checkout giai đoạn 1 cho tới khi có redemption atomic và quy tắc thuế sau giảm giá đã nghiệm thu. FruitMix/BOM chưa có order recipe backend, vì vậy không đánh dấu checklist đó hoàn tất. Hủy đơn đã tạo POS/đã thu tiền cần xử lý bên POS/ngân hàng trước; API cancel này chỉ dành cho đơn chưa gửi và chưa thu tiền.

## API

Prefix: `/v1/commerce`; store khác dùng prefix routing hiện có, không được kế thừa cấu hình bank của Halifruit.

| Method | Path | Quyền |
|---|---|---|
| GET | `/methods` | Public API key |
| POST | `/checkout/confirm` | Admin key phía BFF + cookie cart tại FE |
| POST | `/track` | Public key + `{order_id,token}` |
| GET | `/admin/exceptions` | Admin |
| POST | `/admin/orders/:id/bank_transfer` | Admin + chứng từ sao kê |
| POST | `/admin/orders/:id/cod_collected` | Admin + chứng từ thu hộ |
| POST | `/admin/orders/:id/cod_reconciled` | Admin + chứng từ đối soát |
| POST | `/admin/orders/:id/resolve-bank` | Admin + toàn bộ mã giao dịch/hoàn tiền |
| POST | `/admin/orders/:id/fulfillment` | Admin + trạng thái/chứng cứ/mã vận đơn |
| POST | `/admin/orders/:id/sync-pos` | Admin + feature flag |
| POST | `/admin/orders/:id/cancel` | Admin + lý do/chứng cứ |

Schemas và responses xuất trong OpenAPI khi Worker chạy. Không có webhook giả xác nhận thành công.

## Cấu hình và vận hành

`wrangler.halifruit.jsonc` đã có tài khoản bank, nhưng giữ `COMMERCE_CHECKOUT_ENABLED=false`, `PANCAKE_ORDER_SYNC_ENABLED=false`, `PANCAKE_PAYMENT_MAPPING_VERIFIED=false` trước nghiệm thu. Cần `ORDER_TOKEN_SECRET` ngẫu nhiên ≥32 ký tự, `SETUP_INIT_TOKEN`, POS/GHN secrets đã kiểm chứng và cấu hình shipping production. Tuyệt đối không dùng quote GHN staging để thu tiền production.

FE cần `FUFUNI_BACKEND_URL`, `FUFUNI_PUBLIC_KEY`, `FUFUNI_ADMIN_KEY` chỉ ở server. Cookie được cấp khi tạo cart mới. Cart cũ có từ trước rollout cần tạo lại để có bằng chứng sở hữu phiên; không tự nhận một UUID do client gửi làm quyền sở hữu.

Chạy công cụ ops từ `apps/merchant` với credentials trong env hoặc file env bị Git ignore:

```powershell
node --env-file=.env.ops scripts/commerce-ops.mjs exceptions
node --env-file=.env.ops scripts/commerce-ops.mjs bank ORDER_UUID bank-proof.json
node --env-file=.env.ops scripts/commerce-ops.mjs sync ORDER_UUID
node --env-file=.env.ops scripts/commerce-ops.mjs fulfillment ORDER_UUID ready-proof.json
node --env-file=.env.ops scripts/commerce-ops.mjs collected ORDER_UUID cod-proof.json
node --env-file=.env.ops scripts/commerce-ops.mjs reconciled ORDER_UUID settlement-proof.json
```

`.env.ops` dùng `FUFUNI_BACKEND_URL` và `FUFUNI_ADMIN_KEY`; không commit. Bằng chứng chứa dữ liệu khách phải để ngoài repo hoặc trong thư mục Git ignore, không public lên CDN.

Ví dụ chứng từ (giá trị mẫu, cần thay bằng giao dịch thật đã kiểm tra):

```json
{
  "transaction_id": "TCB-STATEMENT-TRANSACTION-ID",
  "amount_vnd": 220000,
  "currency": "VND",
  "reference": "HFREFERENCE_FROM_ORDER",
  "received_at": "2026-10-14T10:00:00+07:00",
  "evidence": "Mã sao kê lưu nội bộ; nhân viên đối chiếu tài khoản nhận, khoản ghi có và nội dung"
}
```

Đối soát COD dùng số tiền thu hộ **gross được phân bổ cho đơn**, kèm chứng từ có phí/net chuyển về shop. Không nhập net sau trừ phí làm gross. Báo cáo chênh lệch phí ship tự động chưa triển khai.

Fulfillment đi `unfulfilled → ready_to_ship → shipped → delivered`; shipped cần mã vận đơn. Hàng hoàn dùng `returned`, không tự hoàn tiền. Nhân viên cập nhật từ bằng chứng POS; **chưa có webhook/polling tracking tự động đã nghiệm thu**.

Outbox thử ngay bằng `waitUntil` sau COD/xác nhận bank; cron hiện có quét lại tối đa 10 đơn mỗi lần. API sync phục hồi ngay khi cần. **Chưa cấu hình Cloudflare Queue/DLQ**, chưa coi đây là đảm bảo retry quy mô lớn. Khi POS timeout sau tạo: tra exact reference tại POS và gọi sync lại; nếu chưa thấy, điều tra ngoài hệ thống. Không reset `create_attempted` bằng SQL để thử lại mù.

## Migration và rollback

- Chỉ thêm `commerce_orders`, `commerce_transactions`, `commerce_outbox`, `commerce_audit` vào SQLite của DO bằng DDL idempotent; không thay/xóa lịch sử đơn cũ, không reset database.
- `orders`/`order_items` hiện có được dùng với `pending` hoặc `paid`; fulfillment và COD nằm riêng để tránh dùng một state cho ba nghiệp vụ.
- Trước deploy: xác minh Worker version/source/DO name, lưu backup/PITR và chạy staging trên bản dữ liệu đã ẩn PII. Dry-run bundling không chứng minh deploy provenance hay backup restore.
- Rollback: tắt checkout/sync flags, giữ toàn bộ orders/receipts/outbox/audit; rollback code tương thích schema. Không drop bảng giao dịch.
- Tiền đến muộn sau hủy: ghi evidence thành `needs_attention`, không tự tái mở đơn/giữ hàng hoặc gửi POS.

## Checklist nghiệm thu còn mở

- [ ] Xác minh repo/commit thực của Worker production và DB/DO đang chạy (P0.01). Local config và dry-run chưa chứng minh provenance.
- [x] Kiểm tra API read-only: shop `715159313` và kho `9273036b-74c0-468c-9538-f3476f04b128` đều là **Hali Fruit**; API đọc đơn trả envelope `data/success`. Shop chưa có mẫu đơn trong lần đọc này.
- [ ] Kiểm tra quyền API ghi order/transfer và payload bằng shop test, gồm `custom_id`, `transfer_money`, `total_price`, `money_to_collect` và đơn bị xóa.
- [ ] Nghiệm thu COD + QR trên staging với dữ liệu POS thật được phép; kiểm tra POS không thu lại đơn prepaid.
- [ ] Đọc chính sách/VietQR Quick Link hiện hành, tài khoản/template production và quét QR trong app ngân hàng để kiểm tra người nhận/số tiền/nội dung.
- [ ] Kiểm chứng GHN pickup address, SLA nhận trái cây, cân/kích thước kiện, fee/tax và quote production.
- [ ] Chốt quyền nhân viên kế toán, nơi lưu sao kê/chứng từ và SLA xác nhận bank. Chưa có màn ops GUI; dùng API/CLI.
- [ ] Nghiệm thu POS giữ tồn đúng lúc xác nhận đơn, cập nhật snapshot stock sau đồng bộ, và retry khi POS có eventual consistency.
- [ ] Bổ sung polling/webhook tracking/COD phù hợp capability, Cloudflare Queue/DLQ và báo cáo shipping fee variance nếu yêu cầu tự động hóa vận hành đầy đủ.
- [ ] Migration backup/restore, full build/CI, pilot 5–10 đơn và go-live sign-off.
- [ ] Rà lại header/footer và branding mẫu Lacoste/Printerval còn trong layout hiện có trước khi mở bán Halifruit.
- [ ] Rà soát/rotate secret đã xuất hiện trong file mẫu môi trường trước đó; mẫu đã được thay bằng placeholder, nhưng thay mẫu không thu hồi key cũ.

Giai đoạn 2 giữ tắt tới khi giai đoạn 1 được nghiệm thu: ZaloPay có MAC thật, đặt cọc/partial COD, sau đó Stripe hoặc Telegram Stars khi phù hợp loại hàng/kênh bán.

## Bằng chứng kiểm tra

- Backend: **61 test pass** gồm payment/SQLite, Worker runtime, shipping, POS catalog, CDN, store isolation; frontend: **2 test pass** cookie/contract. UI fixture: checkout → tracking chạy trên desktop/mobile, đúng một confirmation request, không có page error hay tràn ngang mobile.
- `npm run typecheck:commerce` pass; frontend các file thay đổi không có lỗi type. Full typecheck vẫn có lỗi sẵn có ngoài phạm vi checkout; chưa chứng nhận full build production.
- Wrangler dry-run của cấu hình Halifruit pass, không deploy. Checkout/POS payment flags vẫn tắt trong cấu hình bàn giao.
- Đọc Cloudflare deployments: version `a0a446c5-0bf1-4d80-9532-c4f499e5e7f9` đang nhận 100% traffic, deployment tạo lúc **16:45:17 ngày 14/10/2026 (UTC+7)**. Không có commit tag để xác minh repo/commit production.
- Artifacts tại `outputs/commerce-qa`: `phase1-openapi.json`, `backend-provenance.json`, `pancake-readonly-verification.json`, `checkout-desktop.png`, `tracking-mobile.png`. UI và QR trong screenshot dùng fixture, không chứng minh giao dịch ngân hàng thật.

Đối chiếu checklist gốc: P3.02–08, P3.10–12 và P3.15 có code/test giai đoạn 1; P4.04–09 có khóa quote/checkout; P5.02–03 và P5.05–06 có snapshot/outbox/lease/timeout-safe retry. P3.09/P3.13–14 (PSP/refund/reconcile tự động), P5.04 (Queue/DLQ), P6.01–03 (event/polling), P6.06/P6.09 (báo cáo đối soát đầy đủ) và P7 go-live còn mở. P6.04–05/07–08/10 có tra cứu riêng và API ops; dashboard GUI chưa triển khai. Không đánh dấu toàn checklist hoàn tất chỉ vì test local xanh.

## Nguồn

- [Kế hoạch gốc](C:/Users/ADMIN/Downloads/HALIFRUIT_FUFUNI_PANCAKE_PAYMENT_ARCHITECTURE_PLAN.md): tài liệu định hướng; các cam kết production phải kiểm chứng riêng.
- [Cloudflare SQLite storage / transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
- [VietQR Quick Link](https://www.vietqr.io/intro/): cú pháp URL và hướng dẫn cấu hình template.
- Pancake: dùng OpenAPI snapshot có sẵn tại `.wrangler/pancake-openapi.json`; chưa coi snapshot local là bằng chứng shop thật hỗ trợ đầy đủ quyền ghi tiền.
