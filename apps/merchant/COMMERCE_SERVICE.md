# Commerce service: vận hành và hợp đồng API

## Phạm vi

Luồng bổ sung cho đơn trong `commerce_orders`: yêu cầu hủy, đổi địa chỉ, hàng lỗi/đổi trả, nghĩa vụ hoàn tiền thủ công có chứng từ, xác minh email và hàng đợi vận hành. Không thay thế tích hợp Stripe hoặc tạo một lệnh ngân hàng/GHN giả.

Điểm vào quản trị: `/admin/commerce-service` trong client Fufuni. Storefront Halifruit dùng BFF/tRPC, không đưa admin key xuống trình duyệt. Màu/layout và việc ẩn tài khoản của storefront được giữ nguyên.

## Bật tính năng theo store

Các biến phải cấu hình trước pilot (không đưa secret vào Git):

| Cấu hình | Ý nghĩa |
|---|---|
| `COMMERCE_SERVICE_ENABLED=true` | Nhận yêu cầu mới, xác minh, khôi phục link, báo giá và upload chứng cứ |
| `ORDER_TOKEN_SECRET` | Secret ký token tra cứu hiện có, tối thiểu 32 ký tự |
| `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` | Gửi mã xác minh, khôi phục link và thông báo; cần kiểm chứng domain/delivery thực tế |
| `STORE_URL=https://...` | URL storefront đúng store để khôi phục link qua email |
| `COMMERCE_SERVICE_FINANCE_SUBJECTS` | Danh sách subject kế toán, phân tách bằng dấu phẩy; ít nhất hai danh tính cho tạo và xác nhận hoàn tiền |
| Auth0 `admin:store` và `commerce:finance` | Cách cấp quyền kế toán qua JWT thay cho allowlist subject |
| `COMMERCE_EVIDENCE_BUCKET` | R2 binding riêng tư, không công khai ảnh; phải được khai báo/provision theo môi trường |
| `COMMERCE_EXPIRE_UNPAID_ENABLED=true` | Tùy chọn tự hủy đơn hết hạn giữ hàng khi chưa thu tiền/chưa gửi POS; mặc định không tự bật |

API keys có audit subject `api-key:<id trong api_keys>`, không phải giá trị secret. Không cấp quyền finance cho key storefront/BFF hoặc dùng chung một danh tính để tạo và xác nhận hoàn tiền. Khi service được bật, API chứng từ bank/COD và resolve-bank cũ cũng kiểm tra quyền finance. Sau khi rollout, giữ cấu hình finance khi tạm dừng nhận yêu cầu mới.

Các setting mới được cách ly qua store registry. Không bật toàn cục cho store khác ngoài ý định. Cần cấu hình retention/lifecycle của bucket và quy định lưu chứng cứ trước khi nhận ảnh khách; code chưa tự provision bucket hay chính sách pháp lý lưu trữ.

## API

Prefix `/v1/commerce-service`. Các route vẫn cần store authentication hiện có.

| Method / path | Quyền | Payload chính |
|---|---|---|
| POST `/detail` | Token tra cứu | `order_id`, `token` |
| POST `/recover` | Storefront | `number`, `email`; phản hồi công khai giống nhau |
| POST `/verification/start` | Token tra cứu | Gửi mã tới email gốc của đơn, không cho chọn email khác |
| POST `/verification/confirm` | Token + mã | `session_id`, `code`; nhận action token 15 phút |
| POST `/requests` | Token + action token | `request`: kind, reason, order_version, idempotency_key; quote_id hoặc items/evidence_ids theo loại |
| POST `/address-quotes` | Đã xác minh | Recipient mới + order_version; báo giá từ snapshot kiện hàng đã đặt |
| POST `/evidence` | Đã xác minh | Ảnh JPG/PNG/WebP base64, tối đa khoảng 500 KB/ảnh |
| GET `/admin/queue` | Admin | Yêu cầu, hoàn tiền đang mở, notification failures |
| GET `/admin/orders/{orderId}` | Admin | Detail + receipt + audit nội bộ + chứng từ tiền |
| POST `/admin/orders/{orderId}/decision` | Admin | request_id, version, approve/reject/complete, chứng cứ nội bộ, message cho khách |
| POST `/admin/orders/{orderId}/refunds` | Finance | Lập nghĩa vụ hoàn tiền; chưa chuyển tiền |
| POST `/admin/orders/{orderId}/refund-result` | Finance | processing/unknown/failed/succeeded, mã giao dịch/chứng cứ |
| POST `/admin/orders/{orderId}/adjustment-payment` | Finance | Ghi nhận tiền bổ sung cho yêu cầu đổi địa chỉ đã duyệt |
| POST `/admin/orders/{orderId}/reconcile` | Finance | Đối soát sổ thu/hoàn và tồn giữ trước xác nhận đã trả tiền |
| POST `/admin/orders/{orderId}/evidence` | Admin | Lấy ảnh riêng tư theo evidence_id thuộc chính đơn |

OpenAPI được đăng ký trực tiếp bằng Zod trong `routes/commerce-service.ts`. Runtime test xuất hợp đồng local tại `outputs/commerce-qa/phase1-openapi.json` (gồm endpoint mới); đây là artifact QA, không phải chứng minh production có cùng phiên bản.

## Bất biến và xử lý lỗi

