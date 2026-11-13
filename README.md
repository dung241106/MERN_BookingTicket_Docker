# QuickShow — Website đặt vé xem phim

Dự án **WEB** gồm giao diện khách hàng, trang quản trị và API backend cho hệ thống đặt vé xem phim.

## Chức năng chính

**Khách hàng**
- Đăng ký, đăng nhập qua Clerk.
- Xem danh sách phim, chi tiết phim và suất chiếu.
- Chọn ghế, tạo đơn đặt vé và thanh toán qua Stripe Checkout.
- Xem vé đã đặt và danh sách phim yêu thích.

**Quản trị**
- Truy cập trang quản trị tại `/admin`.
- Lấy thông tin phim từ TMDB và thêm suất chiếu.
- Xem danh sách suất chiếu, đơn đặt vé và dashboard.

**Xử lý nền**
- Đồng bộ người dùng Clerk qua Inngest.
- Xử lý email và các tác vụ liên quan đến đặt vé qua Inngest, Brevo SMTP.
- Giữ ghế tối đa 10 phút cho đơn chưa thanh toán; mỗi đơn tối đa 5 ghế.

## Công nghệ

| Thành phần | Công nghệ |
| --- | --- |
| Frontend | React 19, Vite, Tailwind CSS 4, React Router |
| Backend | Node.js, Express 5 |
| Cơ sở dữ liệu | MongoDB, Mongoose |
| Xác thực | Clerk |
| Thanh toán | Stripe Checkout, Stripe webhook |
| Dữ liệu phim | TMDB |
| Tác vụ nền | Inngest |
| Email | Nodemailer, Brevo SMTP |

## Cấu trúc thư mục

```text
DACS2_WEB/
├── client/             # Frontend và giao diện quản trị
├── server/             # API, cơ sở dữ liệu và tác vụ nền
├── .gitignore
├── HUONG_DAN_CHAY.md    # Hướng dẫn cấu hình dịch vụ và chạy chi tiết
└── README.md
```

## Chạy trên máy

### 1. Tải code

```bash
git clone https://github.com/dung241106/DACS2_WEB.git
cd DACS2_WEB
```

Nếu đã có dự án trên máy, cập nhật bằng `git pull` sau khi đã lưu hoặc commit các thay đổi riêng.

### 2. Cài thư viện

Chuẩn bị Node.js 22.20 trở lên trong nhánh 22 và npm.

```bash
cd server
npm ci
cd ../client
npm ci
cd ..
```

### 3. Cấu hình môi trường

Nếu chưa có file cấu hình, sao chép bằng trình quản lý file hoặc VS Code:

- `client/.env.example` → `client/.env`
- `server/.env.example` → `server/.env`

Điền thông tin dịch vụ vào các file vừa tạo. Giữ file `.env` hiện có nếu đã cấu hình.

| File | Nội dung cấu hình |
| --- | --- |
| `client/.env` | Clerk publishable key, URL backend, ký hiệu tiền tệ và URL ảnh TMDB |
| `server/.env` | MongoDB, Clerk, Stripe, TMDB, Inngest, SMTP, URL frontend và múi giờ |

Cấu hình local:
- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3000`
- `client/.env`: `VITE_BASE_URL=http://localhost:3000`
- `server/.env`: `FRONTEND_URL=http://localhost:5173`

MongoDB Atlas cần URI kết nối hợp lệ và cho phép IP của máy chạy backend. Clerk frontend và backend phải thuộc cùng ứng dụng, cùng instance.

Không đưa secret key hoặc mật khẩu vào các biến `VITE_...`; các biến này được đưa vào frontend khi build. Không commit file `.env` chứa thông tin thật.

### 4. Khởi động

Mở hai terminal tại thư mục gốc dự án.

**Terminal backend:**

```bash
cd server
npm run server
```

**Terminal frontend:**

```bash
cd client
npm run dev
```

Mở `http://localhost:5173`. Khi backend hoạt động, truy cập `http://localhost:3000/` sẽ nhận `Server is live`.

### 5. Hoàn tất cấu hình dịch vụ

Để thử đầy đủ luồng đặt vé, cần cấu hình thêm:
- Stripe webhook: `/api/stripe`. Với backend local, dùng Stripe CLI chuyển tiếp webhook.
- Inngest Cloud: sync endpoint public `/api/inngest` và dùng Event Key/Signing Key cùng environment.
- Clerk: chuyển tiếp sự kiện người dùng đến Inngest.
- Brevo: SMTP login, SMTP key và địa chỉ gửi đã xác minh.
- Quyền admin: đặt `{"role":"admin"}` trong **Private metadata** của người dùng Clerk.

Xem [hướng dẫn cấu hình và chạy chi tiết](./HUONG_DAN_CHAY.md) trước khi thử thanh toán, đồng bộ người dùng và email. Inngest Cloud cần endpoint public; không gọi trực tiếp được localhost.

## Kiểm tra code

Frontend:

```bash
cd client
npm run lint
npm run build
```

Backend:

```bash
cd server
npm test
```

Backend test cần binary `mongod` trong PATH hoặc biến `MONGOD_BINARY`; test dùng database tạm riêng. Các lệnh trên là hướng dẫn kiểm tra, không phải xác nhận rằng bản hiện tại đã vượt qua kiểm thử.

## Triển khai

Backend đã có cấu hình xử lý môi trường Vercel trong `server/server.js`. Dependency Inngest hiện được khai báo là `^3.54.2`.

Khi triển khai:
1. Thiết lập các biến môi trường tương ứng cho frontend và backend trên hosting.
2. Đặt `VITE_BASE_URL` thành URL backend và `FRONTEND_URL` thành origin frontend thực tế; build lại frontend sau khi đổi biến.
3. Cập nhật Stripe webhook và sync lại ứng dụng Inngest theo URL backend đang sử dụng.
4. Kiểm tra đăng nhập, tạo suất chiếu, đặt ghế, thanh toán test và email trên môi trường đã deploy.

Deploy thành công chưa xác nhận toàn bộ tích hợp đã hoạt động. Dùng Stripe test mode khi kiểm tra luồng thanh toán.
