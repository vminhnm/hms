require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'doi-secret-nay-khi-deploy';
const TZ = process.env.TZ_OFFSET || '+07:00';

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'hospital_hr',
  timezone: TZ,          // Date <-> DATETIME theo giờ Việt Nam
  dateStrings: true,     // DATE/DATETIME trả về chuỗi
  decimalNumbers: true,  // DECIMAL trả về số
  connectionLimit: 10,
});
const q = async (sql, params) => (await db.query(sql, params))[0];

/* ---------- Tiện ích ---------- */
const S = (v) => (v == null ? v : String(v));
const hm = (t) => String(t).slice(0, 5);
const iso = (s) => (s ? new Date(String(s).replace(' ', 'T') + TZ).toISOString() : null);
const addDay = (date, n) => new Date(new Date(date + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
// Khoảng thời gian thực của ca; ca đêm (kết thúc <= bắt đầu) kết thúc vào ngày hôm sau
function interval(date, st, et) {
  const s = new Date(`${date}T${st}${TZ}`);
  let e = new Date(`${date}T${et}${TZ}`);
  if (e <= s) e = new Date(e.getTime() + 864e5);
  return [s, e];
}
const monthRange = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return [`${m}-01`, `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`];
};
const validMonth = (m) => /^\d{4}-\d{2}$/.test(m || '');

/* ---------- Ánh xạ dòng SQL -> JSON cho giao diện ---------- */
const EMP_SQL = `SELECT e.*, d.department_name, r.role_title FROM employees e
  JOIN departments d ON e.department_id = d.department_id JOIN roles r ON e.role_id = r.role_id`;
const mapEmp = (r) => ({
  _id: r.employee_id, code: r.employee_id, fullName: r.employee_full_name, dob: r.employee_dob, phone: r.employee_phone,
  department: { _id: S(r.department_id), name: r.department_name }, role: { _id: S(r.role_id), title: r.role_title },
  active: !!r.work_status, username: r.username, access: r.access_level,
});
const ATT_SQL = `SELECT a.*, e.employee_full_name, d.department_name, s.schedule_duty_date,
  sh.shift_name, sh.shift_start_time, sh.shift_end_time, sh.shift_multiplier
  FROM attendance a JOIN employees e ON a.employee_id = e.employee_id
  JOIN departments d ON e.department_id = d.department_id
  JOIN schedules s ON a.schedule_id = s.schedule_id JOIN shifts sh ON s.shift_id = sh.shift_id`;
const mapAtt = (r) => ({
  _id: `${r.employee_id}:${r.schedule_id}`,
  employee: { _id: r.employee_id, code: r.employee_id, fullName: r.employee_full_name, department: { name: r.department_name } },
  schedule: { _id: S(r.schedule_id), date: r.schedule_duty_date,
    shift: { name: r.shift_name, start: hm(r.shift_start_time), end: hm(r.shift_end_time), multiplier: r.shift_multiplier } },
  status: r.attendance_status, violation: r.violation_type, checkIn: iso(r.schedule_check_in), checkOut: iso(r.schedule_check_out),
});

/* ---------- App + xác thực ---------- */
const app = express();
app.use(express.json());
app.use(express.static('public'));

const auth = (...roles) => (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); }
  catch { return res.status(401).json({ error: 'Chưa đăng nhập hoặc phiên đã hết hạn' }); }
  if (roles.length && !roles.includes(req.user.access)) return res.status(403).json({ error: 'Không đủ quyền thực hiện' });
  next();
};

app.post('/api/login', async (req, res) => {
  const [u] = await q('SELECT * FROM employees WHERE username = ? AND work_status = 1', [req.body.username]);
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash || '')))
    return res.status(400).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  res.json({ token: jwt.sign({ id: u.employee_id, access: u.access_level }, SECRET, { expiresIn: '12h' }), access: u.access_level, name: u.employee_full_name });
});
app.get('/api/me', auth(), async (req, res) => {
  const [r] = await q(EMP_SQL + ' WHERE e.employee_id = ?', [req.user.id]);
  res.json(mapEmp(r));
});

/* ---------- CRUD danh mục ---------- */
function crud(path, table, pk, out, inn, listSql) {
  app.get(path, auth(), async (req, res) => res.json((await q(listSql || `SELECT * FROM ${table} ORDER BY ${pk} DESC`)).map(out)));
  app.post(path, auth('hr'), async (req, res) => { await q(`INSERT INTO ${table} SET ?`, [await inn(req.body, false)]); res.status(201).json({ ok: true }); });
  app.put(`${path}/:id`, auth('hr'), async (req, res) => { await q(`UPDATE ${table} SET ? WHERE ${pk} = ?`, [await inn(req.body, true), req.params.id]); res.json({ ok: true }); });
  app.delete(`${path}/:id`, auth('hr'), async (req, res) => { await q(`DELETE FROM ${table} WHERE ${pk} = ?`, [req.params.id]); res.json({ ok: true }); });
}
crud('/api/departments', 'departments', 'department_id',
  (r) => ({ _id: S(r.department_id), name: r.department_name }), async (b) => ({ department_name: b.name }));