- Tạo/duyệt yêu cầu, tiền và kho chạy trong DO transactionSync, không gọi provider trong transaction.
- `order_version` tăng khi đơn/commerce state thay đổi; lệnh cũ trả 409. Retry tạo yêu cầu/hoàn tiền giữ cùng idempotency key, nội dung đổi bị từ chối.
- OTP: hiệu lực 10 phút, tối đa 5 lần thử, tối đa 6 lần gửi/giờ và cách tối thiểu 60 giây. Số lần thử sai được commit. Mã chỉ lưu HMAC; action token chỉ lưu hash. FE giữ action token trong memory.
- Mỗi order tối đa 50 yêu cầu; giới hạn ảnh và tốc độ báo giá/upload. Không dùng order UUID/số điện thoại đơn thuần để thay đổi đơn.
- Yêu cầu cancel/address đang mở chặn tạo/dispatch mới. Đọc diễn biến vận chuyển vẫn tiếp tục. Nếu đã có lease thao tác ngoài, khách cần đợi rồi gửi lại.
- Hủy sau nhận tiền tạo nghĩa vụ hoàn tiền từ số dư thực nhận còn khả dụng. Hàng đã tiêu thụ không tự tăng lại tồn bán được.
- Tổng lệnh hoàn pending/processing/unknown/succeeded và chứng từ hoàn legacy không vượt tiền nhận. Unknown vẫn giữ hạn mức. Succeeded cần mã tham chiếu duy nhất và người khác người tạo xác nhận.
- Tiền sau hủy không tự kích hoạt giao hàng; có thể lập hoàn và đối soát đến `refunded` mà đơn vẫn `canceled`.
- API PATCH đơn cũ bị chặn với commerce; Stripe refund cũ không xử lý đơn commerce. Resolve-bank legacy bị chặn khi đã có ledger mới.
- Public detail không trả chứng cứ nội bộ, actor kế toán hay token. Phản hồi cho khách tách khỏi evidence nội bộ.

## Đổi địa chỉ và chênh lệch

Khách chấp nhận quote trong 5 phút. Chưa cập nhật địa chỉ khi gửi yêu cầu. Shop duyệt và chọn:

1. Áp dụng phí đã báo: COD cập nhật tổng mới; prepaid cần thu/hoàn chính xác phần chênh lệch và không còn lệnh hoàn chưa rõ trước khi commit.
2. Shop chịu chênh lệch: giữ tổng khách; cần xác minh chi phí/COD bên vận chuyển và ghi audit.

Đơn đã gửi POS hoặc đang giao cần xác nhận ngoài (`external_cleared`) kèm chứng cứ. Báo giá hết hạn cần shop kiểm tra lại phương án/chi phí hiện hành; nếu không đáp ứng được, không xác nhận hoàn tất. Đơn đã giao/hoàn về không sửa địa chỉ lịch sử. Mọi đổi địa chỉ lưu trước/sau và chi phí.

Không có adapter tự hủy/sửa GHN/Pancake mới trong thay đổi này: operator thực hiện trên hệ thống sở hữu vận đơn, xác minh rồi mới xác nhận kết quả ở Fufuni. Checkbox không tự gọi provider. Tương tự, hoàn tiền COD/Techcombank là quy trình kế toán có chứng từ, không phải API chuyển tiền ngân hàng.

## Hàng lỗi và chất lượng

RMA theo SKU và số lượng snapshot; tổng số lượng yêu cầu chưa bị từ chối không vượt hàng mua. Hoàn tất cần phương án rõ: hoàn tiền liên kết ledger, giao bù có mã tham chiếu, kiểm tra hàng thu hồi có mã lô và disposition, hoặc tư vấn/thỏa thuận không thu hồi. Event inspection không tự cộng tồn; điều chỉnh tồn và cách ly thực tế qua quy trình kho/POS.

Đây là truy vết xử lý hàng lỗi theo đơn/lô, chưa phải hệ thống WMS kiểm định lô toàn diện hay bộ lập đơn giao bù tự động. Không đánh dấu kiểm định/chứng nhận cho khách nếu chưa có chứng cứ.

## Thông báo và tạm dừng

Audit nghiệp vụ tạo notification job trong cùng transaction. Cron nhận tối đa 10 job/lượt, lease 5 phút, retry sau 15 phút, tối đa 8 lần. Email lỗi không rollback đơn/tiền. Delivery có thể lặp nếu provider nhận thư nhưng phản hồi bị mất; thư chỉ hướng dẫn xem trạng thái hiện tại, không tác động tiền.

Tắt `COMMERCE_SERVICE_ENABLED` dừng yêu cầu mới nhưng giữ đọc detail, admin xử lý và cron thông báo cho nghĩa vụ đang mở. Không xóa ledger/audit để rollback. Cần theo dõi `notification_failures` trong queue, tuổi yêu cầu, POS chưa rõ và chênh lệch tiền; người vận hành phải được phân công trước pilot.

## Kiểm thử và phát hành

```powershell
# Từ apps/merchant
npm run typecheck
npm run typecheck:commerce
npm run test:commerce
npm run test:stores
# Từ apps/client
npm run type-check
npm run test:commerce:ui
```

Windows có thể cần chạy Worker runtime ngoài sandbox để spawn workerd. Đặt WRANGLER_LOG_PATH/TEMP/TMP vào thư mục workspace có quyền ghi; không sửa logic ứng dụng để vượt lỗi quyền test.

Trước production: chốt chính sách shop, xác minh hai danh tính kế toán, thử delivery Mailgun tới hộp thư QA được phép, bind bucket riêng tư/retention, staging với provider sandbox, diễn tập lỗi ngoài và phục hồi dữ liệu, rồi pilot giới hạn. Chưa thực hiện chuyển tiền thật, gửi email thật, hủy vận đơn thật hay deploy trong công việc local này.
