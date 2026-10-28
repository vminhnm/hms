-- Chạy: mysql -u root -p < schema.sql   (cần MySQL 8.0.16+ để CHECK có hiệu lực)
CREATE DATABASE IF NOT EXISTS hospital_hr CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE hospital_hr;

CREATE TABLE departments (
  department_id INT NOT NULL AUTO_INCREMENT,
  department_name VARCHAR(100) NOT NULL,
  PRIMARY KEY (department_id),
  UNIQUE KEY uq_dept_name (department_name)
) ENGINE=InnoDB;

CREATE TABLE roles (
  role_id INT NOT NULL AUTO_INCREMENT,
  role_title VARCHAR(100) NOT NULL,
  role_base_rate DECIMAL(15,2) NOT NULL,
  role_allowance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (role_id)
) ENGINE=InnoDB;

CREATE TABLE employees (
  employee_id VARCHAR(20) NOT NULL,
  employee_full_name VARCHAR(100) NOT NULL,
  employee_dob DATE,
  employee_phone VARCHAR(15) UNIQUE,
  department_id INT NOT NULL,
  role_id INT NOT NULL,
  work_status TINYINT(1) NOT NULL DEFAULT 1,
  -- Bổ sung để khắc phục hạn chế "chưa có tài khoản/phân quyền"
  username VARCHAR(50) UNIQUE,
  password_hash VARCHAR(100),
  access_level ENUM('employee','hr','accountant') NOT NULL DEFAULT 'employee',
  PRIMARY KEY (employee_id),
  CONSTRAINT fk_emp_dept FOREIGN KEY (department_id) REFERENCES departments(department_id),
  CONSTRAINT fk_emp_role FOREIGN KEY (role_id) REFERENCES roles(role_id)
) ENGINE=InnoDB;

CREATE TABLE shifts (
  shift_id INT NOT NULL AUTO_INCREMENT,
  shift_name VARCHAR(50) NOT NULL,
  shift_start_time TIME NOT NULL,
  shift_end_time TIME NOT NULL,
  shift_multiplier DECIMAL(3,2) NOT NULL DEFAULT 1.00,
  PRIMARY KEY (shift_id)
) ENGINE=InnoDB;

CREATE TABLE schedules (
  schedule_id INT NOT NULL AUTO_INCREMENT,
  shift_id INT NOT NULL,
  schedule_duty_date DATE NOT NULL,
  PRIMARY KEY (schedule_id),
  UNIQUE KEY uq_shift_date (shift_id, schedule_duty_date),   -- không tạo trùng ca trong ngày
  CONSTRAINT fk_sch_shift FOREIGN KEY (shift_id) REFERENCES shifts(shift_id)
) ENGINE=InnoDB;

CREATE TABLE attendance (
  employee_id VARCHAR(20) NOT NULL,
  schedule_id INT NOT NULL,
  attendance_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  violation_type VARCHAR(100),
  schedule_check_in DATETIME,
  schedule_check_out DATETIME,
  PRIMARY KEY (employee_id, schedule_id),
  CONSTRAINT fk_att_sch FOREIGN KEY (schedule_id) REFERENCES schedules(schedule_id),
  CONSTRAINT fk_att_emp FOREIGN KEY (employee_id) REFERENCES employees(employee_id),
  CONSTRAINT ck_att_status CHECK (attendance_status IN ('pending','on_time','late','early_leave','late_and_early','absent')),
  CONSTRAINT ck_att_time CHECK (schedule_check_in IS NULL OR schedule_check_out IS NULL OR schedule_check_out > schedule_check_in)
) ENGINE=InnoDB;

-- Mức phạt cấu hình trong bảng (thay cho số hard-code 200000/300000)
CREATE TABLE fine_rules (
  attendance_status VARCHAR(30) NOT NULL,
  fine_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (attendance_status)
) ENGINE=InnoDB;
INSERT INTO fine_rules VALUES ('late',200000),('early_leave',200000),('late_and_early',300000),('absent',0);

CREATE TABLE payrolls (
  payroll_id INT NOT NULL AUTO_INCREMENT,
  employee_id VARCHAR(20) NOT NULL,
  payroll_month_year VARCHAR(7) NOT NULL,
  payroll_total_shift_pay DECIMAL(15,2) DEFAULT 0.00,
  payroll_allowance_snapshot DECIMAL(15,2) DEFAULT 0.00,
  payroll_base_rate_snapshot DECIMAL(15,2) DEFAULT 0.00,
  payroll_total_fines DECIMAL(15,2) DEFAULT 0.00,
  payroll_net_salary DECIMAL(15,2) DEFAULT 0.00,
  payroll_status ENUM('draft','approved','paid') NOT NULL DEFAULT 'draft',  -- khắc phục hạn chế trạng thái lương
  PRIMARY KEY (payroll_id),
  UNIQUE KEY uq_payroll (employee_id, payroll_month_year),
  CONSTRAINT fk_pay_emp FOREIGN KEY (employee_id) REFERENCES employees(employee_id),
  CONSTRAINT ck_pay_month CHECK (payroll_month_year REGEXP '^[0-9]{4}-[0-9]{2}$')
) ENGINE=InnoDB;