crud('/api/roles', 'roles', 'role_id',
  (r) => ({ _id: S(r.role_id), title: r.role_title, baseRate: r.role_base_rate, allowance: r.role_allowance }),
  async (b) => ({ role_title: b.title, role_base_rate: b.baseRate, role_allowance: b.allowance || 0 }));
crud('/api/shifts', 'shifts', 'shift_id',
  (r) => ({ _id: S(r.shift_id), name: r.shift_name, start: hm(r.shift_start_time), end: hm(r.shift_end_time), multiplier: r.shift_multiplier }),
  async (b) => ({ shift_name: b.name, shift_start_time: b.start, shift_end_time: b.end, shift_multiplier: b.multiplier }));
crud('/api/employees', 'employees', 'employee_id', mapEmp, async (b, isUpdate) => {
  const d = { employee_full_name: b.fullName, employee_dob: b.dob || null, employee_phone: b.phone || null,
    department_id: b.department, role_id: b.role, work_status: b.active ? 1 : 0, username: b.username || null, access_level: b.access || 'employee' };
  if (!isUpdate) d.employee_id = b.code;
  if (b.password) d.password_hash = await bcrypt.hash(b.password, 10);
  return d;
}, EMP_SQL + ' ORDER BY e.employee_id');

/* ---------- Lịch trực ---------- */
app.get('/api/schedule', auth(), async (req, res) => {
  const mine = req.user.access === 'employee' || req.query.mine === '1';
  const rows = await q(`${ATT_SQL} WHERE s.schedule_duty_date BETWEEN ? AND ?${mine ? ' AND a.employee_id = ?' : ''}
    ORDER BY s.schedule_duty_date, sh.shift_start_time`, mine ? [req.query.from, req.query.to, req.user.id] : [req.query.from, req.query.to]);
  res.json(rows.map(mapAtt));
});

// Phân ca: tạo schedule nếu chưa có, gán nhân viên vào attendance (pending), chặn ca chồng giờ
app.post('/api/schedule/assign', auth('hr'), async (req, res) => {
  const { shiftId, date, employeeIds } = req.body;
  const [sh] = await q('SELECT * FROM shifts WHERE shift_id = ?', [shiftId]);
  if (!sh || !date || !employeeIds?.length) return res.status(400).json({ error: 'Thiếu ca, ngày hoặc nhân viên' });
  await q('INSERT IGNORE INTO schedules (shift_id, schedule_duty_date) VALUES (?, ?)', [shiftId, date]);
  const [{ schedule_id }] = await q('SELECT schedule_id FROM schedules WHERE shift_id = ? AND schedule_duty_date = ?', [shiftId, date]);
  const [ns, ne] = interval(date, sh.shift_start_time, sh.shift_end_time);
  const added = [], errors = [];
  for (const eid of employeeIds) {
    const [emp] = await q('SELECT employee_full_name, work_status FROM employees WHERE employee_id = ?', [eid]);
    if (!emp || !emp.work_status) { errors.push(`${eid}: không tồn tại hoặc đã nghỉ việc`); continue; }
    const mine = await q(`SELECT s.schedule_duty_date AS d, sh.shift_start_time AS st, sh.shift_end_time AS et
      FROM attendance a JOIN schedules s ON a.schedule_id = s.schedule_id JOIN shifts sh ON s.shift_id = sh.shift_id
      WHERE a.employee_id = ? AND s.schedule_id <> ? AND s.schedule_duty_date BETWEEN ? AND ?`, [eid, schedule_id, addDay(date, -1), addDay(date, 1)]);
    if (mine.some((m) => { const [s, e] = interval(m.d, m.st, m.et); return s < ne && ns < e; })) { errors.push(`${emp.employee_full_name}: trùng giờ với ca khác`); continue; }
    try { await q('INSERT INTO attendance (employee_id, schedule_id) VALUES (?, ?)', [eid, schedule_id]); added.push(emp.employee_full_name); }
    catch { errors.push(`${emp.employee_full_name}: đã được phân vào ca này`); }
  }
  res.json({ added, errors });
});
app.delete('/api/attendance/:id', auth('hr'), async (req, res) => {
  const [eid, sid] = req.params.id.split(':');
  const r = await q("DELETE FROM attendance WHERE employee_id = ? AND schedule_id = ? AND attendance_status = 'pending'", [eid, sid]);
  if (!r.affectedRows) return res.status(400).json({ error: 'Ca đã có dữ liệu chấm công, không thể xóa' });
  res.json({ ok: true });
});

