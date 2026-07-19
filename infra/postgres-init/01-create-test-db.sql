-- Runs on first init of the pgdata volume only. The integration suites
-- TRUNCATE shared tables, so they get their own database — never the
-- dev-world `empire` db (tests read TEST_DATABASE_URL, not DATABASE_URL).
CREATE DATABASE empire_test OWNER empire;
