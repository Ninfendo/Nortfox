-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0009 the roles and the programs: the permission catalogue, the programs
-- granted to the members of a company, the program administrators, and the
-- people of a company. See db/README.md, the schema access, and decisions
-- 0002, 0008 and 0009 in docs/decisions/.
--
-- The catalogue is install-wide and public: the programs, the groups, the
-- permissions and each program's set, as the contract holds them
-- (packages/contract/src/access/catalogue.ts), seeded here. The grants and
-- the program administrators are company tables: they follow every rule of
-- a company table, the history trigger among them, so every grant, change,
-- move and withdrawal of a program, and every appointment and removal of a
-- program administrator, is in the behandlingshistorik, the history of
-- rights that no role changes.

-- Two refusals ------------------------------------------------------------------
--
-- view_permission_missing: a grant holds an action right of a group without
-- the group's view right (open point 4). not_in_program: a grant holds a
-- right that its program does not. The list gets them in their places by
-- code.
CREATE OR REPLACE FUNCTION ledger.refusal_reasons() RETURNS TABLE (reason text, code text)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT v.column1, v.column2
  FROM (VALUES
    ('unbalanced', 'NF001'),
    ('too_few_rows', 'NF002'),
    ('account_missing', 'NF003'),
    ('account_inactive', 'NF004'),
    ('series_missing', 'NF005'),
    ('series_not_manual', 'NF006'),
    ('no_fiscal_year', 'NF007'),
    ('date_outside_fiscal_year', 'NF008'),
    ('description_missing', 'NF009'),
    ('value_too_long', 'NF010'),
    ('period_locked_manual', 'NF011'),
    ('period_locked_automatic', 'NF012'),
    ('not_last_in_series', 'NF013'),
    ('reversing_voucher_exists', 'NF014'),
    ('reversing_other_module', 'NF015'),
    ('account_has_rows', 'NF016'),
    ('series_code_invalid', 'NF017'),
    ('series_code_duplicate', 'NF018'),
    ('series_code_changed', 'NF019'),
    ('immutable_field', 'NF020'),
    ('install_not_empty', 'NF021'),
    ('last_system_administrator', 'NF022'),
    ('view_permission_missing', 'NF023'),
    ('not_in_program', 'NF024'),
    ('actor_missing', 'NF050'),
    ('append_only', 'NF051'),
    ('internal_only', 'NF052'),
    ('row_removal', 'NF053'),
    ('counter_move', 'NF054'),
    ('void_range_not_at_counter', 'NF055'),
    ('period_outside_fiscal_year', 'NF056'),
    ('fiscal_year_strands_rows', 'NF057'),
    ('read_committed_only', 'NF058')
  ) AS v
  ORDER BY v.column2;
END;

-- The catalogue -------------------------------------------------------------------
--
-- The programs, each with its screen words and the days after which its
-- grant ends by itself, if it does: a Revisor grant 30 days after it is
-- granted (open point 3). The groups, each a Bokföring group of a program's
-- own rights, Rapporter, or Register/Övrigt. The permissions, each in its
-- group, with its screen words; the first of a Bokföring group is its view
-- right, which every other permission of the group needs, and a Rapporter or
-- Register/Övrigt switch stands alone; a manual-only right is only switched
-- on by hand. Each program's set: the rights it may grant, and whether "Full
-- behörighet" holds each one. Each table keeps the catalogue's order in
-- `position`, from 1. They are public install-wide tables: the app reads
-- every row and writes none, and a reader reads none. Only a migration
-- changes them.
CREATE TABLE access.catalogue_programs (
  program text PRIMARY KEY CONSTRAINT catalogue_programs_program_form CHECK (program ~ '^[a-z]+(-[a-z]+)*$'),
  position integer NOT NULL CONSTRAINT catalogue_programs_position_key UNIQUE,
  label text NOT NULL,
  lifetime_days integer CONSTRAINT catalogue_programs_lifetime_positive CHECK (lifetime_days > 0)
);

