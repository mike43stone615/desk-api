-- Invoice numbers: one running number per invoice (1, 2, 3 ...), never reused, shown as INV-000001.
--
-- Until now the "number" on an invoice was the first 8 characters of its random id, which is unique in practice but says
-- nothing about order. A sequence hands out each number once. A number can be skipped (for example when generating a month
-- finds the invoice already made), but is never given twice, so two documents can never carry the same number.
--
-- Existing invoices are numbered in the order they were made (period, then creation time, then id).
--
-- Rollback: ALTER TABLE invoices DROP COLUMN number; DROP SEQUENCE invoice_number_seq;
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS number BIGINT;

UPDATE invoices i SET number = n.rn
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY period_start, created_at, id) AS rn FROM invoices WHERE number IS NULL) n
 WHERE i.id = n.id
   AND NOT EXISTS (SELECT 1 FROM invoices WHERE number IS NOT NULL);

SELECT setval('invoice_number_seq', GREATEST((SELECT COALESCE(MAX(number), 0) FROM invoices), 1), (SELECT COUNT(*) > 0 FROM invoices WHERE number IS NOT NULL));

ALTER TABLE invoices ALTER COLUMN number SET DEFAULT nextval('invoice_number_seq');
UPDATE invoices SET number = nextval('invoice_number_seq') WHERE number IS NULL;
ALTER TABLE invoices ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_number_key ON invoices (number);
