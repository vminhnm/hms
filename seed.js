// Nạp dữ liệu mẫu (chạy sau khi đã chạy schema.sql): npm run seed
require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
(async () => {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'hospital_hr',
  });
  const [[{ n }]] = await db.query('SELECT COUNT(*) n FROM employees');
  if (n) { console.log('Đã có dữ liệu, bỏ qua.'); return db.end(); }
  await db.query("INSERT INTO departments (department_name) VALUES ('Khoa Nội'),('Khoa Cấp cứu'),('Phòng Nhân sự')");
  await db.query(`INSERT INTO roles (role_title, role_base_rate, role_allowance) VALUES
    ('Bác sĩ',20000000,3000000),('Điều dưỡng',12000000,1000000),('Nhân viên hành chính',10000000,500000)`);
  await db.query(`INSERT INTO shifts (shift_name, shift_start_time, shift_end_time, shift_multiplier) VALUES
    ('Ca sáng','07:00','15:00',1.00),('Ca chiều','15:00','23:00',1.20),('Ca đêm','23:00','07:00',1.50)`);
  const pw = await bcrypt.hash('123456', 10);
  await db.query(`INSERT INTO employees (employee_id, employee_full_name, department_id, role_id, username, password_hash, access_level) VALUES ?`, [[
    ['NV001', 'Nguyễn Văn An', 1, 1, 'nv001', pw, 'employee'],
    ['NV002', 'Trần Thị Bình', 2, 2, 'nv002', pw, 'employee'],
    ['HR01', 'Lê Hoàng Nhân sự', 3, 3, 'hr', pw, 'hr'],
    ['KT01', 'Phạm Kế Toán', 3, 3, 'ketoan', pw, 'accountant'],
  ]]);
  console.log('Đã tạo dữ liệu mẫu. Tài khoản: hr / ketoan / nv001 — mật khẩu 123456');
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