CREATE TABLE access.catalogue_groups (
  group_key text PRIMARY KEY CONSTRAINT catalogue_groups_group_key_form CHECK (group_key ~ '^[a-z]+(-[a-z]+)*$'),
  position integer NOT NULL CONSTRAINT catalogue_groups_position_key UNIQUE,
  kind text NOT NULL CONSTRAINT catalogue_groups_kind_known CHECK (kind IN ('program', 'reports', 'register')),
  label text NOT NULL
);

CREATE TABLE access.catalogue_permissions (
  permission text PRIMARY KEY CONSTRAINT catalogue_permissions_permission_form CHECK (permission ~ '^[a-z]+(-[a-z]+)*[.][a-z0-9]+(-[a-z0-9]+)*$'),
  position integer NOT NULL CONSTRAINT catalogue_permissions_position_key UNIQUE,
  group_key text NOT NULL REFERENCES access.catalogue_groups (group_key),
  label text NOT NULL,
  is_view boolean NOT NULL,
  manual_only boolean NOT NULL,
  CONSTRAINT catalogue_permissions_view_by_hand CHECK (NOT (is_view AND manual_only))
);
-- A group has one view right at most.
CREATE UNIQUE INDEX catalogue_permissions_one_view ON access.catalogue_permissions (group_key) WHERE is_view;

CREATE TABLE access.catalogue_program_permissions (
  program text NOT NULL REFERENCES access.catalogue_programs (program),
  permission text NOT NULL REFERENCES access.catalogue_permissions (permission),
  in_full boolean NOT NULL,
  CONSTRAINT catalogue_program_permissions_pkey PRIMARY KEY (program, permission)
);

-- The catalogue's rows, as the contract holds them, in its order.
INSERT INTO access.catalogue_programs (program, position, label, lifetime_days) VALUES
  ('bookkeeping', 1, 'Bokföring', NULL),
  ('approval-read', 2, 'Bokföring - Attest & Läs', NULL),
  ('read', 3, 'Läs', NULL),
  ('auditor', 4, 'Revisor', 30);

INSERT INTO access.catalogue_groups (group_key, position, kind, label) VALUES
  ('vouchers', 1, 'program', 'Verifikationer'),
  ('supplier-invoices', 2, 'program', 'Leverantörsfakturor'),
  ('reports', 3, 'reports', 'Rapporter'),
  ('register', 4, 'register', 'Register/Övrigt');

