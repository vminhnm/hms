# Quản lý nhân sự bệnh viện (Node.js + MySQL)

## Chạy
1. Cài Node.js 18+ và MySQL 8.0.16+.
2. Tạo CSDL, bảng, trigger, procedure: `mysql -u root -p < schema.sql`
   (hoặc mở schema.sql trong MySQL Workbench rồi Execute).
3. `cp .env.example .env` và điền `DB_PASSWORD`, `JWT_SECRET`.
4. `npm install`, `npm run seed` (dữ liệu mẫu), `npm start` → http://localhost:3000
Tài khoản mẫu (mật khẩu 123456): `hr`, `ketoan`, `nv001`.

## Phân vai
- MySQL: bảng, ràng buộc, trigger phân loại chấm công, procedure tính lương, bảng fine_rules.
- Node.js (server.js): API, đăng nhập JWT, phân quyền, kiểm tra ca chồng giờ, gọi procedure.
- public/index.html: giao diện, gọi API.

## Sửa so với SQL trong báo cáo
- Trigger so sánh DATETIME đầy đủ nên ca đêm đúng; không đổi trạng thái khi chưa có check-in.
- Vắng mặt chỉ chốt khi ca đã kết thúc (nút "Chốt vắng mặt").
- Procedure chỉ tính ca đã đi làm, lấy mức phạt từ fine_rules, không tính lại phiếu đã duyệt.
- Thêm username/password_hash/access_level, payroll_status, CHECK và UNIQUE (shift_id, ngày).
- Bỏ idx_att_emp (thừa); báo cáo dùng BETWEEN thay DATE_FORMAT để dùng được index.
