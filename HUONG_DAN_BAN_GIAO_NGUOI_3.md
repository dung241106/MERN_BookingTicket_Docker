# QUICKSHOW — BÀN GIAO NGƯỜI 3 (BACKEND / MONGODB / INTEGRATIONS)

**Cho Người 1 (DevOps / Compose tổng) và Người 2 (Frontend / Nginx).**  
Ngày kiểm thử: 18/11/2026. Repository: https://github.com/dung241106/MERN_BookingTicket_Docker

> **Bảo mật:** Repo PUBLIC, không commit server/.env, server/.env.mongo, backups, GPG package hoặc mật khẩu. Gói mã hóa GPG nằm trên máy Người 3; cần chuyển riêng qua kênh an toàn và gửi mật khẩu mới bằng kênh khác. Mật khẩu gói cũ đã xuất hiện trong cuộc trò chuyện, nên phải mã hóa lại trước khi bàn giao.

## 1. Phân chia và những gì đã làm

- **Người 1:** Compose tổng, network, volume, tích hợp tất cả thành một project.
- **Người 2:** nhánh [feat/docker-frontend](https://github.com/dung241106/MERN_BookingTicket_Docker/tree/feat/docker-frontend): `client/Dockerfile`, `client/nginx.conf`, scripts kiểm thử, Frontend React/Vite → Nginx.
- **Người 3:** nhánh [feat/docker-backend-db](https://github.com/dung241106/MERN_BookingTicket_Docker/tree/feat/docker-backend-db): `server/Dockerfile`, `server/.dockerignore`, `server/compose.backend-test.yaml`, `server/server.js`, `server/inngest/client.js`.

**Người 3 đã test trên Ubuntu:** Docker Backend healthy, MongoDB 8.0 healthy; Volume tồn tại sau `compose down` (không `-v`); backup/restore; Clerk không có token/token sai bị 401, login thật; Stripe test webhook chữ ký sai trả 400 và chữ ký đúng trả 200; thanh toán test $5 nhận sự kiện `checkout.session.completed`, booking chuyển `isPaid:true`; Inngest Dev local gửi email và ghi `confirmationEmailSentAt`. Snapshot backup ban đầu có 14 movies, 9 bookings, 3 users và 21 shows (47 documents), *không bao gồm mọi giao dịch phát sinh sau ngày backup*.

## 2. Lấy code để tích hợp

```bash
git clone https://github.com/dung241106/MERN_BookingTicket_Docker.git
cd MERN_BookingTicket_Docker
git fetch origin feat/docker-backend-db feat/docker-frontend
```

Nên tích hợp qua Pull Request của từng người. Nếu đang sửa trên nhánh riêng, commit/stash trước; không `git reset --hard`. `server/compose.backend-test.yaml` là Compose **lab chỉ gồm mongo và api**, chưa phải Compose tổng.

## 3. Lấy gói GPG (file này KHÔNG ở trên GitHub)

Người 3 cần chuyển **file mã hóa thực tế** từ máy Ubuntu:

```text
handoff/quickshow-private.tar.gz.gpg
```

Sau khi giải mã, gói chứa:

```text
server/.env
server/.env.mongo
backups/quickshow-local-final.archive.gz
```

### Người 3 mã hóa lại với mật khẩu MỚI (trên máy Người 3)

```bash
mkdir -p handoff
chmod 700 handoff
umask 077
set -o pipefail
tar -czf - server/.env server/.env.mongo backups/quickshow-local-final.archive.gz |
  gpg --symmetric --cipher-algo AES256 \
    --output handoff/quickshow-private-ROTATED.tar.gz.gpg
gpg --quiet --decrypt handoff/quickshow-private-ROTATED.tar.gz.gpg | tar -tzf -
```

Gửi `handoff/quickshow-private-ROTATED.tar.gz.gpg` cho hai thành viên bằng Drive/chia sẻ giới hạn quyền. Gửi mật khẩu **mới, dài, ngẫu nhiên** qua kênh riêng khác. Không đăng gói này vào repo PUBLIC.

### Người 1/Người 2 giải mã trên Ubuntu

Đặt file nhận được ở một thư mục riêng, mở terminal tại root project:

```bash
mkdir -p private-handoff
chmod 700 private-handoff
umask 077
set -o pipefail
gpg --quiet --decrypt /DUONG_DAN/quickshow-private-ROTATED.tar.gz.gpg |
  tar -xzf - -C private-handoff
find private-handoff -type f
```

Nhập password khi GPG hỏi. File nằm tại `private-handoff/server/.env`, `private-handoff/server/.env.mongo`, `private-handoff/backups/quickshow-local-final.archive.gz`. **Sao lưu .env hiện có trước khi thay thế**, rồi:

```bash
cp private-handoff/server/.env server/.env
cp private-handoff/server/.env.mongo server/.env.mongo
chmod 600 server/.env server/.env.mongo
```

**Không `git add .`** với `private-handoff/` hay `handoff/` còn nằm trong project. Không được chia sẻ password, database URI, SMTP/Stripe/Clerk/Inngest secrets trên GitHub.

## 4. Chạy Backend Docker + MongoDB từ repo root

```bash
sudo docker compose --env-file server/.env.mongo \
  -f server/compose.backend-test.yaml up -d --build
sudo docker compose --env-file server/.env.mongo \
  -f server/compose.backend-test.yaml ps
curl http://localhost:3000/health
```

Mong đợi: `{"status":"healthy","database":"connected"}`. `server/.env.mongo` cung cấp `MONGO_ROOT_USER` và `MONGO_ROOT_PASSWORD`; Compose tạo MongoDB 8.0 và định tuyến API đến service `mongo`. Compose ghi đè `MONGODB_URL` trong .env bằng URI MongoDB nội bộ. Nếu password có ký tự đặc biệt, cần URL-encode khi xuất hiện trong URI. Credential của volume đã khởi tạo không tự thay đổi khi sửa .env.

**Giữ volume:** KHÔNG `docker compose down -v`, `docker volume prune` hay xóa data dir.

### Restore chỉ khi MongoDB local MỚI/TRỐNG

```bash
sudo docker cp private-handoff/backups/quickshow-local-final.archive.gz \
  quickshow-backend-lab-mongo-1:/tmp/quickshow-local-final.archive.gz

sudo docker exec quickshow-backend-lab-mongo-1 sh -c '
  mongorestore --archive=/tmp/quickshow-local-final.archive.gz --gzip \
  -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
  --authenticationDatabase admin --nsInclude="quickshow.*"
'
```

Không dùng `--drop` nếu database đang chứa dữ liệu cần giữ; khi restore vào DB có dữ liệu có thể gặp duplicate key. Đếm snapshot qua `mongosh` (14 movies / 9 bookings / 3 users / 21 shows trước khi phát sinh giao dịch mới).

## 5. Người 1 ghép Frontend Người 2

Compose root cần services `web`, `api`, `mongo` cùng mạng Docker thích hợp, MongoDB dùng named volume. Khi chuyển file lab từ `server/` lên root, phải đổi đường dẫn `api.build.context` thành `./server`, `api.env_file` thành `./server/.env`. Nginx của Người 2 proxy `/api/*` đến `api:3000`; hai service phải ở **cùng network**.

Frontend build args: `VITE_CLERK_PUBLISHABLE_KEY` (public), `VITE_BASE_URL=/`; publish `8080:80`. Không đưa secret vào VITE_. Ở Backend, đặt `FRONTEND_URL=http://localhost:8080` hoặc đúng origin thực tế và cấu hình Clerk chấp nhận origin này. Thay build args cần rebuild frontend. Đừng chạy song song Compose lab và Compose tổng nếu trùng cổng 3000/8080.

Test nhanh: `curl -i http://localhost:8080/api/show/all`, mở `http://localhost:8080`, đăng nhập Clerk, refresh route /movies và /my-bookings, truy cập `/healthz`.

## 6. Stripe Webhook Local (chỉ Test/Sandbox)

Stripe Dashboard trước đây trỏ webhook về **Vercel**, không phải MongoDB Docker Ubuntu. Muốn xử lý booking Docker, mở Stripe CLI listener:

```bash
stripe login
stripe listen \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.expired,checkout.session.async_payment_failed,payment_intent.succeeded \
  --forward-to http://127.0.0.1:3000/api/stripe
```

Lấy `whsec_...` của **listener này**, lưu trong `server/.env: STRIPE_WEBHOOK_SECRET`, sau đó recreate API:

```bash
sudo docker compose --env-file server/.env.mongo \
  -f server/compose.backend-test.yaml \
  up -d --no-deps --force-recreate api
```

Đừng nhầm CLI signing secret với Vercel webhook secret. `STRIPE_SECRET_KEY` phải là Test Mode (`sk_test_`) và Stripe CLI phải dùng cùng sandbox. Khi nhận event thật, CLI phải báo POST 200 và MongoDB có `isPaid:true`. Không thanh toán thử bằng tiền thật; không update thủ công isPaid.

## 7. Inngest Dev Local và Cloud

Người 3 đã sửa `server/inngest/client.js` để `INNGEST_DEV=1` dùng local. Với mạng lab `quickshow-backend-lab_backend_net`:

```bash
sudo docker run -d --name quickshow-inngest-dev \
  --network quickshow-backend-lab_backend_net \
  -p 127.0.0.1:8288:8288 \
  inngest/inngest inngest dev -u http://api:3000/api/inngest
```

Local `server/.env`:

```dotenv
INNGEST_DEV=1
INNGEST_BASE_URL=http://quickshow-inngest-dev:8288
```

Recreate/rebuild API tùy thay đổi code/env; xem `http://localhost:8288` → Apps/Functions/Runs. `send-booking-confirmation-email` chỉ gửi email khi `isPaid:true` và `confirmationEmailSentAt` chưa có. Nếu output `load-paid-booking = null`, kiểm tra booking đã gửi email trước hay chưa; event lặp có thể đúng là bị bỏ qua để chống gửi email trùng.

**Inngest Cloud Production** từng sync về Vercel (`https://quickshow-server-lac-two.vercel.app/api/inngest`). Không thay URL Production cho bài test Ubuntu. Khi có deployment public mới, Người 1 cần sync app URL và Cloud keys của đúng environment.

## 8. Lỗi đã gặp

| Lỗi | Kiểm tra |
|---|---|
| Docker containers/volumes biến mất sau reboot | Có thể Snap Docker đang chiếm socket trong khi dữ liệu APT ở /var/lib/docker; chạy `sudo docker info --format '{{.DockerRootDir}}'` rồi xác minh trước khi chỉnh dịch vụ |
| Curl 52/56 sau recreate | Chờ API healthy; `docker compose ... logs --tail=50 api` |
| Stripe Succeeded nhưng booking false | Stripe Webhook về Vercel thay vì Docker; dùng Stripe CLI listener, kiểm tra sandbox, secret, booking ID |
| Inngest Completed mà không thấy email | Xem `load-paid-booking` và `confirmationEmailSentAt`; phân biệt local vs Cloud |
| Nginx /api 502 | Chưa cùng network hoặc API chưa healthy |
| Restore duplicate key | Database không trống; không `--drop` tùy tiện |

## 9. Checklist nghiệm thu tích hợp cho Người 1

- [ ] PR Backend và Frontend được review, merge đúng nhánh.
- [ ] Compose tổng chạy web + api + mongo, có network, volume, healthchecks.
- [ ] Nhận **file GPG mới**, giải mã riêng, cập nhật env đúng môi trường.
- [ ] API /health và frontend /healthz healthy; Frontend gọi /api/show/all qua Nginx.
- [ ] Clerk đăng nhập và API được xác thực.
- [ ] Stripe Sandbox Checkout + Webhook HTTP 200 + MongoDB isPaid:true.
- [ ] Inngest Local gửi email, confirmationEmailSentAt có giá trị; kiểm tra Inbox/Spam.
- [ ] Snapshot backup khôi phục thành công trên database mới; volume tồn tại qua restart.
- [ ] Có ảnh/log bằng chứng trong docs/evidence, kiểm tra không lộ credential.
- [ ] Rotate những API/signing secrets từng bị lộ; không commit file nhạy cảm.

**Bàn giao:** Code lấy từ GitHub. Gói GPG phải được Người 3 **gửi trực tiếp**, không có sẵn trong repo; password mới gửi riêng. Snapshot dùng cho demo, không công khai dữ liệu cá nhân.