INSERT INTO access.catalogue_permissions (permission, position, group_key, label, is_view, manual_only) VALUES
  ('vouchers.view', 1, 'vouchers', 'Verifikationer', true, false),
  ('vouchers.book', 2, 'vouchers', 'Bokför', false, false),
  ('vouchers.delete', 3, 'vouchers', 'Radera', false, false),
  ('vouchers.alter', 4, 'vouchers', 'Ändra', false, false),
  ('vouchers.accrue', 5, 'vouchers', 'Periodisera', false, false),
  ('vouchers.created-by', 6, 'vouchers', 'Se skapad av/ändrad av', false, false),
  ('vouchers.cash-register', 7, 'vouchers', 'Registrera dagskassa', false, false),
  ('vouchers.receipts', 8, 'vouchers', 'Registrera kvitton', false, false),
  ('vouchers.accruals', 9, 'vouchers', 'Periodiseringar', false, false),
  ('vouchers.run-accruals-vouchers', 10, 'vouchers', 'Utföra periodiseringar verifikationer', false, false),
  ('vouchers.run-accruals-supplier-invoices', 11, 'vouchers', 'Utföra periodiseringar leverantörsfakturor', false, false),
  ('vouchers.run-accruals-customer-invoices', 12, 'vouchers', 'Utföra periodiseringar kundfakturor', false, false),
  ('vouchers.reconcile', 13, 'vouchers', 'Stäm av konto', false, false),
  ('vouchers.delete-bank-transactions', 14, 'vouchers', 'Ta bort banktransaktioner', false, false),
  ('vouchers.search-amount', 15, 'vouchers', 'Sök belopp', false, false),
  ('vouchers.settings', 16, 'vouchers', 'Inställningar', false, false),
  ('vouchers.lock-period', 17, 'vouchers', 'Låsa period', false, false),
  ('vouchers.approve-own-series', 18, 'vouchers', 'Se /attestera verifikationsserie där användaren är attestant', false, false),
  ('vouchers.see-all-series', 19, 'vouchers', 'Se samtliga verifikationsserier', false, false),
  ('supplier-invoices.view', 20, 'supplier-invoices', 'Leverantörsfakturor', true, false),
  ('supplier-invoices.save', 21, 'supplier-invoices', 'Spara', false, false),
  ('supplier-invoices.book', 22, 'supplier-invoices', 'Bokför', false, false),
  ('supplier-invoices.void', 23, 'supplier-invoices', 'Makulera', false, false),
  ('supplier-invoices.payment-file', 24, 'supplier-invoices', 'Betalfil', false, false),
  ('supplier-invoices.undo-payment-file', 25, 'supplier-invoices', 'Ångra betalfil', false, false),
  ('supplier-invoices.accrue', 26, 'supplier-invoices', 'Periodisera', false, false),
  ('supplier-invoices.delete-attachments', 27, 'supplier-invoices', 'Ta bort kopplade bilder', false, false),
  ('supplier-invoices.created-by', 28, 'supplier-invoices', 'Se skapad av / ändrad av', false, false),
  ('supplier-invoices.inbox', 29, 'supplier-invoices', 'Inkomna fakturor /dokument', false, false),
  ('supplier-invoices.send-for-interpretation', 30, 'supplier-invoices', 'Skicka för tolkning', false, false),
  ('supplier-invoices.disbursements', 31, 'supplier-invoices', 'Utbetalningar', false, false),
  ('supplier-invoices.settings', 32, 'supplier-invoices', 'Inställningar', false, false),
  ('reports.balance-sheet', 33, 'reports', 'Balansrapport', false, false),
  ('reports.deleted-vouchers', 34, 'reports', 'Borttagna verifikationer', false, false),
  ('reports.general-ledger', 35, 'reports', 'Huvudbok', false, false),
  ('reports.opening-balance', 36, 'reports', 'Ingående balans', false, false),
  ('reports.account-analysis', 37, 'reports', 'Kontoanalys', false, false),
  ('reports.liquidity', 38, 'reports', 'Likviditetsrapport', false, false),
  ('reports.vat', 39, 'reports', 'Momsrapport', false, false),
  ('reports.accruals', 40, 'reports', 'Periodiseringar', false, false),
  ('reports.periodic-summary', 41, 'reports', 'Periodisk sammanställning (kvartalsrapport)', false, false),
  ('reports.project-accounting', 42, 'reports', 'Projektredovisning', false, false),
  ('reports.budget', 43, 'reports', 'Resultatbudget', false, false),
  ('reports.income-statement', 44, 'reports', 'Resultatrapport', false, false),
  ('reports.income-statement-12-months', 45, 'reports', 'Resultatrapport 12 månader', false, false),
  ('reports.income-statement-advanced', 46, 'reports', 'Resultatrapport avancerad', false, false),
  ('reports.system-documentation', 47, 'reports', 'Systemdokumentation', false, false),
  ('reports.voucher-list', 48, 'reports', 'Verifikationslista', false, false),
  ('reports.show-struck-rows', 49, 'reports', 'Visa strukna rader', false, false),
  ('reports.processing-history', 50, 'reports', 'Behandlingshistoriken', false, false),
  ('reports.supplier-invoices', 51, 'reports', 'Leverantörsfakturor', false, false),
  ('reports.supplier-statistics', 52, 'reports', 'Leverantörsstatistik', false, false),
  ('reports.supplier-ledger', 53, 'reports', 'Reskontralista - Leverantörsfakturor', false, false),
  ('reports.supplier-due-list', 54, 'reports', 'Förfallolista - Leverantörsfakturor', false, false),
  ('register.suppliers', 55, 'register', 'Leverantörer', false, false),
  ('register.chart-of-accounts', 56, 'register', 'Kontoplan', false, false),
  ('register.cost-centres', 57, 'register', 'Kostnadsställen', false, false),
  ('register.projects', 58, 'register', 'Projekt', false, false),
  ('register.sie-export', 59, 'register', 'Sie-export', false, false),
  ('register.sie-import', 60, 'register', 'Sie-import', false, false),
  ('register.export-files', 61, 'register', 'Exportera filer', false, false),
  ('register.anonymise-fiscal-year', 62, 'register', 'Anonymisera räkenskapsår', false, true),
  ('register.removed-users', 63, 'register', 'Hantera borttagna användare', false, true),
  ('register.delete-processing-history', 64, 'register', 'Radera behandlingshistorik', false, true);