-- Index (FK đã tự có index; idx_att_emp cũ bị bỏ vì khóa chính đã phủ)
CREATE INDEX idx_sch_date ON schedules (schedule_duty_date);
CREATE INDEX idx_att_sch ON attendance (schedule_id);
CREATE INDEX idx_pay_month ON payrolls (payroll_month_year);

DELIMITER //

-- Trigger phân loại chấm công: so sánh DATETIME đầy đủ nên ca đêm qua nửa đêm vẫn đúng.
-- Khi chưa có check-in thì giữ nguyên trạng thái (pending, hoặc absent do HR chốt).
CREATE TRIGGER trg_before_update_attendance
BEFORE UPDATE ON attendance
FOR EACH ROW
BEGIN
  DECLARE v_date DATE;
  DECLARE v_st TIME;
  DECLARE v_et TIME;
  DECLARE v_start DATETIME;
  DECLARE v_end DATETIME;
  DECLARE v_late BOOLEAN DEFAULT FALSE;
  DECLARE v_early BOOLEAN DEFAULT FALSE;

  IF NEW.schedule_check_in IS NOT NULL THEN
    SELECT s.schedule_duty_date, sh.shift_start_time, sh.shift_end_time
      INTO v_date, v_st, v_et
      FROM schedules s JOIN shifts sh ON s.shift_id = sh.shift_id
     WHERE s.schedule_id = NEW.schedule_id;

    SET v_start = TIMESTAMP(v_date, v_st);
    SET v_end   = TIMESTAMP(v_date, v_et);
    IF v_et <= v_st THEN SET v_end = v_end + INTERVAL 1 DAY; END IF;

    SET v_late  = NEW.schedule_check_in > v_start;
    SET v_early = NEW.schedule_check_out IS NOT NULL AND NEW.schedule_check_out < v_end;

    IF v_late AND v_early THEN
      SET NEW.attendance_status = 'late_and_early', NEW.violation_type = 'Đi muộn và về sớm';
    ELSEIF v_late THEN
      SET NEW.attendance_status = 'late', NEW.violation_type = 'Đi muộn';
    ELSEIF v_early THEN
      SET NEW.attendance_status = 'early_leave', NEW.violation_type = 'Về sớm';
    ELSE
      SET NEW.attendance_status = 'on_time', NEW.violation_type = NULL;
    END IF;
  END IF;
END //

-- Tính lương tháng. Chạy lại được: giữ snapshot cũ, chỉ cập nhật phiếu còn 'draft'.
-- Chỉ tính ca đã đi làm (không tính pending/absent); mức phạt lấy từ fine_rules.
CREATE PROCEDURE sp_CalculateMonthlyPayroll(IN p_month VARCHAR(7))
BEGIN
  DECLARE v_start DATE;
  DECLARE v_end DATE;
  SET v_start = STR_TO_DATE(CONCAT(p_month, '-01'), '%Y-%m-%d');
  SET v_end = LAST_DAY(v_start);

  INSERT INTO payrolls (employee_id, payroll_month_year, payroll_base_rate_snapshot, payroll_allowance_snapshot)
  SELECT e.employee_id, p_month, r.role_base_rate, r.role_allowance
    FROM employees e JOIN roles r ON e.role_id = r.role_id
   WHERE e.work_status = 1
  ON DUPLICATE KEY UPDATE payroll_id = payroll_id;

  UPDATE payrolls p
  LEFT JOIN (
    SELECT a.employee_id,
           SUM(CASE WHEN a.attendance_status IN ('on_time','late','early_leave','late_and_early')
                    THEN sh.shift_multiplier ELSE 0 END) AS total_mult,
           SUM(COALESCE(f.fine_amount, 0)) AS total_fines
      FROM attendance a
      JOIN schedules s ON a.schedule_id = s.schedule_id
      JOIN shifts sh ON s.shift_id = sh.shift_id
      LEFT JOIN fine_rules f ON f.attendance_status = a.attendance_status
     WHERE s.schedule_duty_date BETWEEN v_start AND v_end
     GROUP BY a.employee_id
  ) att ON p.employee_id = att.employee_id
  SET p.payroll_total_shift_pay = ROUND(COALESCE(att.total_mult, 0) * p.payroll_base_rate_snapshot / 30, 0),
      p.payroll_total_fines = COALESCE(att.total_fines, 0),
      p.payroll_net_salary = GREATEST(
        ROUND(COALESCE(att.total_mult, 0) * p.payroll_base_rate_snapshot / 30, 0)
        + p.payroll_allowance_snapshot - COALESCE(att.total_fines, 0), 0)
  WHERE p.payroll_month_year = p_month AND p.payroll_status = 'draft';
END //

DELIMITER ;
