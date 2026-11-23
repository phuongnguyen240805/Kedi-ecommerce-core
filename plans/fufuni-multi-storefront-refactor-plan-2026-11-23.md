# Kế hoạch refactor Fufuni thành backend chung cho nhiều storefront

Ngày lập: 23/11/2026, Asia/Bangkok. Trạng thái: kế hoạch triển khai, chưa refactor hoặc chuyển traffic.

Mục tiêu đã chốt: một dịch vụ backend từ `Kedi-ecommerce-core` phục vụ Halifruit, KediMuse và các storefront mới. Mỗi store có dữ liệu, quyền, tài khoản tích hợp và chính sách riêng. Một store có thể có nhiều storefront cùng dùng catalog, tồn và order của store đó. Kế hoạch này thay thế định hướng triển khai mỗi store một Worker lâu dài; các Worker cũ chỉ giữ vai trò tương thích trong thời gian chuyển đổi.

## 1 Tiến trình làm cơ sở

| Luồng | Bằng chứng ngày 23/11 | Hệ quả với refactor |
| --- | --- | --- |
| [Chat checkout KediMuse](codex://threads/01a1ef49-8530-7a62-8cea-728b82b47996) | Đang active khi đọc; thêm đổi phương thức thanh toán, báo 216 BE và 327 FE tests đạt, đang build/browser. Checkout BE có HEAD `b9c1327`, trước đó `dfa1fdd` là bản nghiệm thu POS | Không đóng baseline ở `dfa1fdd` rồi bỏ mất payment change. Commit hiện có chưa đồng nghĩa đã deploy thành công |
| [Chat marketing KediMuse](codex://threads/01a20134-6acb-74d2-a1d2-b3204badf806) | Idle khi đọc; đã cập nhật PR và file cấu hình BE/FE; báo 5 kiểm tra config, 7 API FE đạt. Chưa bật gửi thật | Giữ nguyên consent, queue, recovery, settings và biến mới; xác nhận commit/PR thực tế trước tích hợp |
| Checkout Fufuni | HEAD `6b30281`, nhiều file marketing/DO/types/CI chưa commit | Không dùng `reset`, checkout đè, hoặc đóng gói toàn bộ working tree vào PR refactor |
| Halifruit | Có thay đổi chưa commit ở client Fufuni, checkout, order tracking, hậu mãi và CI. Báo cáo local 12/11 ghi chưa push/deploy trong đợt đó | Đây là luồng cần bảo toàn, không coi toàn bộ code local là production hoặc tự sửa đè |
| API Halifruit | `getFufuniConfig()` trả `url.origin`, loại phần `/stores/...` | Trước cutover phải sửa adapter giữ base path; chỉ đổi biến URL sẽ chưa đủ |

Checkout tham chiếu mới: `D:/monorepo-project-workspace/liora-monorepo/tmp/kedimuse-implementation/checkout-fulfillment-be`. FE checkout tại thư mục anh em `checkout-fulfillment-fe`; FE marketing làm tại `kedimuse-fe`. Phải reconcile hai nguồn FE bằng commit/PR, không sao chép thư mục đè nhau.

Thông tin chat là snapshot lúc lập kế hoạch. Các con số test của hai chat không cộng thành số test đã chạy trên bản tích hợp. Không có trao đổi khóa file hoặc thay đổi nhiệm vụ của các chat khác trong lần lập kế hoạch này.

## 2 Ranh giới tránh xung đột

| Khu vực | Quy tắc đến khi bàn giao |
| --- | --- |
| `lib/checkout-*`, `lib/ucp-payment*`, `routes/checkouts.ts`, tests checkout/Stripe | Chat checkout hoàn tất payment-change trước. Refactor chỉ viết hợp đồng/adapter mới; tích hợp vào file cũ trong một PR riêng sau bàn giao |
| `lib/marketing-*`, `lib/checkout-marketing.ts`, `routes/marketing.ts`, Admin marketing, migration 038 | Giữ quyền thực hiện ở luồng marketing hiện có. Không viết lại lifecycle hoặc phát hành bản thiếu thay đổi chưa commit |
| `src/do.ts`, `src/types.ts`, `src/index.ts`, package scripts, workflow CI/env, migrations | File giao nhau: một người tích hợp tại một thời điểm. Chốt SHA đầu vào, hợp nhất và chạy hồi quy trước chuyển quyền sửa |
| FE Halifruit, Fruit Mix, checkout và order service | Đọc để lấy contract; thay đổi adapter tenant bằng PR riêng. Không di chuyển UI, đổi domain model hoặc chuẩn hóa giao diện cùng PR backend |
| FE KediMuse | Giữ UX đổi phương thức mới; không lấy bản FE cũ làm nguồn chuẩn chỉ vì thư mục quen thuộc |
| Registry, config schema, URL builder, test matrix mới | Có thể chuẩn bị trong namespace/file mới; chưa tự nối vào runtime đang phát hành |

Sổ bàn giao khi triển khai cần có: luồng công việc, checkout/branch, SHA nền, file sở hữu, thay đổi schema/API, test đã đạt, cờ đang bật, người tích hợp và SHA bàn giao. Đây là quy trình đề xuất, chưa phải thỏa thuận đã được các chat xác nhận.

Tạo nhánh `codex/fufuni-multi-storefront-refactor` từ baseline đã hợp nhất; dùng checkout/worktree riêng khi bắt đầu sửa code. Không tạo nhánh trên working tree marketing đang bẩn rồi commit lẫn. Trước sửa mỗi nhóm file phải kiểm tra lại diff và tiến trình các chat; sau khi chat khác có commit mới, reconcile trước tiếp tục tích hợp. Không chạy nhiều Worker test suite đồng thời nếu tranh cổng/runtime; dùng RTK cho kết quả ngắn.

## 3 Mô hình nghiệp vụ và định tuyến

`store_id` là đơn vị cách ly dữ liệu và quyền. `storefront_id` là kênh bán thuộc đúng một store: website, app hoặc domain phụ. Storefront không phải database mới mặc định. Hai website của cùng Halifruit có thể dùng cùng tồn; KediMuse và Halifruit vẫn là hai tenant riêng.

Registry store gồm identity bất biến, storage mapping, profile, integration accounts và capability. Registry storefront gồm store liên kết, domain/origin, locale, currency, URL chính sách và tập tính năng được phép. Tính năng storefront chỉ được thu hẹp quyền đã cấp cho store. Quyền sở hữu tài khoản và credentials luôn nằm ở store/account.

Đề xuất URL mới `/stores/{store_id}/v1/...`; BFF dùng base URL chứa store prefix và storefront ID cấu hình phía server. Domain/Origin/header chỉ là đầu vào routing cần kiểm tra, không thay thế authorization. Storefront không được tự chỉ định tài khoản Stripe/POS hoặc storage object. Cache dùng store và cả storefront khi nội dung phụ thuộc kênh.

Token customer/cart/order/marketing có store binding; dữ liệu đặc thù kênh thêm storefront binding khi cần. Consent và suppression có scope rõ: không dùng consent của storefront A cho brand/store B. Với nhiều storefront của cùng store, không mặc nhiên cho phép dùng chung consent nếu policy hoặc nội dung đồng ý khác nhau. Link recovery xác định đúng store và storefront, tính lại tổng trước mua.

```text
Halifruit web / app ─┐
KediMuse web ────────┼─ BFF → Commerce API → StoreContext + StorefrontContext
Storefront mới ─────┘                         │
                        Catalog / Checkout / Order / Payment / Fulfillment
                                             │
                          MerchantDO SQLite theo store + outbox/inbox
                                             │
                          Stripe / Bank evidence / Pancake / Carrier / POD
```

## 4 Cấu trúc source đích

Giữ Hono, Workers và MerchantDO SQLite hiện có. Tách module trong ứng dụng hiện tại, giữ export/facade cũ đến khi toàn bộ caller đã chuyển. Không đồng thời tách package, đổi ORM và thay database.

| Đường dẫn dự kiến dưới `apps/merchant/src` | Trách nhiệm |
| --- | --- |
| `platform/tenancy` | Registry, store/storage mapping, storefront, context, scope và URL builder |
| `platform/config` | Schema, biến platform/store/storefront, secrets selection, readiness |
| `platform/auth` | Tenant membership, scope và adapter legacy |
| `platform/storage` | Chọn DO, KV/R2 namespace, migration registry |
| `platform/jobs` | Dispatch, lease, outbox/inbox, retry và budget theo store |
| `modules/catalog`, `modules/inventory` | Catalog ownership, giá, tồn và reservation |
| `modules/checkout`, `modules/payment`, `modules/order` | Use case, trạng thái và transaction boundary |
| `modules/fulfillment`, `modules/order-service` | Fulfillment, hủy, đổi địa chỉ, trả hàng, nghĩa vụ hoàn tiền |
| `modules/marketing`, `modules/feeds`, `modules/shopping` | Khả năng dùng chung, cấu hình và quyền theo store |
| `integrations/*` | Adapter provider và xác minh webhook/account |
| `compat/*` | Facade RPC, routes và cấu hình legacy tạm thời |

Route xử lý HTTP/auth rồi gọi use case. Use case giữ invariant, nhận repository và provider port. Repository SQL chạy trong DO của store. I/O provider ở ngoài transaction SQL; lưu intent trước gọi và receipt/kết quả sau gọi. Không biến chuỗi RPC đọc/ghi riêng thành transaction giả. `MerchantDO` giữ class/binding identity và RPC facade cũ; tách từng nhóm method, không đổi toàn bộ `do.ts` trong một PR.

Fruit Mix, editor và POD artwork vẫn ở domain riêng. Core nhận line item/metadata có schema và snapshot đã kiểm tra; giá/tồn do server xác định. Không đưa quy tắc Fruit Mix vào checkout chung hoặc gộp mọi đơn KediMuse vào tuyến Pancake.

## 5 Các bất biến phải giữ

- Checkout completion, payment paid và delivery delivered là ba trạng thái khác nhau; COD confirmed vẫn unpaid/to_collect. QR chỉ paid sau bằng chứng hợp lệ.
- Đổi phương thức theo logic mới của chat checkout: đóng/xác minh phiên Stripe cũ, không thanh toán lại đơn đã paid/đã xử lý, giữ dấu vết QR cũ cho tiền về muộn, một checkout thay thế khi yêu cầu lặp/đồng thời, trả giữ tồn đúng một lần.
- Hủy, hoàn tiền và trả hàng của Halifruit giữ riêng tiến trình, audit và phân quyền tài chính. Unknown outcome không được coi như thất bại để tự gửi lại; refund không vượt tiền đã nhận còn khả dụng.
- Giá/discount/tax/shipping tính lại phía server; snapshot đơn đã xác nhận không thay đổi theo catalog mới. Amount dùng minor units cùng currency, không mặc định mọi store VND/0 tax.
- Mỗi shipment có một execution owner: Pancake hoặc direct. Đơn POD quốc tế không tự vào POS; cart hỗn hợp dùng fulfillment groups hoặc chặn rõ theo capability MVP.
- Consent, suppression, eligibility và policy marketing được kiểm tra lại trước gửi. Welcome/recovery/win-back không tự tạo thanh toán; refund và đơn mua mới tiếp tục chặn campaign không phù hợp.
- Nhiều store dùng chung kho/SKU phải có authority chung hoặc phân bổ tồn độc lập. Dùng chung tài khoản nhận tiền phải chống claim cùng giao dịch cho nhiều store. Không giả định unique trong từng DO đã bảo vệ toàn hệ thống.

## 6 Các phase triển khai

| Phase | Công việc và đầu ra | Kiểm thử và điều kiện chuyển phase |
| --- | --- | --- |
| **P0 Chốt baseline và bàn giao** | Reconcile commit checkout mới, PR marketing và delta Halifruit; chốt release manifest, ownership và inventory dữ liệu/route/provider. Tách staging khỏi production | Chạy baseline trên bản tích hợp, ghi số test thực; xác nhận payment-change, marketing lifecycle và order service đều có mặt. Không còn delta chưa phân loại trong phạm vi refactor |
| **P1 Viết hợp đồng và context** | Registry store/storefront, storage identity bất biến, config schema, URL builder và context tối thiểu. Giữ facade `stores.ts` để tránh đổi caller hàng loạt | Fixture 3 store và 2 storefront cùng một store; thiếu/sai registry fail closed, không kế thừa secrets. URL prefix, links, currency, cache variant đúng |
| **P2 Tích hợp routing và quyền** | Nối context vào HTTP/RPC/job; giữ legacy alias; scope public/customer/admin/service/finance; bỏ raw registry/secrets store khác khỏi context | Khóa/token/customer session A bị chặn ở B; storefront lạ/sai store bị từ chối; signed webhook sai account/store không đổi đơn; cache ấm không vượt auth |
| **P3 Tách module giữ nguyên hành vi** | Tách tuần tự catalog/inventory → checkout/payment/order → order-service → marketing/feeds/shopping. Mỗi PR giữ facade và response cũ, dùng diff nhỏ; không thêm tính năng nghiệp vụ vào PR di chuyển | Contract và regression chạy sau từng nhóm; kiểm tra output, state transition và invariant. Runtime Worker/SQLite phải đạt, không chỉ Node unit |
| **P4 Chuẩn hóa integration và job** | Provider ports, account binding, event envelope, inbox/outbox, retry/lookup/dead-letter, budget và lỗi độc lập. Chuẩn hóa branding/email; thêm authority khi tài nguyên dùng chung | Duplicate/out-of-order webhook; crash trước/sau provider success; lease expiry; store A lỗi không chặn B; tồn SKU cuối và giao dịch chung không bị dùng hai lần |
| **P5 CI và adapter storefront** | Manifest validated qua CI; smoke theo store; readiness SHA/config version; adapter FE giữ tenant base path. PR riêng cho Halifruit, PR riêng cho KediMuse; không đổi UI/UX cùng lúc | Halifruit base URL `/stores/halifruit` được giữ trong mọi request. E2E cả hai FE gồm cart, QR/COD/Stripe fixture, đổi phương thức, tracking/hậu mãi và marketing recovery |
| **P6 Chuyển dữ liệu và canary** | Diễn tập export/import, đối chiếu, xử lý session/token, cắt chuyển một store mỗi lần với chỉ một writer/cron owner. Theo dõi rồi chuyển store tiếp theo | Snapshot/schema/count/checksum, ledger/tổng tiền/reservations/external IDs khớp; migration retry idempotent; rollback drill và pause/fence webhook/job đạt |
| **P7 Store thứ ba và bàn giao** | Onboard store mới và storefront thứ hai của một store bằng cấu hình. Runbook provisioning, rotation, backup/restore và incident | Không sửa route/use case để thêm store; không lẫn dữ liệu/brand/consent; cùng-store storefront chia sẻ tồn đúng, khác-store cách ly; load test và cảnh báo đạt |

P0 phải chốt baseline sau thay đổi của hai chat; không yêu cầu hai chat dừng mọi công việc để có thể viết contract mới. P1 chỉ chuẩn bị độc lập; P2/P3 tích hợp file chung theo cửa sổ bàn giao. P6 chỉ bắt đầu sau toàn bộ gate P0–P5 đạt và kế hoạch cutover có số liệu thực.

## 7 Thứ tự PR và migrations

1. PR-00 hợp nhất baseline và test coverage; không chuyển traffic hoặc bật cờ mới.
2. PR-01 thêm config/context/contracts/test fixture; chưa thay cách chọn database.
3. PR-02 nối resolver, URL builder và storage mapping qua facade; xác nhận alias cũ vẫn cùng database và token semantics.
4. PR-03 scope auth/secrets/cache/storage cùng tests chống truy cập chéo.
5. PR-04A catalog/inventory; PR-04B checkout/payment/order; PR-04C order-service; PR-04D marketing/feeds/shopping. Các PR nối tiếp khi đụng chung DO/types.
6. PR-05 provider ports, job dispatch/inbox/outbox và vận hành; không tạo hai runner cùng thực thi một intent.
7. PR-06 manifest/CI/provisioning; PR FE-H và FE-K riêng cho adapter từng frontend.
8. PR-07 công cụ migration, runbook và rehearsal; phát hành cutover tách khỏi deploy refactor.
9. PR-08 store thứ ba, storefront thứ hai và bàn giao; chỉ xóa facade cũ sau thời gian theo dõi và không còn caller phụ thuộc.

Migration mở rộng trước, chuyển reader/writer sau, thu hẹp cuối. Kiểm tra các filename 034/035 trùng prefix hiện có và marketing 038 đang chờ hợp nhất; chỉ cấp ID migration mới sau baseline để tránh collision. Ghi migration receipt theo từng DO/schema version, không chạy file SQL D1 như thể đã migrate DO. Di chuyển module thuần túy không được tự làm thay đổi schema.

Field `storefront_id` mới có default mapping legacy rõ cho dữ liệu cũ; không sửa hàng loạt store ID của lịch sử để làm đẹp tên. Schema và DTO hỗ trợ giai đoạn old/new chạy tương thích; secrets và session được rotate/tái cấp theo lộ trình, không dùng một khóa chung để giữ mọi phiên.

## 8 Bảo toàn Halifruit và dữ liệu KediMuse

Trước cutover xác nhận live namespace/bindings bằng metadata được phép đọc, không dựa riêng vào file local. Không đổi Worker name, MerchantDO class hay default_store trong PR refactor cấu trúc.

Mapping dự kiến giữ dữ liệu KediMuse hiện tại trong DO `default` của namespace merchant và ghim storage identity; Halifruit chuyển vào DO riêng trong cùng backend. Logical ID KediMuse/Printerval/Halifruit được chuẩn hóa qua bảng alias có scope, sau kiểm tra token và dữ liệu lịch sử. Hai DO `default` ở hai namespace khác nhau không phải cùng database.

Trình tự chuyển một store: rehearsal trên dữ liệu cô lập → dừng checkout/ghi trong cửa sổ đã định → drain/fence cron và webhook writer cũ → chốt delta → nhập và đối chiếu → đổi FE/BFF/webhook/job owner đồng bộ → smoke/canary → theo dõi 48–72 giờ. Event đến trong cửa sổ được buffer hoặc provider retry theo hợp đồng đã kiểm chứng. Snapshot rehearsal không được gửi mail, POS, vận đơn hoặc POD.

Giữ host Halifruit cũ như facade/gateway nếu cần để bảo toàn client/link; chỉ triển khai sau khi kiểm tra auth, chữ ký webhook, host/callback và binding thực tế. Gateway phải trỏ tới backend chung, không tiếp tục có writer nghiệp vụ riêng. Không HTTP redirect POST/webhook một cách mặc định.

Trước khi đích nhận ghi, rollback có thể trả về nguồn theo manifest. Sau khi đích có đơn/giao dịch mới, rollback phải fence và reconcile delta hoặc sửa tiến; không đổi URL về nguồn cũ rồi bỏ mất đơn mới. Đơn pending, QR tiền muộn, Stripe session cũ, refund pending/unknown và job provider đang xử lý đều có người/luồng tiếp nhận rõ ràng.

## 9 Ma trận nghiệm thu bắt buộc

| Nhóm | Tình huống cần có |
| --- | --- |
| Tenant | Cùng SKU/email/resource ID/idempotency key tại A/B không đọc/ghi chéo; public/admin/customer/cart/order/download/marketing token; cache và R2 listing/multipart |
| Storefront | Hai storefront cùng store có brand/locale/link đúng, chia sẻ tồn theo policy; channel B không tự mở capability hoặc dùng consent không phù hợp |
| Payment change | Stripe cũ paid/expired/unknown, QR tiền muộn, COD đã export, double-click và request đồng thời; không thu hai lần hoặc trả hold hai lần |
| Stock và order | Cạnh tranh SKU cuối, POS stock refresh, timeout, cancel, expiry, stale quote, thay địa chỉ/phương thức, đúng currency/discount/tax |
| Halifruit hậu mãi | Email verification, quyền finance, hủy/đổi địa chỉ/return, evidence riêng tư, refund cap và unknown outcome; Fruit Mix cart handoff giữ contract |
| Marketing | Confirmation/welcome, abandoned sau đổi payment, post-purchase, win-back, unsubscribe/bounce/complaint; sender và tenant đúng; suppression trước I/O |
| Feed và AI | Feed URL, landing page, UCP discovery/callback/handoff đúng tenant; public role không có Admin; POD/ACP/MCP tắt vẫn không phá stock checkout |
| Vận hành | Job retry/crash/replay, account binding, secrets rotation, noisy tenant, backlog, migration retry, backup restore và rollback có đơn mới |

Bắt đầu bằng các script đã có: merchant typecheck, `test:stores`, `test:stores:runtime`, `test:phase5`, `test:pod:ready`, lifecycle/order-service suite đã hợp nhất; Admin/FE dùng script của đúng baseline. Bổ sung tests theo invariant ở trên, không chỉ kiểm tra cấu trúc thư mục mới. Runtime từng treo trong lần đánh giá trước nên phải xử lý/chạy lại; không đánh dấu pass nhờ bỏ suite hoặc tăng timeout để che lỗi. Mỗi phase lưu SHA, lệnh test, kết quả và giới hạn nghiệm thu.

## 10 Điều kiện hoàn thành và ước lượng

- Halifruit và KediMuse thực sự gọi một dịch vụ backend, mỗi store có storage/account/scope riêng, không chỉ dùng chung repository.
- Hai storefront của một store hoạt động mà không phải nhân đôi tồn/order; thêm store thứ ba bằng manifest và provisioning.
- Checkout mới, lifecycle marketing và hậu mãi Halifruit đều được bảo toàn trên bản tích hợp có runtime/E2E đạt.
- CI kiểm tra registry/secrets schema và hồi quy từng store; release/cấu hình truy vết được, operator có runbook và cảnh báo.
- Migration, session/token compatibility và phục hồi dữ liệu có bằng chứng nghiệm thu; hệ thống nguồn không còn writer kép sau cutover.

Ước lượng lập kế hoạch: khoảng 4–6 tuần cho một kỹ sư quen hệ thống, cộng thời gian chờ cấu hình provider/nghiệm thu; hiệu chỉnh sau P0. Thời gian phụ thuộc mức độ reconciliation các nhánh hiện tại và tài nguyên thực sự dùng chung. Không coi Mailgun thật, Stripe live, QR tiền thật, GHN dispatch, POD production hoặc merchant feed approval là tự hoàn tất nhờ refactor.

## 11 Phạm vi đã thực hiện khi lập kế hoạch

Đã đọc lại hai chat, đối chiếu HEAD/diff của Fufuni và checkout phát hành, kiểm tra adapter và luồng local Halifruit. Chỉ bổ sung tài liệu kế hoạch và liên kết từ bản đánh giá trước; chưa sửa code, không chạy lại bộ test ứng dụng, không deploy hoặc thay cấu hình live. Không tạo sub-agent hoặc gửi yêu cầu sang hai chat khác.