-- Bokföring: 55 in Full behörighet, 3 by hand.
INSERT INTO access.catalogue_program_permissions (program, permission, in_full) VALUES
  ('bookkeeping', 'vouchers.view', true),
  ('bookkeeping', 'vouchers.book', true),
  ('bookkeeping', 'vouchers.delete', true),
  ('bookkeeping', 'vouchers.alter', true),
  ('bookkeeping', 'vouchers.accrue', true),
  ('bookkeeping', 'vouchers.created-by', true),
  ('bookkeeping', 'vouchers.cash-register', true),
  ('bookkeeping', 'vouchers.receipts', true),
  ('bookkeeping', 'vouchers.accruals', true),
  ('bookkeeping', 'vouchers.run-accruals-vouchers', true),
  ('bookkeeping', 'vouchers.run-accruals-supplier-invoices', true),
  ('bookkeeping', 'vouchers.run-accruals-customer-invoices', true),
  ('bookkeeping', 'vouchers.reconcile', true),
  ('bookkeeping', 'vouchers.delete-bank-transactions', true),
  ('bookkeeping', 'vouchers.search-amount', true),
  ('bookkeeping', 'vouchers.settings', true),
  ('bookkeeping', 'vouchers.lock-period', true),
  ('bookkeeping', 'supplier-invoices.view', true),
  ('bookkeeping', 'supplier-invoices.save', true),
  ('bookkeeping', 'supplier-invoices.book', true),
  ('bookkeeping', 'supplier-invoices.void', true),
  ('bookkeeping', 'supplier-invoices.payment-file', true),
  ('bookkeeping', 'supplier-invoices.undo-payment-file', true),
  ('bookkeeping', 'supplier-invoices.accrue', true),
  ('bookkeeping', 'supplier-invoices.delete-attachments', true),
  ('bookkeeping', 'supplier-invoices.created-by', true),
  ('bookkeeping', 'supplier-invoices.inbox', true),
  ('bookkeeping', 'supplier-invoices.send-for-interpretation', true),
  ('bookkeeping', 'supplier-invoices.disbursements', true),
  ('bookkeeping', 'supplier-invoices.settings', true),
  ('bookkeeping', 'reports.balance-sheet', true),
  ('bookkeeping', 'reports.deleted-vouchers', true),
  ('bookkeeping', 'reports.general-ledger', true),
  ('bookkeeping', 'reports.opening-balance', true),
  ('bookkeeping', 'reports.account-analysis', true),
  ('bookkeeping', 'reports.liquidity', true),
  ('bookkeeping', 'reports.vat', true),
  ('bookkeeping', 'reports.accruals', true),
  ('bookkeeping', 'reports.periodic-summary', true),
  ('bookkeeping', 'reports.project-accounting', true),
  ('bookkeeping', 'reports.budget', true),
  ('bookkeeping', 'reports.income-statement', true),
  ('bookkeeping', 'reports.income-statement-12-months', true),
  ('bookkeeping', 'reports.income-statement-advanced', true),
  ('bookkeeping', 'reports.system-documentation', true),
  ('bookkeeping', 'reports.voucher-list', true),
  ('bookkeeping', 'reports.show-struck-rows', true),
  ('bookkeeping', 'reports.processing-history', true),
  ('bookkeeping', 'register.suppliers', true),
  ('bookkeeping', 'register.chart-of-accounts', true),
  ('bookkeeping', 'register.cost-centres', true),
  ('bookkeeping', 'register.projects', true),
  ('bookkeeping', 'register.sie-export', true),
  ('bookkeeping', 'register.sie-import', true),
  ('bookkeeping', 'register.export-files', true),
  ('bookkeeping', 'register.anonymise-fiscal-year', false),
  ('bookkeeping', 'register.removed-users', false),
  ('bookkeeping', 'register.delete-processing-history', false);

