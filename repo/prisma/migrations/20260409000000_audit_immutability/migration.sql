-- Audit log immutability — DB-level append-only enforcement.
--
-- The audit log is the system of record for who-did-what-when. Even an
-- attacker (or a buggy code path) holding the application DB credentials must
-- not be able to UPDATE or DELETE rows in audit_logs. We enforce this with
-- BEFORE-row triggers that raise SQLSTATE 45000 (a generic user-defined
-- exception) for any UPDATE or DELETE attempt.
--
-- INSERTs are unaffected, so the application keeps appending normally.
--
-- Single-statement trigger bodies are used so the migration runner does not
-- need DELIMITER directives.

DROP TRIGGER IF EXISTS audit_logs_no_update;
DROP TRIGGER IF EXISTS audit_logs_no_delete;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'audit_logs is append-only — UPDATE is forbidden';

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'audit_logs is append-only — DELETE is forbidden';