/* ---------- Chấm công (phân loại do trigger trong MySQL đảm nhiệm) ---------- */
async function punch(req, res, col) {
  const hrManual = req.user.access === 'hr' && req.body.employeeId;
  const empId = hrManual ? req.body.employeeId : req.user.id;
  if (req.body.time && req.user.access !== 'hr') return res.status(403).json({ error: 'Chỉ HR được nhập giờ thủ công' });
  const [a] = await q(`${ATT_SQL} WHERE a.employee_id = ? AND a.schedule_id = ?`, [empId, req.body.scheduleId]);
  if (!a) return res.status(404).json({ error: 'Bạn không được phân vào ca này' });
  const [s, e] = interval(a.schedule_duty_date, a.shift_start_time, a.shift_end_time);
  const now = req.body.time ? new Date(req.body.time) : new Date();
  if (now < new Date(s - 2 * 36e5) || now > new Date(+e + 6 * 36e5)) return res.status(400).json({ error: 'Ngoài khung giờ chấm công của ca' });
  if (col === 'schedule_check_out' && !a.schedule_check_in) return res.status(400).json({ error: 'Chưa check-in' });
  if (a[col] && !req.body.time) return res.status(400).json({ error: 'Đã chấm công rồi' });
  await q(`UPDATE attendance SET ${col} = ? WHERE employee_id = ? AND schedule_id = ?`, [now, empId, req.body.scheduleId]);
  const [out] = await q(`${ATT_SQL} WHERE a.employee_id = ? AND a.schedule_id = ?`, [empId, req.body.scheduleId]);
  res.json(mapAtt(out));
}
app.post('/api/attendance/checkin', auth(), (req, res) => punch(req, res, 'schedule_check_in'));
app.post('/api/attendance/checkout', auth(), (req, res) => punch(req, res, 'schedule_check_out'));

// Chốt vắng: ca của ngày đã kết thúc mà chưa check-in
app.post('/api/attendance/close-absent', auth('hr'), async (req, res) => {
  const r = await q(`UPDATE attendance a JOIN schedules s ON a.schedule_id = s.schedule_id JOIN shifts sh ON s.shift_id = sh.shift_id
    SET a.attendance_status = 'absent', a.violation_type = 'Vắng mặt'
    WHERE s.schedule_duty_date = ? AND a.attendance_status = 'pending' AND a.schedule_check_in IS NULL
      AND TIMESTAMP(s.schedule_duty_date, sh.shift_end_time) + INTERVAL (sh.shift_end_time <= sh.shift_start_time) DAY <= ?`,
    [req.body.date, new Date()]);
  res.json({ marked: r.affectedRows });
});
app.get('/api/attendance', auth('hr', 'accountant'), async (req, res) => {
  res.json((await q(`${ATT_SQL} WHERE s.schedule_duty_date BETWEEN ? AND ?`, [req.query.from, req.query.to])).map(mapAtt));
});

/* ---------- Lương ---------- */
app.post('/api/payroll/calculate', auth('accountant', 'hr'), async (req, res) => {
  const { month } = req.body;
  if (!validMonth(month)) return res.status(400).json({ error: 'Tháng phải có dạng YYYY-MM' });
  await q('CALL sp_CalculateMonthlyPayroll(?)', [month]);
  const [c] = await q("SELECT SUM(payroll_status = 'draft') AS d, SUM(payroll_status <> 'draft') AS s FROM payrolls WHERE payroll_month_year = ?", [month]);
  res.json({ calculated: Number(c.d || 0), skipped: Number(c.s || 0) });
});
app.get('/api/payroll', auth(), async (req, res) => {
  const mine = req.user.access === 'employee';
  const rows = await q(`SELECT p.*, e.employee_full_name, d.department_name FROM payrolls p
    JOIN employees e ON p.employee_id = e.employee_id JOIN departments d ON e.department_id = d.department_id
    WHERE p.payroll_month_year = ?${mine ? ' AND p.employee_id = ?' : ''}`, mine ? [req.query.month, req.user.id] : [req.query.month]);
  res.json(rows.map((p) => ({
    _id: S(p.payroll_id), employee: { code: p.employee_id, fullName: p.employee_full_name, department: { name: p.department_name } },
    totalShiftPay: p.payroll_total_shift_pay, allowanceSnapshot: p.payroll_allowance_snapshot, totalFines: p.payroll_total_fines,
    netSalary: p.payroll_net_salary, status: p.payroll_status,
  })));
});
app.post('/api/payroll/approve-all', auth('accountant'), async (req, res) => {
  const r = await q("UPDATE payrolls SET payroll_status = 'approved' WHERE payroll_month_year = ? AND payroll_status = 'draft'", [req.body.month]);
  res.json({ approved: r.affectedRows });
});
app.post('/api/payroll/:id/status', auth('accountant'), async (req, res) => {
  const from = { approved: 'draft', paid: 'approved' }[req.body.status];
  if (!from) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  const r = await q('UPDATE payrolls SET payroll_status = ? WHERE payroll_id = ? AND payroll_status = ?', [req.body.status, req.params.id, from]);
  if (!r.affectedRows) return res.status(400).json({ error: 'Không thể chuyển trạng thái này' });
  res.json({ ok: true });
});