-- Bokföring - Attest & Läs: 24 in Full behörighet, 0 by hand.
INSERT INTO access.catalogue_program_permissions (program, permission, in_full) VALUES
  ('approval-read', 'vouchers.view', true),
  ('approval-read', 'vouchers.created-by', true),
  ('approval-read', 'vouchers.approve-own-series', true),
  ('approval-read', 'vouchers.see-all-series', true),
  ('approval-read', 'supplier-invoices.view', true),
  ('approval-read', 'reports.balance-sheet', true),
  ('approval-read', 'reports.deleted-vouchers', true),
  ('approval-read', 'reports.general-ledger', true),
  ('approval-read', 'reports.opening-balance', true),
  ('approval-read', 'reports.account-analysis', true),
  ('approval-read', 'reports.liquidity', true),
  ('approval-read', 'reports.vat', true),
  ('approval-read', 'reports.accruals', true),
  ('approval-read', 'reports.project-accounting', true),
  ('approval-read', 'reports.budget', true),
  ('approval-read', 'reports.income-statement', true),
  ('approval-read', 'reports.income-statement-12-months', true),
  ('approval-read', 'reports.income-statement-advanced', true),
  ('approval-read', 'reports.system-documentation', true),
  ('approval-read', 'reports.voucher-list', true),
  ('approval-read', 'reports.supplier-invoices', true),
  ('approval-read', 'reports.supplier-statistics', true),
  ('approval-read', 'reports.supplier-ledger', true),
  ('approval-read', 'reports.supplier-due-list', true);

-- Läs: 20 in Full behörighet, 0 by hand.
INSERT INTO access.catalogue_program_permissions (program, permission, in_full) VALUES
  ('read', 'vouchers.view', true),
  ('read', 'supplier-invoices.view', true),
  ('read', 'reports.balance-sheet', true),
  ('read', 'reports.deleted-vouchers', true),
  ('read', 'reports.general-ledger', true),
  ('read', 'reports.opening-balance', true),
  ('read', 'reports.account-analysis', true),
  ('read', 'reports.liquidity', true),
  ('read', 'reports.vat', true),
  ('read', 'reports.accruals', true),
  ('read', 'reports.periodic-summary', true),
  ('read', 'reports.project-accounting', true),
  ('read', 'reports.budget', true),
  ('read', 'reports.income-statement', true),
  ('read', 'reports.income-statement-12-months', true),
  ('read', 'reports.income-statement-advanced', true),
  ('read', 'reports.system-documentation', true),
  ('read', 'reports.voucher-list', true),
  ('read', 'reports.show-struck-rows', true),
  ('read', 'reports.processing-history', true);

-- Revisor: 22 in Full behörighet, 2 by hand.
INSERT INTO access.catalogue_program_permissions (program, permission, in_full) VALUES
  ('auditor', 'vouchers.view', true),
  ('auditor', 'vouchers.created-by', true),
  ('auditor', 'supplier-invoices.view', true),
  ('auditor', 'supplier-invoices.created-by', true),
  ('auditor', 'reports.balance-sheet', true),
  ('auditor', 'reports.deleted-vouchers', true),
  ('auditor', 'reports.general-ledger', true),
  ('auditor', 'reports.opening-balance', true),
  ('auditor', 'reports.account-analysis', true),
  ('auditor', 'reports.liquidity', true),
  ('auditor', 'reports.vat', true),
  ('auditor', 'reports.accruals', true),
  ('auditor', 'reports.periodic-summary', true),
  ('auditor', 'reports.project-accounting', true),
  ('auditor', 'reports.budget', true),
  ('auditor', 'reports.income-statement', true),
  ('auditor', 'reports.income-statement-12-months', true),
  ('auditor', 'reports.income-statement-advanced', true),
  ('auditor', 'reports.system-documentation', true),
  ('auditor', 'reports.voucher-list', true),
  ('auditor', 'reports.show-struck-rows', true),
  ('auditor', 'reports.processing-history', true),
  ('auditor', 'register.sie-export', false),
  ('auditor', 'register.export-files', false);

