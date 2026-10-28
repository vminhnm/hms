<div align="center">

# Hệ thống quản lý nhân sự bệnh viện

Số hóa quy trình nhân sự bệnh viện: hồ sơ nhân viên, phân ca trực, chấm công tự động, tính lương và báo cáo.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8.0.16%2B-4479A1?logo=mysql&logoColor=white)

</div>

## Mục lục
- [Giới thiệu](#giới-thiệu)
- [Chức năng](#chức-năng)
- [Công nghệ](#công-nghệ)
- [Cài đặt và chạy](#cài-đặt-và-chạy)
- [Cấu hình môi trường](#cấu-hình-môi-trường)
- [Thiết kế cơ sở dữ liệu](#thiết-kế-cơ-sở-dữ-liệu)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [API](#api)
- [Hạn chế và hướng phát triển](#hạn-chế-và-hướng-phát-triển)
- [Giấy phép](#giấy-phép)

## Giới thiệu
Dữ liệu được tổ chức xoay quanh **nhân viên**, gắn với khoa/phòng, vai trò, ca làm việc, lịch phân công, chấm công và bảng lương. Phần lớn quy tắc nghiệp vụ (phân loại đi muộn/về sớm, tính lương) được cài đặt **ngay trong MySQL** bằng trigger và stored procedure, nên dữ liệu luôn nhất quán dù được sửa từ web hay từ công cụ khác.

## Chức năng

| Vai trò | Chức năng |
|---|---|
| **Nhân viên** | Xem thông tin cá nhân, lịch trực, lịch sử chấm công, bảng lương; check-in/check-out |
| **Nhân sự / Quản lý** | CRUD nhân viên, khoa/phòng, vai trò và phụ cấp, ca trực; phân ca (chặn trùng giờ); nhập/sửa giờ chấm công; chốt vắng mặt cuối ngày; báo cáo |
| **Kế toán lương** | Tính lương tháng; duyệt từng phiếu hoặc hàng loạt; đánh dấu đã trả; xuất CSV; báo cáo chi phí nhân sự |

Báo cáo gồm: thống kê chuyên cần theo khoa/phòng, danh sách nhân viên vi phạm nhiều nhất, chi phí nhân sự theo tháng.

## Công nghệ
- **MySQL 8**: bảng, khóa ngoại, CHECK, trigger, stored procedure
- **Node.js + Express 5**: REST API
- **mysql2**: kết nối cơ sở dữ liệu
- **bcryptjs, jsonwebtoken**: mã hóa mật khẩu, đăng nhập bằng JWT
- **HTML/CSS/JavaScript thuần**: giao diện một trang (`public/index.html`)

## Cài đặt và chạy

**Yêu cầu:** Node.js 18+, MySQL 8.0.16+ (bản cũ hơn bỏ qua ràng buộc CHECK).

```bash
# 1. Lấy mã nguồn
git clone https://github.com/vminhnm/hms.git
cd hms

# 2. Tạo cơ sở dữ liệu, bảng, trigger, procedure
mysql -u root -p < schema.sql

# 3. Tạo file cấu hình (xem mục bên dưới) rồi điền mật khẩu MySQL
cp .env.example .env          # Windows CMD: copy .env.example .env

# 4. Cài thư viện, nạp dữ liệu mẫu, chạy
npm install
npm run seed
npm start
```

Mở http://localhost:3000.

> Nếu không dùng được lệnh `mysql`, mở `schema.sql` trong MySQL Workbench và bấm Execute. Không dùng công cụ thiếu hỗ trợ `DELIMITER`, vì trigger và procedure sẽ không được tạo.

**Tài khoản mẫu** (mật khẩu `123456`):

| Tên đăng nhập | Quyền |
|---|---|
| `hr` | Nhân sự / Quản lý |
| `ketoan` | Kế toán lương |
| `nv001` | Nhân viên |

> Đổi các mật khẩu mẫu trước khi triển khai thật.

## Cấu hình môi trường
Sao chép `.env.example` thành `.env` (file `.env` **không** được đưa lên Git).

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DB_HOST` | `127.0.0.1` | Máy chứa MySQL |
| `DB_USER` | `root` | Tài khoản MySQL |
| `DB_PASSWORD` | rỗng | Mật khẩu MySQL |
| `DB_NAME` | `hospital_hr` | Tên database |
| `PORT` | `3000` | Cổng web |
| `JWT_SECRET` | (đổi giá trị này) | Khóa ký token đăng nhập |
| `TZ_OFFSET` | `+07:00` | Múi giờ dùng cho ca trực và chấm công |

## Thiết kế cơ sở dữ liệu
Gồm 7 bảng chính và bảng cấu hình `fine_rules`:

`departments` · `roles` · `employees` · `shifts` · `schedules` · `attendance` · `payrolls` · `fine_rules`

- **`attendance`** có khóa chính `(employee_id, schedule_id)`: vừa liên kết nhân viên với lịch trực, vừa lưu chấm công thực tế.
- **`payrolls`** lưu snapshot lương cơ bản và phụ cấp tại kỳ lương, có trạng thái `draft` / `approved` / `paid`.
- **`fine_rules`** chứa mức phạt theo trạng thái chấm công, sửa số tiền bằng một lệnh `UPDATE`.
- **Trigger `trg_before_update_attendance`**: tự gán `on_time`, `late`, `early_leave`, `late_and_early`. So sánh cả ngày lẫn giờ nên ca đêm qua nửa đêm vẫn đúng.
- **Procedure `sp_CalculateMonthlyPayroll('YYYY-MM')`**: tính lương tháng, chạy lại được, giữ nguyên snapshot và không tính lại phiếu đã duyệt.

**Công thức lương:**
```
tiền ca    = (tổng hệ số các ca đã đi làm × lương cơ bản snapshot) / 30
thực nhận  = max(tiền ca + phụ cấp snapshot − tiền phạt, 0)
```

## Cấu trúc thư mục
```
hms/
├── public/
│   └── index.html      # Giao diện web
├── schema.sql          # Bảng, index, trigger, stored procedure
├── seed.js             # Dữ liệu mẫu
├── server.js           # API Express
├── .env.example        # Mẫu cấu hình
├── package.json
└── README.md
```

## API
Mọi API (trừ đăng nhập) cần header `Authorization: Bearer <token>`.

| Phương thức | Đường dẫn | Quyền | Mô tả |
|---|---|---|---|
| POST | `/api/login` | Tất cả | Đăng nhập, nhận token |
| GET | `/api/me` | Đã đăng nhập | Thông tin cá nhân |
| GET/POST/PUT/DELETE | `/api/employees`, `/api/departments`, `/api/roles`, `/api/shifts` | Đọc: tất cả; ghi: HR | CRUD danh mục |
| GET | `/api/schedule?from=&to=` | Đã đăng nhập | Lịch trực (nhân viên chỉ thấy của mình) |
| POST | `/api/schedule/assign` | HR | Phân ca, chặn trùng giờ |
| POST | `/api/attendance/checkin`, `/checkout` | Đã đăng nhập | Chấm công |
| POST | `/api/attendance/close-absent` | HR | Chốt vắng mặt các ca đã kết thúc |
| GET | `/api/attendance?from=&to=` | HR, Kế toán | Dữ liệu chấm công |
| POST | `/api/payroll/calculate` | HR, Kế toán | Tính lương tháng |
| GET | `/api/payroll?month=YYYY-MM` | Đã đăng nhập | Bảng lương |
| POST | `/api/payroll/approve-all`, `/api/payroll/:id/status` | Kế toán | Duyệt, đánh dấu đã trả |
| GET | `/api/reports/attendance?month=`, `/api/reports/cost` | HR, Kế toán | Báo cáo |

## Hạn chế và hướng phát triển
- `violation_type` chỉ lưu loại vi phạm, chưa có mức độ hoặc thời lượng.
- `schedules` chưa lưu nhu cầu nhân sự từng ca nên chưa cảnh báo thiếu người.
- Chưa có chức năng đổi mật khẩu và quản lý tài khoản riêng.
- Chưa có kiểm thử tự động.

## Giấy phép
Phát hành theo giấy phép [MIT](LICENSE).