/* ---------- Báo cáo ---------- */
app.get('/api/reports/attendance', auth('hr', 'accountant'), async (req, res) => {
  if (!validMonth(req.query.month)) return res.status(400).json({ error: 'Tháng không hợp lệ' });
  const range = monthRange(req.query.month);
  const base = `FROM attendance a JOIN employees e ON a.employee_id = e.employee_id
    JOIN departments d ON e.department_id = d.department_id JOIN schedules s ON a.schedule_id = s.schedule_id
    WHERE s.schedule_duty_date BETWEEN ? AND ?`;   // dùng BETWEEN để tận dụng idx_sch_date
  const deps = await q(`SELECT d.department_name AS department, COUNT(*) AS total,
    SUM(a.attendance_status = 'on_time') AS on_time, SUM(a.attendance_status = 'late') AS late,
    SUM(a.attendance_status = 'early_leave') AS early_leave, SUM(a.attendance_status = 'late_and_early') AS late_and_early,
    SUM(a.attendance_status = 'absent') AS absent ${base} GROUP BY d.department_id, d.department_name ORDER BY d.department_name`, range);
  const vio = await q(`SELECT e.employee_full_name AS name, d.department_name AS department, COUNT(*) AS cnt,
    SUM(COALESCE(f.fine_amount, 0)) AS fines
    FROM attendance a JOIN employees e ON a.employee_id = e.employee_id JOIN departments d ON e.department_id = d.department_id
    JOIN schedules s ON a.schedule_id = s.schedule_id LEFT JOIN fine_rules f ON f.attendance_status = a.attendance_status
    WHERE a.violation_type IS NOT NULL AND s.schedule_duty_date BETWEEN ? AND ?
    GROUP BY e.employee_id, e.employee_full_name, d.department_name ORDER BY cnt DESC LIMIT 10`, range);
  const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : Number(v)]));
  res.json({ departments: deps.map(num), violators: vio.map((v) => ({ name: v.name, department: v.department, count: Number(v.cnt), fines: Number(v.fines) })) });
});
app.get('/api/reports/cost', auth('hr', 'accountant'), async (req, res) => {
  const rows = await q(`SELECT payroll_month_year AS m, COUNT(DISTINCT employee_id) AS n, SUM(payroll_net_salary) AS total,
    AVG(payroll_net_salary) AS av, MAX(payroll_net_salary) AS mx, MIN(payroll_net_salary) AS mn
    FROM payrolls GROUP BY payroll_month_year ORDER BY payroll_month_year DESC`);
  res.json(rows.map((r) => ({ _id: r.m, employees: Number(r.n), total: Number(r.total), avg: Number(r.av), max: Number(r.mx), min: Number(r.mn) })));
});

app.use((err, req, res, next) => {
  const map = {
    ER_DUP_ENTRY: 'Dữ liệu bị trùng (mã, số điện thoại, tên đăng nhập hoặc tên đã tồn tại)',
    ER_ROW_IS_REFERENCED_2: 'Bản ghi đang được sử dụng ở nơi khác nên không thể xóa',
    ER_NO_REFERENCED_ROW_2: 'Khoa/phòng hoặc vai trò được chọn không tồn tại',
    ER_CHECK_CONSTRAINT_VIOLATED: 'Dữ liệu không hợp lệ (ví dụ giờ ra phải sau giờ vào)',
  };
  console.error(err.code || '', err.message);
  res.status(400).json({ error: map[err.code] || err.sqlMessage || err.message });
});

const port = process.env.PORT || 3000;
db.query('SELECT 1').then(() => app.listen(port, () => console.log('Chạy tại http://localhost:' + port)))
  .catch((e) => { console.error('Không kết nối được MySQL:', e.message); process.exit(1); });