SELECT meta.protect_install_table('access.catalogue_programs');
SELECT meta.protect_install_table('access.catalogue_groups');
SELECT meta.protect_install_table('access.catalogue_permissions');
SELECT meta.protect_install_table('access.catalogue_program_permissions');
CREATE POLICY public_select ON access.catalogue_programs FOR SELECT TO nortfox_app USING (true);
CREATE POLICY public_select ON access.catalogue_groups FOR SELECT TO nortfox_app USING (true);
CREATE POLICY public_select ON access.catalogue_permissions FOR SELECT TO nortfox_app USING (true);
CREATE POLICY public_select ON access.catalogue_program_permissions FOR SELECT TO nortfox_app USING (true);
GRANT SELECT ON access.catalogue_programs, access.catalogue_groups, access.catalogue_permissions, access.catalogue_program_permissions TO nortfox_app;

-- The program grants -------------------------------------------------------------------
--
-- Program, "Tilldela program": a program granted to a member, with the
-- rights the grant holds. A member holds a program once, and may hold
-- several programs. The membership pairs with its company, so a grant never
-- names company A and a member of company B. is_full says whether the grant
-- holds every right of its program's "Full behörighet". granted_at is when
-- it was granted, by the database's clock, and expires_at when it ends by
-- itself, for a program that ends: granted_at and the program's days. A
-- move, "Flytta program", gives the grant to another member of the company
-- and keeps both. A withdrawal, "Ta bort program", deletes the grant; the
-- behandlingshistorik keeps it.
CREATE TABLE access.program_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  membership_id uuid NOT NULL,
  program text NOT NULL CONSTRAINT program_grants_program_fkey REFERENCES access.catalogue_programs (program),
  permissions text[] NOT NULL,
  is_full boolean NOT NULL,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz,
  CONSTRAINT program_grants_membership_fkey FOREIGN KEY (company_id, membership_id) REFERENCES access.memberships (company_id, id),
  CONSTRAINT program_grants_once UNIQUE (company_id, membership_id, program)
);

-- The rules no policy keeps, for every role:
-- - a grant holds only rights of its program's set (not_in_program, with the
--   first right in the order given that the set does not hold);
-- - an action right of a group needs the group's view right
--   (view_permission_missing, with the first such right in the order given
--   and the view right it needs); a group without a view right has none to
--   need. The program's set is checked first;
-- - the rights are kept once each, in the catalogue's order;
-- - is_full is the trigger's: true when the grant holds every right of the
--   program's "Full behörighet", also beside rights switched on by hand;
-- - granted_at and expires_at are the trigger's, from the database's clock
--   and the program's days, in whole days of 24 hours, and never change; nor
--   do the grant's id, its company and its program. A grant may move to
--   another membership of its company.
-- A refusal of a given or changed field is immutable_field, with the field.
CREATE FUNCTION access.program_grants_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
DECLARE
  lifetime integer;
  outside record;
  unseen record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.granted_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'granted_at', 'operation', 'create'));
    END IF;
    IF NEW.expires_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'expires_at', 'operation', 'create'));
    END IF;
    IF NEW.is_full IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'is_full', 'operation', 'create'));
    END IF;
    SELECT p.lifetime_days INTO lifetime FROM access.catalogue_programs AS p WHERE p.program = NEW.program;
    NEW.granted_at := clock_timestamp();
    NEW.expires_at := NEW.granted_at + make_interval(hours => 24 * lifetime);
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
    END IF;
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'company_id', 'operation', 'update'));
    END IF;
    IF NEW.program IS DISTINCT FROM OLD.program THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'program', 'operation', 'update'));
    END IF;
    IF NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'granted_at', 'operation', 'update'));
    END IF;
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'expires_at', 'operation', 'update'));
    END IF;
    IF NEW.is_full IS DISTINCT FROM OLD.is_full THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'is_full', 'operation', 'update'));
    END IF;
  END IF;
  -- No list at all is left for the NOT NULL constraint to refuse.
  IF NEW.permissions IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT u.permission INTO outside
  FROM unnest(NEW.permissions) WITH ORDINALITY AS u (permission, place)
  WHERE NOT EXISTS (SELECT FROM access.catalogue_program_permissions AS s WHERE s.program = NEW.program AND s.permission = u.permission)
  ORDER BY u.place
  LIMIT 1;
  IF FOUND THEN
    PERFORM ledger.refuse('not_in_program', jsonb_build_object('permission', outside.permission, 'program', NEW.program));
  END IF;
  SELECT u.permission, v.permission AS view INTO unseen
  FROM unnest(NEW.permissions) WITH ORDINALITY AS u (permission, place)
  JOIN access.catalogue_permissions AS p ON p.permission = u.permission AND NOT p.is_view
  JOIN access.catalogue_permissions AS v ON v.group_key = p.group_key AND v.is_view
  WHERE NOT (v.permission = ANY (NEW.permissions))
  ORDER BY u.place
  LIMIT 1;
  IF FOUND THEN
    PERFORM ledger.refuse('view_permission_missing', jsonb_build_object('permission', unseen.permission, 'view', unseen.view));
  END IF;
  NEW.permissions := ARRAY(SELECT p.permission FROM access.catalogue_permissions AS p WHERE p.permission = ANY (NEW.permissions) ORDER BY p.position);
  NEW.is_full := NOT EXISTS (
    SELECT FROM access.catalogue_program_permissions AS s WHERE s.program = NEW.program AND s.in_full AND NOT (s.permission = ANY (NEW.permissions))
  );
  RETURN NEW;
