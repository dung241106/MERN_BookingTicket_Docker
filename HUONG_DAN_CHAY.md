# Chạy lại DACS2_WEB và tìm thông tin kết nối

Code vẫn dùng React + Vite, Express, MongoDB, Clerk, Stripe Checkout, TMDB, Inngest và Brevo SMTP. Luồng người dùng, giới hạn 5 ghế và thời gian giữ ghế 10 phút được giữ nguyên. Hướng dẫn này chạy bằng các lệnh hiện có, không thêm cấu hình Docker.

## 1. Những thông tin còn giữ được

Kiểm tra `client/.env` hiện có trước khi tạo lại: file này có thể còn publishable key của Clerk và URL backend cũ. Bản sửa không thay thế file `.env` thật. Với thư mục dự án mình đã kiểm tra, chưa thấy `server/.env`.

Nếu trước đây bạn đã cấu hình Ubuntu hoặc dịch vụ hosting, kiểm tra `.env` trên máy Ubuntu hoặc mục Environment Variables của đúng ứng dụng đã deploy. Chỉ có các biến `VITE_...` mới đưa vào frontend. Secret key, webhook signing secret và SMTP password nằm trong `server/.env`.

## 2. Tìm lại từng key

| Dịch vụ | Nơi tìm | Biến trong dự án |
| --- | --- | --- |
| Clerk | [Dashboard](https://dashboard.clerk.com/) → chọn đúng ứng dụng và Development/Production instance → API keys | Publishable key `pk_...` vào cả `client/.env: VITE_CLERK_PUBLISHABLE_KEY` và `server/.env: CLERK_PUBLISHABLE_KEY`; secret key `sk_...` vào `CLERK_SECRET_KEY` |
| Stripe | [API keys](https://dashboard.stripe.com/apikeys) → chọn sandbox/test phù hợp | `STRIPE_SECRET_KEY=sk_test_...`. Frontend hiện dùng Checkout do server tạo, nên không cần Stripe publishable key |
| Stripe webhook | Local: chạy `stripe listen` ở bước 5. Deploy: mở đúng endpoint trong Stripe Dashboard và xem signing secret | `STRIPE_WEBHOOK_SECRET=whsec_...`. Secret của CLI và của endpoint deploy khác nhau |
| TMDB | [Account → Settings → API](https://www.themoviedb.org/settings/api) | Copy **API Read Access Token** vào `TMDB_API_KEY`. Code gửi Bearer token nên không dùng API key v3 ngắn |
| Inngest Cloud | [Dashboard](https://app.inngest.com/) → chọn đúng environment → Event Keys và Signing Keys | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`. Cả hai key phải thuộc cùng environment Cloud |
| Brevo | [Settings → SMTP & API](https://app.brevo.com/settings/keys/smtp) → tab SMTP | SMTP login vào `SMTP_USER`, SMTP key vào `SMTP_PASS`; địa chỉ sender đã xác minh vào `SENDER_EMAIL` |
| MongoDB Atlas | Cluster → Connect → Drivers → copy URI và thay mật khẩu database user | `MONGODB_URL`; database mặc định `quickshow`, đổi bằng `MONGODB_DB_NAME` nếu cần |

Nếu secret cũ không còn được hiển thị, tạo key mới trên đúng dịch vụ rồi thay trong cấu hình. Brevo chỉ hiển thị đầy đủ SMTP key lúc tạo; mất key thì cần tạo mới. SMTP key khác Brevo API key và khác mật khẩu đăng nhập.

Clerk frontend/backend phải thuộc cùng ứng dụng và cùng instance. Không lấy publishable key của dự án cũ ghép với secret key của một ứng dụng khác.

## 3. Chuẩn bị trên Ubuntu

Mở terminal tại thư mục `DACS2_WEB`. Dùng Node.js **22.20 trở lên trong nhánh 22**, npm và kết nối MongoDB Atlas. Phiên bản Node này tương thích với dependency đã khóa trong dự án. Không chép `node_modules` của Windows sang Ubuntu.

```bash
node --version
npm --version

cd server
npm ci
cd ../client
npm ci
cd ..
```

Chỉ tạo `.env` nếu file tương ứng chưa tồn tại:

```bash
test -f server/.env || cp server/.env.example server/.env
test -f client/.env || cp client/.env.example client/.env
nano server/.env
nano client/.env
```

Điền key thật thay cho các giá trị `REPLACE_...`. Chạy local với frontend `http://localhost:5173`, backend `http://localhost:3000`, `INNGEST_DEV=0`. Nếu cần giữ URL khác đang có, cập nhật `VITE_BASE_URL` và `FRONTEND_URL` tương ứng. Dừng và khởi động lại tiến trình sau khi đổi `.env`.

Dự án này dùng MongoDB Atlas: đặt URI `mongodb+srv://...` của cluster trong `server/.env: MONGODB_URL`, dùng đúng mật khẩu database user và thêm IP máy chạy backend trong Network Access. Không cần cài MongoDB local để chạy ứng dụng. Các URL localhost của frontend/backend vẫn dùng cho demo trên máy.

## 4. Chạy hai terminal và dùng Inngest Cloud

Terminal 1, tại `DACS2_WEB/server`:

```bash
npm run server
```

Terminal 2, tại `DACS2_WEB/client`:

```bash
npm run dev
```

Mở frontend tại `http://localhost:5173`, xem Inngest Cloud tại `https://app.inngest.com`. Không chạy Inngest Dev Server local. Backend gốc `http://localhost:3000/` trả về `Server is live`. Trong Inngest cần thấy app `movie-ticket-booking` cùng các function đã đăng ký. Nếu Vite chuyển sang cổng khác vì 5173 đang bận, dừng tiến trình cũ hoặc cập nhật `FRONTEND_URL` cho cổng thực tế.

Nếu Ubuntu là máy từ xa và bạn mở trình duyệt từ máy Windows khác, `localhost` trong trình duyệt là máy Windows. Hãy đặt `VITE_BASE_URL` thành địa chỉ backend mà trình duyệt truy cập được, `FRONTEND_URL` thành origin thật của frontend, và chạy `npm run dev -- --host 0.0.0.0` nếu cần truy cập Vite qua mạng. Clerk phải cho phép URL frontend đang dùng.

## 5. Cho Stripe gọi lại backend local

Cài Stripe CLI theo [hướng dẫn chính thức](https://docs.stripe.com/cli). Mở thêm một terminal:

```bash
stripe login
stripe listen \
  --events checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,payment_intent.succeeded \
  --forward-to http://localhost:3000/api/stripe
```

Copy `whsec_...` do lệnh trên in ra vào `server/.env: STRIPE_WEBHOOK_SECRET`, rồi khởi động lại backend. Giữ terminal Stripe CLI mở trong lúc thử thanh toán. Stripe CLI và `STRIPE_SECRET_KEY` phải dùng cùng account/sandbox.

Khi deploy, tạo hoặc sửa endpoint Stripe thành `https://DIA_CHI_BACKEND/api/stripe`, đăng ký các event phía trên và dùng signing secret của endpoint đó. Không dùng secret của terminal local cho endpoint deploy.

Thử mua vé thật qua giao diện ở test mode với thẻ `4242 4242 4242 4242`, ngày hết hạn tương lai và CVC bất kỳ hợp lệ. Không dùng sự kiện Stripe giả không có `metadata.bookingId` để kết luận luồng đặt vé đã chạy: webhook phải khớp booking và số tiền do backend tạo.

## 6. Đồng bộ user Clerk và cấp quyền admin

Trong Clerk Dashboard → Users → chọn tài khoản → User metadata → **Private**, giữ các trường khác nếu có và thêm:

```json
{ "role": "admin" }
```

Đây là Private metadata, đúng với `protectAdmin` hiện tại. Đăng nhập lại hoặc tải lại trang rồi mở `/admin`.

Dự án đồng bộ bảng User qua sự kiện Inngest, không tự tạo một tài khoản MongoDB khi chỉ đăng nhập Clerk:

1. Clerk Dashboard → Webhooks → Add Endpoint → Transformation template → Inngest → Connect, chọn các sự kiện `user.created`, `user.updated`, `user.deleted` theo [hướng dẫn Clerk](https://clerk.com/docs/guides/development/webhooks/inngest).
2. Trong `server/.env`, đặt `INNGEST_DEV=0` và điền Event Key/Signing Key thuộc cùng environment. Trong Inngest Cloud → Apps → Sync app, dùng URL public `https://DIA_CHI_BACKEND/api/inngest`. Cloud không gọi được URL localhost trên máy bạn.
3. App `movie-ticket-booking` hiện có URL đã sync là `https://quickshow-server-lac-two.vercel.app/api/inngest`. Đây là backend Vercel, tách biệt với backend đang chạy trên máy. Khi thay đổi function, cần deploy code mới và cấu hình tương ứng lên backend này, rồi sync lại. Việc gửi event từ máy lên Cloud không tự cập nhật code worker trên Vercel.
4. Kiểm tra collection `users` trong database `quickshow` có đúng ID Clerk, email và tên. Với user cũ, có thể phát lại sự kiện `clerk/user.created` hoặc `clerk/user.updated` của chính user đó sau khi backend Cloud đã được cấu hình đúng.

## 7. Kiểm tra sau khi khởi động

- Đăng nhập, mở `/admin/add-shows`, lấy phim từ TMDB và thêm suất chiếu tương lai.
- Chọn suất có giá lẻ, ví dụ $8.50: giá hiển thị và Stripe phải khớp.
- Thử hai trình duyệt chọn cùng ghế: chỉ một booking được giữ ghế.
- Thanh toán test thành công: Stripe webhook trả 200, vé chuyển `isPaid: true`, email xác nhận chạy qua Inngest.
- Để một vé không thanh toán: sau 10 phút, các function đã deploy trên Inngest Cloud đóng Checkout rồi mới nhả ghế và xóa booking chưa trả tiền như luồng cũ. Nếu event bị mất do gián đoạn mạng, tác vụ phục hồi 5 phút/lần sẽ xử lý khi Inngest hoạt động.
- Trong admin List Shows, doanh thu chỉ tính booking đã trả tiền.

Booking cũ sẽ được tìm session ID từ paymentLink nếu đó là URL Stripe Checkout hợp lệ. Trường hợp dữ liệu cũ thiếu URL/session ID hoặc có các booking trùng ghế do lỗi trước đây, kiểm tra Stripe và MongoDB trước khi giải phóng thủ công; không xóa booking đã thu tiền.

## 8. Các lệnh kiểm tra code

```bash
cd client
npm run lint
npm run build

cd ../server
npm test
```

Backend test tự khởi động `mongod` trên cổng tạm và database riêng `quickshow_regression_<pid>`, dùng Stripe/email giả lập. Các bài kiểm thử dùng MongoDB tạm riêng, không dùng cluster Atlas chứa dữ liệu ứng dụng. Việc chạy các bài test này là tùy chọn; bản demo ứng dụng chỉ cần URI Atlas.

Không cần dùng MongoDB tài khoản thật để chạy test. Nếu binary mongod không nằm trong PATH, đặt `MONGOD_BINARY=/duong/dan/toi/mongod`.

## Tài liệu dịch vụ

- [Clerk environment variables](https://clerk.com/docs/guides/development/clerk-environment-variables)
- [Stripe API keys](https://docs.stripe.com/keys) và [webhook CLI](https://docs.stripe.com/cli/listen)
- [TMDB Bearer authentication](https://developer.themoviedb.org/docs/authentication-application)
- [Inngest Cloud apps và sync](https://www.inngest.com/docs/platform-and-operations/apps-and-syncs) và [Event/Signing keys](https://www.inngest.com/docs/platform-and-operations/keys-and-access)
- [Brevo SMTP keys](https://help.brevo.com/hc/en-us/articles/7959631848850-Create-and-manage-your-SMTP-keys)
