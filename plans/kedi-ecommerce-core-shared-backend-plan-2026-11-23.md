# Đánh giá và kế hoạch backend dùng chung cho KediMuse Halifruit và các store mới

Ngày đánh giá: 23/11/2026, múi giờ Asia/Bangkok.

Kế hoạch thực hiện cập nhật theo yêu cầu một backend nhiều storefront và tiến trình payment-change mới: [Kế hoạch refactor Fufuni](./fufuni-multi-storefront-refactor-plan-2026-11-23.md). Dùng bản cập nhật này để chốt baseline và phân chia phạm vi; các SHA và trạng thái trong bản đánh giá dưới đây là snapshot trước cập nhật đó.

Kedi-ecommerce-core đã có nền tảng multi-store đáng tái sử dụng, nhưng cấu hình và phát hành hiện tại chưa đủ để coi Halifruit và KediMuse là hai store của một backend vận hành thống nhất. Đề xuất giữ Workers và MerchantDO SQLite, hoàn thiện cách ly tenant, chuẩn hóa cấu hình và migration, rồi đưa hai frontend vào cùng dịch vụ. Chưa cần viết lại hệ thống hoặc tách toàn bộ thành microservices.

## Phạm vi và bằng chứng

- Lịch sử [Đánh giá kế hoạch KediMuse](codex://threads/01a1ef49-8530-7a62-8cea-728b82b47996), gồm bàn giao checkout ngày 23/11, và [Đánh giá tiến độ KediMuse](codex://threads/01a20134-6acb-74d2-a1d2-b3204badf806), gồm cập nhật marketing ngày 22/11.
- Checkout Fufuni tại `D:/monorepo-project-workspace/fufuni`: HEAD `6b30281`, có nhiều thay đổi marketing chưa commit. Không dùng checkout này làm đại diện duy nhất cho production.
- Bản backend phát hành được đối chiếu tại `D:/monorepo-project-workspace/liora-monorepo/tmp/kedimuse-implementation/checkout-fulfillment-be`: HEAD `dfa1fdd`, remote `phuongnguyen240805/Kedi-ecommerce-core`, working tree sạch trước kiểm tra.
- FE KediMuse phát hành tại thư mục anh em `checkout-fulfillment-fe`; FE Halifruit tại `D:/workspace/halifruit-fe-v1`. Thư mục `D:/workspace/kedimuse/kedimuse` chưa đại diện đầy đủ cho FE phát hành mới.
- Báo cáo nghiệm thu: `D:/monorepo-project-workspace/liora-monorepo/tmp/kedimuse-implementation/checkout-fulfillment-acceptance-2026-11-23.md`; báo cáo cutover: `plans/kedimuse-unified-backend-release-2026-11-21.md`.
- Đánh giá code/config và lịch sử bàn giao; công cụ web không truy cập được các endpoint workers.dev trong lần kiểm tra này. Không xác nhận lại cấu hình bí mật hoặc trạng thái tài khoản Cloudflare hiện hành.

## Hiện trạng vận hành

| Phần | Bằng chứng hiện có | Ý nghĩa |
| --- | --- | --- |
| Halifruit FE | `src/lib/fufuni/server-client.ts` mặc định tới `halifruit-backend...workers.dev` | Vẫn có backend riêng trong cấu hình source |
| KediMuse FE phát hành | `wrangler.toml` và `server-client.ts` tới `merchant...workers.dev`, không có tiền tố store | Dùng database mặc định của Worker merchant |
| Dữ liệu KediMuse | Đã chuyển từ tenant `printerval` của backend cũ sang merchant theo báo cáo 21/11 | Không còn là cùng database với tenant nguồn |
| Multi-store | `resolveStore`, `storeEnvironment`, `merchantObjectName`, KV/R2 prefix, kiểm tra claims | Nền tảng dùng chung đã tồn tại |
| Checkout mới nhất | Báo cáo 23/11: COD vào POS, QR pending, Stripe test end-to-end; 212 BE, 326 FE, 18 browser tests được báo cáo đạt | Nghiệm thu bán hàng của một store, chưa phải nghiệm thu đa store |
| Marketing | Có subscriber, consent, queue, webhook, automation; chat 22/11 mới bổ sung cấu hình và PR | Chưa có bằng chứng gửi thật và vận hành đa store |
| Feed | Có OpenAI JSONL, Google XML, diagnostics và preview | Chưa chứng minh merchant onboarding hoặc feed được duyệt |
| POD và vận chuyển | Printify đọc, GHN báo giá; GHN dispatch thật chưa nghiệm thu theo lựa chọn của người dùng | Không tính là fulfillment production hoàn chỉnh |

## Những điểm đang làm đúng

- Mỗi store có MerchantDO riêng; SQL sản phẩm, cart, order, customer và job được tách theo database.
- Route `/stores/{id}` từ chối store lạ và `X-Store-Id` mâu thuẫn. API key được kiểm tra trong database đã chọn; cache không thay thế kiểm tra quyền.
- Store không mặc định được xóa các setting/secret đã phân loại trước khi ghép cấu hình riêng. Auth0 cho store không mặc định cần membership claim.
- KV được thêm prefix; IMAGES và DIGITAL_ASSETS_BUCKET của store không mặc định được bọc prefix. Evidence route hiện cũng tự thêm store ID vào object key và kiểm tra record qua database; dùng chung bucket không tự chứng minh rò rỉ dữ liệu.
- Payment và fulfillment đã có giữ tồn, evidence, chống trùng, trạng thái kết quả không rõ và kiểm soát gọi provider. Cần mở rộng các tính chất này qua nhiều store.
- Bản `dfa1fdd` đã đưa QR, pause, COD và các cờ export vào danh sách setting riêng. Không coi thiếu các cờ ở checkout Fufuni cũ là lỗi còn tồn tại trong bản phát hành này.

## Khoảng trống cần xử lý

| Ưu tiên | Phát hiện | Tác động và việc cần làm |
| --- | --- | --- |
| P0 trước cutover | Hai Worker, hai database mặc định; `default_store` hiện quyết định DO name | Không đổi root URL/default_store hoặc Worker name như thao tác đổi thương hiệu. Lập mapping dữ liệu và migration rõ ràng |
| P0 trước mở nhiều store | Khi không có STORES_JSON, code dùng `store_id=halifruit` dù STORE_NAME là KediMuse | Tên hiển thị không quyết định tenant. Chốt danh tính, alias và tương thích token trước đổi ID |
| P0 trước mở nhiều store | Workflow merchant và script append chưa cấp STORES_JSON/STORE_SECRETS_JSON trực tiếp từ cấu hình CI | Runtime hỗ trợ registry nhưng đường phát hành hiện chủ yếu cấp env phẳng. Thêm manifest, validation và smoke từng store |
| P1 | MAILGUN_DOMAIN, MAILGUN_BASE_URL, MAILGUN_USER không thuộc danh sách setting riêng và vẫn được sao chép từ env toàn cục | Fixture xác nhận store B còn domain/base/recipient của A. Store B thiếu API key riêng sẽ không gửi; nếu có key riêng, có thể dùng sai domain hoặc người nhận mặc định. Phân loại toàn bộ Env, mặc định từ chối kế thừa |
| P1 | `feeds.ts` diagnostics dùng `new URL('/v1/feeds/...', c.req.url)` sau khi router bỏ tiền tố | Store phụ nhận URL feed của root/default. Dùng hàm tạo URL theo StoreContext và kiểm tra mọi callback/discovery |
| P1 | `commerce-notifications.ts` cố định Halifruit, `checkout-fulfillment.ts` cố định KediMuse trong note | Giao dịch sai thương hiệu; chuyển sang cấu hình brand/store |
| P1 | `assertStoreClaims` bỏ qua membership đối với default để tương thích legacy | Có ngoại lệ quyền cần giới hạn theo issuer/audience và alias cũ, rồi loại bỏ theo lộ trình |
| P1 | Cron duyệt từng store tuần tự, nhiều loại job nằm chung try/catch | Store trước chạy chậm làm trễ store sau; lỗi marketing có thể bỏ qua POS/shipping của cùng store trong chu kỳ. Chia phạm vi lỗi và ngân sách công việc |
| P1 khi dùng tài nguyên chung | Dedupe giao dịch ngân hàng và giữ tồn hiện nằm trong từng DO | Cần chủ sở hữu dùng chung nếu nhiều store dùng cùng tài khoản ngân hàng hoặc cùng tồn POS; không giả định unique trong một DB bảo vệ toàn hệ thống |

Các phát hiện về quyền là giới hạn thiết kế hoặc khoảng trống kiểm chứng; chưa có bằng chứng khai thác đọc chéo dữ liệu production.

## Kiến trúc đích

Giữ một codebase chuẩn `Kedi-ecommerce-core`, triển khai thành dịch vụ commerce dùng chung. Bên trong chia module platform, catalog, inventory, checkout, payment, order, fulfillment, marketing, feeds và các adapter. FE gọi qua BFF của chính storefront; API key quản trị ở server.

```text
Halifruit FE / BFF ─┐
KediMuse FE / BFF ──┼─ Commerce API → StoreContext → module nghiệp vụ → repository của store
Store mới / BFF ────┘                         │
                         MerchantDO SQLite của từng store
                                             │
                          outbox/inbox → tác vụ → provider adapter
```

StoreContext chỉ chứa danh tính store, storage identity đã ghim, cấu hình đã validate và capability đã cấp. Không chuyển nguyên registry cùng toàn bộ secrets của mọi store xuống module nghiệp vụ. Shared infrastructure bindings được khai báo rõ; storage adapter chịu trách nhiệm prefix, kể cả upload nhiều phần và pagination.

Registry cần tách `store_id`, `storage_object_name`, aliases và public API base. Storage identity bất biến sau provisioning. Thiết kế này cần triển khai trước khi sử dụng; code hiện tại chưa có trường mapping độc lập.

Mapping đề xuất để giảm di chuyển dữ liệu:

| Store nghiệp vụ | Đích storage đề xuất | Chuyển đổi |
| --- | --- | --- |
| KediMuse | Giữ DO `default` hiện có trong namespace Worker merchant | Ghim storage mapping; đổi logical ID sang kedimuse chỉ sau xử lý token/claims và legacy alias |
| Halifruit | DO `store:halifruit` trong cùng namespace merchant | Nhập từ DO default của Worker halifruit-backend theo snapshot/cutover có kiểm soát |
| Store mới | DO `store:{id}` | Provision qua manifest và bootstrap có audit |

Đây là mapping dự kiến. Phase 0 phải xác nhận namespace và quyền truy cập thực tế trước phê duyệt migration. Route cũ của KediMuse có thể tiếp tục làm alias tới đúng storage đã ghim; route mới luôn dùng `/stores/{id}`. Không cho một alias thay đổi tenant dựa trên header người dùng tự gửi.

Nguồn dữ liệu chuẩn: commerce core quản lý giá bán checkout, order/payment ledger và reservation. Pancake là nguồn stock/catalog theo chính sách ownership cấu hình riêng; provider giữ trạng thái thực thi của shipment/POD. FE chỉ gửi lựa chọn mua, server tính lại tổng. Snapshot order không thay đổi theo catalog mới.

Nếu hai store chia sẻ cùng kho/SKU, phải có Inventory Authority chung cho khóa `(provider_account, warehouse, sku)` hoặc phân bổ tồn độc lập có hạn mức. Đồng bộ cùng on_hand vào hai DO rồi giữ tồn riêng có thể bán vượt tổng tồn. Nếu dùng chung tài khoản nhận tiền, cần Payment Inbox chung theo `(provider, account, transaction_id)` với claim một order/store; webhook chỉ được định tuyến sau xác minh nguồn tin cậy. Tài khoản độc lập vẫn có ledger riêng.

Provider adapter cần hợp đồng capability, quote/create/lookup/cancel, account binding và webhook verification. Chọn một execution owner cho mỗi shipment: direct hoặc Pancake. Luồng hàng Việt Nam, POD quốc tế và digital chọn theo dòng hàng; cart hỗn hợp phải tách fulfillment group hoặc bị chặn rõ ở MVP. Không để nhánh GHN hiện có mặc nhiên áp dụng cho mọi carrier.

## Kế hoạch triển khai và kiểm thử

### Phase 0 Chốt nguồn phát hành và bản đồ dữ liệu

Đề xuất 1–2 ngày kỹ thuật. Đối chiếu SHA, PR và thay đổi marketing chưa commit; chọn checkout chuẩn từ bản phát hành mới nhất. Ghi inventory Worker, DO namespace/object, KV/R2, frontend, webhook, POS shop/kho, payment account và owner của từng thành phần. Mỗi file/nhánh tích hợp có người phụ trách, tránh hai bot sửa chung checkout.

Đầu ra: release manifest đã che secrets, danh sách module/contract, quyết định store ID và storage mapping, snapshot/export có checksum, kế hoạch phục hồi. Chưa đổi tuyến traffic.

Kiểm thử: chạy baseline bản chuẩn, đối chiếu public catalog, tổng order theo trạng thái và tiền tệ, reserved stock, external references, cron/webhook route. Diễn tập đọc lại snapshot ở môi trường cô lập. Gate: biết chính xác source nào và DB nào đang phục vụ từng FE.

### Phase 1 Hoàn thiện StoreContext và cấu hình

Đề xuất 2–4 ngày. Thêm storage mapping bất biến, registry có schema/version, phân loại toàn bộ biến thành platform/store/secret, loại kế thừa ngầm. Sửa mail setting, brand hardcode và URL builder dùng chung. Hợp nhất binding types với cấu hình Wrangler, giữ runtime target hiện hành rồi nâng compatibility date bằng đợt kiểm thử riêng.

Kiểm thử: ba store có cùng SKU, email và idempotency key nhưng dữ liệu khác; registry thiếu/sai, ID trùng, URL/header không khớp, secret thiếu, policy/flag sai kiểu phải fail closed. Kiểm tra KV/R2 isolation, public feed URLs, UCP discovery, return/cancel URL, marketing links và webhook URL. Snapshot xác nhận registry/secrets store khác không nằm trong StoreContext. Gate: không kế thừa tài khoản, thương hiệu hoặc capability của store khác.

### Phase 2 Chuẩn hóa quyền và hợp đồng API

Đề xuất 2–3 ngày. Chuẩn hóa API `/stores/{id}/v1`, context cho BFF, public/admin/customer/service scopes, RBAC theo store và audit cho tác vụ tài chính. Tách legacy default permission thành adapter tương thích có hạn; finance không dùng chung toàn bộ admin key. OpenAPI và SDK dùng cùng hợp đồng versioned.

Kiểm thử: JWT, API key, native session, cart/order/download token của A bị từ chối ở B, kể cả cache đã ấm; webhook ký đúng nhưng sai store/account bị từ chối. Kiểm tra callback replay, token hết hạn và rotation. Gate: ma trận quyền cho cả ba store và route alias đạt.

### Phase 3 Chuẩn hóa transaction và tài nguyên dùng chung

Đề xuất 3–5 ngày. Giữ một đường tính giá/discount/tax/shipping và state machine thanh toán, order, fulfillment riêng. Tách adapter Pancake, GHN, Stripe, QR evidence, Printify khỏi điều phối nghiệp vụ. Viết decision table cho physical VN, POD quốc tế và digital; xử lý cart hỗn hợp rõ ràng. Bổ sung Inventory Authority/Payment Inbox khi tài khoản hoặc tồn thực sự dùng chung.

Kiểm thử: hai checkout cạnh tranh SKU cuối, cancel/expiry trả đúng giữ tồn; COD confirmed vẫn unpaid, QR chưa evidence không paid/export, Stripe webhook lặp hoặc đảo thứ tự không tạo đơn/giữ tồn/export lần hai. Cùng giao dịch ngân hàng không settle hai store; cùng tồn vật lý không bán vượt tổng. Provider timeout sau khi đã tạo đơn/vận đơn chuyển lookup/manual review, không tạo lại mù quáng. Gate: invariants về tiền, tồn và chống trùng đạt trước chuyển traffic.

### Phase 4 Chuẩn hóa tác vụ và vận hành

Đề xuất 2–4 ngày. Tái sử dụng queue DB hiện có, thêm outbox cùng transaction nghiệp vụ và inbox webhook có dedupe. Tách lỗi theo loại job/store, giới hạn batch và thời gian, thêm attempt/lease/retry/dead-letter và công cụ replay có audit. Với tải pilot nhỏ có thể giữ cron; thêm Cloudflare Queues khi đo được nhu cầu throughput/latency, không tạo hai cơ chế cùng thực thi một job.

Mỗi event/job cần event_id, store_id, account_id, aggregate_id, schema_version và correlation_id. Structured logs che PII; dashboard theo store về backlog age, payment pending, webhook failure, POS mismatch, stock drift và mail suppression. Alert phân biệt lỗi một store với hỏng toàn dịch vụ.

Kiểm thử: crash giữa commit và publish, crash sau provider success trước ghi receipt, consumer nhận lại message, lease hết hạn, một store/provider lỗi kéo dài nhưng store khác tiếp tục. Kiểm tra marketing welcome/abandoned/post-purchase/win-back không gửi sai tenant; suppression và trạng thái mua được xét lại trước gửi. Gate: phục hồi được job mà không tạo hiệu ứng ngoài hệ thống lần hai.

### Phase 5 Chuẩn hóa CI và chuyển Halifruit

Đề xuất 3–5 ngày kỹ thuật cộng thời gian theo dõi. Thêm registry manifest vào CI, môi trường staging với storage/provider sandbox riêng, validation cho từng store và readiness có version/config fingerprint không lộ secret. Deploy code không tự bật payment, dispatch, marketing hoặc POD.

Diễn tập migration Halifruit: export/import có schema version, checksum và receipt; bảo toàn product/order/customer IDs hoặc mapping rõ ràng, inventory reservations, ledger, pending job và provider IDs. Không bootstrap/demo seed lên dữ liệu thật. Snapshot nhập thử không được phép chạy cron hay gọi provider.

Cutover production: tạm dừng ghi/checkout của store nguồn trong cửa sổ ngắn; drain hoặc fence cron/webhook, chốt delta, import và đối chiếu; chuyển FE/BFF, webhook và scheduler sang cùng đích, chỉ một writer/job owner hoạt động. Event đến trong cửa sổ phải được buffer hoặc có cơ chế provider retry đã kiểm chứng. Xử lý native sessions, token ký và store claim bằng tái cấp/đăng nhập lại hoặc adapter tương thích giới hạn; không vô tình cấp quyền chéo để giữ phiên cũ.

Kiểm thử: journey của cả hai store trên staging, dữ liệu cùng ID ở hai DB không lẫn; count/checksum, amount totals, stock holds và external references khớp. Smoke production từng store, theo dõi 48–72 giờ theo ngưỡng pilot đã thống nhất. Rollback sau khi đích có đơn mới phải dừng ghi và reconcile delta trở lại hoặc sửa tiến; không đổi URL về DB cũ để mất đơn mới. Gate: rollback drill và cutover checklist đều đạt.

### Phase 6 Nghiệm thu store thứ ba và bàn giao

Đề xuất 1–2 ngày. Thêm store fixture/staging bằng manifest, credentials và bootstrap; không sửa route nghiệp vụ để thêm store. Có thể dùng profile digital hoặc physical độc lập để tránh lệ thuộc POD chưa nghiệm thu.

Kiểm thử: provision/re-run idempotent, currency/region/tax rõ, catalog → cart → checkout → payment sandbox → order → fulfillment fixture; kiểm tra Admin, feed, cache, marketing consent và quota. Load test mô phỏng store A nóng trong khi B/C vẫn đạt ngân sách phản hồi đã chốt; chỉ tách DO theo domain hoặc tách deployment khi số đo cho thấy một DO/store là nút thắt.

Gate hoàn thành: store thứ ba hoạt động bằng cấu hình, cả ba tenant vượt ma trận cách ly, có runbook thêm/tắt store, rotate secrets, phục hồi dữ liệu và xử lý provider timeout.

## Tiêu chí nghiệm thu toàn bộ

- Hai FE dùng cùng dịch vụ và đúng storage mapping; toàn bộ catalog/cart/checkout/payment/marketing của mỗi FE dùng một StoreContext nhất quán.
- Không đọc/ghi chéo dữ liệu hoặc dùng nhầm account/brand qua API, token, cache, R2, webhook, feed và background job.
- Payment, inventory và fulfillment invariants đạt khi gửi lặp, cạnh tranh và provider lỗi; tài nguyên thực sự dùng chung có một authority chịu trách nhiệm.
- Registry và secrets đi qua CI có validation, staging tách biệt, release có thể truy vết về SHA/config fingerprint.
- Migration và rollback đã diễn tập; không mất ledger/reservation, không chạy song song hai writer trên cùng đơn.
- Store thứ ba được onboarding bằng cấu hình; tài liệu vận hành và cảnh báo có thể dùng bởi người khác.
- Google/OpenAI approval, gửi Mailgun thật, Stripe live, QR nhận tiền thật, GHN dispatch thật và POD production được nghiệm thu riêng theo store, không dùng số test xanh để thay thế.

Ước lượng ban đầu: 14–25 ngày kỹ thuật cho một kỹ sư quen codebase, cộng theo dõi cutover và chờ provider; cần hiệu chỉnh sau Phase 0. Chỉ chạy song song các phần có ranh giới file/contract và người phụ trách rõ ràng.

## Kiểm tra thực hiện trong lần đánh giá

- Bản `dfa1fdd`: `node --import tsx --test apps/merchant/tests/stores.test.ts` đạt 14/14. Dùng RTK cho output kiểm thử.
- Fixture chỉ dùng giá trị giả xác nhận kế thừa MAILGUN_DOMAIN/BASE_URL/USER sang store khác, fallback store_id halifruit khi không có registry, và phép tạo URL diagnostics làm mất prefix.
- Bài `stores.runtime.test.ts` bằng Worker/SQLite local không trả kết quả sau nhiều lần chờ; đã dừng tiến trình bằng Ctrl+C. Chưa xác nhận pass/fail của bài runtime trong lần đánh giá này; phải chạy lại trước triển khai.
- Không sửa mã ứng dụng, thay cấu hình production, gửi email, thu tiền hoặc tạo vận đơn trong lần đánh giá này.

## Tham chiếu nền tảng

Cloudflare Queues có delivery ít nhất một lần, nên consumer và side effect vẫn phải chống xử lý trùng: [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/). Queue không tự bảo đảm chỉ tạo một đơn provider.

Namespace/class của Durable Objects có lifecycle riêng; cần bảo toàn identity và dùng quy trình được hỗ trợ khi thay đổi, thay vì xem đổi tên Worker/class như đổi tên hiển thị: [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/). Triển khai phải kiểm tra schema của Wrangler 4.120.1 đang pin trước khi dùng cấu hình mới từ tài liệu.