END
$rules$;

CREATE TRIGGER program_grants_rules BEFORE INSERT OR UPDATE ON access.program_grants
  FOR EACH ROW EXECUTE FUNCTION access.program_grants_rules();
SELECT meta.protect_company_table('access.program_grants', 'id');
GRANT INSERT, UPDATE, DELETE ON access.program_grants TO nortfox_app;

-- The program administrators -------------------------------------------------------
--
-- Programadministratör: a member who administers one program of the
-- company, once per program. The membership pairs with its company. A row
-- is appointed and removed, and never changes, for any role
-- (immutable_field, with the field).
CREATE TABLE access.program_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  membership_id uuid NOT NULL,
  program text NOT NULL CONSTRAINT program_admins_program_fkey REFERENCES access.catalogue_programs (program),
  CONSTRAINT program_admins_membership_fkey FOREIGN KEY (company_id, membership_id) REFERENCES access.memberships (company_id, id),
  CONSTRAINT program_admins_once UNIQUE (company_id, membership_id, program)
);

CREATE FUNCTION access.program_admins_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'company_id', 'operation', 'update'));
  END IF;
  IF NEW.membership_id IS DISTINCT FROM OLD.membership_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'membership_id', 'operation', 'update'));
  END IF;
  IF NEW.program IS DISTINCT FROM OLD.program THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'program', 'operation', 'update'));
  END IF;
  RETURN NEW;
END
$rules$;

CREATE TRIGGER program_admins_rules BEFORE UPDATE ON access.program_admins
  FOR EACH ROW EXECUTE FUNCTION access.program_admins_rules();
SELECT meta.protect_company_table('access.program_admins', 'id');
GRANT INSERT, DELETE ON access.program_admins TO nortfox_app;

-- The people of a company --------------------------------------------------------------
--
-- The id, the name and the e-mail address, never the personnummer or the
-- mobile number, of each identity among `ids` that holds a membership of
-- any status in the transaction's company: removed and left members too, so
-- the history keeps its names. A deleted identity keeps its name and has no
-- address. It gives nothing for a person outside the company, and nothing
-- with no company set. It runs as the owner, to read the identities, and
-- reads the memberships only in the transaction's company: the owner reads a
-- person's own memberships in every company too, through its policy by
-- person, so the company is named in the condition. The catalog check of
-- the one membership function pins this definition.
CREATE FUNCTION access.company_people(ids uuid[])
RETURNS TABLE (id uuid, name text, email text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT i.id, i.name, i.email
  FROM access.identities AS i
  WHERE i.id = ANY (company_people.ids)
    AND EXISTS (SELECT FROM access.memberships AS m WHERE m.company_id = ledger.current_company_id() AND m.user_id = i.id)
  ORDER BY i.id;
END;

GRANT EXECUTE ON FUNCTION access.company_people(uuid[]) TO nortfox_app;
