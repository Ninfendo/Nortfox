-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0009 the roles and the programs: the permission catalogue, the programs
-- granted to the members of a company, the program administrators, the
-- people of a company, the invitations, and the fold of an address (the
-- owner's rule of 2026-11-09). See db/README.md, the schema access, and
-- decisions 0002, 0008 and 0009 in docs/decisions/.
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

-- The company's details --------------------------------------------------------------
--
-- The company's postal and visiting addresses and its contact details, the
-- fields of the established company resource: Adress, Postnummer, Ort and
-- Land; the visiting address's street, postal code, town and country; and
-- Telefon and E-post. Each is a text of its own longest length, or none,
-- never an empty text; a country is its code in ISO 3166-1 alpha-2, two
-- capital letters. The table keeps no planner statistics of the new columns
-- either.
ALTER TABLE ledger.companies
  ADD COLUMN address text CONSTRAINT companies_address_length CHECK (char_length(address) BETWEEN 1 AND 200),
  ADD COLUMN zip_code text CONSTRAINT companies_zip_code_length CHECK (char_length(zip_code) BETWEEN 1 AND 20),
  ADD COLUMN city text CONSTRAINT companies_city_length CHECK (char_length(city) BETWEEN 1 AND 100),
  ADD COLUMN country_code text CONSTRAINT companies_country_code_form CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD COLUMN visit_address text CONSTRAINT companies_visit_address_length CHECK (char_length(visit_address) BETWEEN 1 AND 200),
  ADD COLUMN visit_zip_code text CONSTRAINT companies_visit_zip_code_length CHECK (char_length(visit_zip_code) BETWEEN 1 AND 20),
  ADD COLUMN visit_city text CONSTRAINT companies_visit_city_length CHECK (char_length(visit_city) BETWEEN 1 AND 100),
  ADD COLUMN visit_country_code text CONSTRAINT companies_visit_country_code_form CHECK (visit_country_code ~ '^[A-Z]{2}$'),
  ADD COLUMN phone text CONSTRAINT companies_phone_length CHECK (char_length(phone) BETWEEN 1 AND 50),
  ADD COLUMN email text CONSTRAINT companies_email_length CHECK (char_length(email) BETWEEN 1 AND 254);
SELECT meta.hide_statistics('ledger.companies');

-- Names on one line --------------------------------------------------------------------
--
-- A company's name and a person's stand on one line wherever they are shown,
-- also in the invitation's mail: neither holds a control character (C0 and
-- C1, with the tab, the line feed, the carriage return and the next line),
-- the line or the paragraph separator, or a control of the text's
-- direction, so none adds a line to a mail or turns its text around. The
-- API refuses the same first (packages/contract/src/text.ts, NOT_IN_A_NAME),
-- and U+0000 is a text that PostgreSQL never holds. The invitations and
-- their links below hold the same of their names.
ALTER TABLE ledger.companies ADD CONSTRAINT companies_name_one_line CHECK (name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]');
ALTER TABLE access.identities ADD CONSTRAINT identities_name_one_line CHECK (name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]');

-- The fold of an address -------------------------------------------------------------
--
-- The owner's rule of 2026-11-09: an address that can become an identity's
-- holds no character whose case fold is not its lower case. The unique
-- index of the identities, find_login and identifier_form fold an address
-- with casefold() under pg_unicode_fast, which makes ß, ẞ and ſ into s, ς
-- into σ, µ into μ, a ligature into its letters and a Cherokee letter into
-- its capital; IDNA2008 and a mail program keep straße.example and
-- strasse.example apart. So such an address would take another mailbox's
-- identity, or tell its holder that the other has one. The check is each
-- character of the address in NFC, alone, so the final sigma of lower() has
-- no part in it: its fold, in NFC, is its lower case, in NFC. PostgreSQL's
-- own Unicode data finds the characters, no list. It holds on an
-- invitation's address, an identity's address and a work e-mail, which a
-- disconnect invites, for every role; the API refuses the same first
-- (packages/contract/src/address.ts, foldsAsLowerCase). The app runs it in
-- the checks of its writes, so it may run it. An install that holds such an
-- address already stops here, with the check's name, and keeps its
-- migrations as they were: change the address first.
CREATE FUNCTION access.folds_as_lower_case(address text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT NOT EXISTS (
    SELECT FROM string_to_table(normalize(folds_as_lower_case.address, NFC), NULL) AS c (ch)
    WHERE normalize(casefold(c.ch COLLATE pg_catalog.pg_unicode_fast), NFC) <> normalize(lower(c.ch COLLATE pg_catalog.pg_unicode_fast), NFC)
  );
END;

GRANT EXECUTE ON FUNCTION access.folds_as_lower_case(text) TO nortfox_app;

ALTER TABLE access.identities ADD CONSTRAINT identities_email_folds_as_lower_case CHECK (access.folds_as_lower_case(email));
ALTER TABLE access.membership_contacts ADD CONSTRAINT membership_contacts_work_email_folds_as_lower_case CHECK (access.folds_as_lower_case(work_email));

-- The work e-mail address ------------------------------------------------------------
--
-- Every active and inactive membership has a work e-mail address, as the
-- established screen requires Epost (issue 12, "Users in a company" 9): the
-- server fills it when it makes such a membership, and refuses to take it
-- away. Each such membership that has none when the rule arrives gets its
-- identity's e-mail address; a work phone that it has stays. The invited,
-- removed and left memberships keep what they have. The memberships are a
-- company table, whose rows even the owner reads only in the transaction's
-- company: so row level security is not forced on them while this
-- statement reads every company's, and forced again after it, in the same
-- transaction, which the table guard then checks. The work contacts keep no
-- history.
ALTER TABLE access.memberships NO FORCE ROW LEVEL SECURITY;
INSERT INTO access.membership_contacts (contact_company_id, membership_id, work_email)
SELECT m.company_id, m.id, i.email
FROM access.memberships AS m
JOIN access.identities AS i ON i.id = m.user_id
WHERE m.status IN ('active', 'inactive') AND i.email IS NOT NULL
ON CONFLICT (contact_company_id, membership_id) DO UPDATE SET work_email = excluded.work_email
  WHERE access.membership_contacts.work_email IS NULL;
ALTER TABLE access.memberships FORCE ROW LEVEL SECURITY;

-- The invitations --------------------------------------------------------------------
--
-- Inbjudan: an invitation of a member, "Lägg till användare" or "Skicka en
-- ny inbjudan", with the name and the e-mail address it was sent to, who
-- sent it, the transaction's actor, which the history keeps the same way,
-- with no foreign key, and when. It works for 14 days, in whole days of 24
-- hours, from when the database stamped it. It ends once: accepted, or
-- stopped by a newer invitation of the same member or by the member's
-- removal. A company table: the rights history must say whom a membership
-- was offered to, and the address is where the link went, so the name and
-- the address stay in the behandlingshistorik. The membership pairs with
-- its company, and company_id and id together are a key, so a link names an
-- invitation with its company.
CREATE TABLE access.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES ledger.companies (company_id),
  membership_id uuid NOT NULL,
  name text NOT NULL CONSTRAINT invitations_name_length CHECK (char_length(name) BETWEEN 1 AND 200)
    CONSTRAINT invitations_name_one_line CHECK (name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  email text NOT NULL CONSTRAINT invitations_email_length CHECK (char_length(email) BETWEEN 1 AND 254)
    CONSTRAINT invitations_email_folds_as_lower_case CHECK (access.folds_as_lower_case(email)),
  invited_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT invitations_membership_fkey FOREIGN KEY (company_id, membership_id) REFERENCES access.memberships (company_id, id),
  CONSTRAINT invitations_accepted_or_superseded CHECK (accepted_at IS NULL OR superseded_at IS NULL),
  CONSTRAINT invitations_company_id_id_key UNIQUE (company_id, id)
);

-- The rules no policy keeps, for every role:
-- - no invitation is deleted (append_only);
-- - the database stamps who sent it, the transaction's actor, when, to the
--   millisecond, as the API gives a time, and its end 14 days later, and
--   refuses each of them, an acceptance and a stop, when they are given
--   with a new invitation;
-- - only accepted_at and superseded_at change, each once (the set-once
--   trigger below), and never both; nothing else ever changes;
-- - a new invitation locks its member's row first, FOR NO KEY UPDATE, so two
--   new invitations of one member take turns: the second waits for the
--   first's commit, and then stops it (invitations_supersede, below).
-- A refusal of a given or changed field is immutable_field, with the field.
CREATE FUNCTION access.invitations_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rules$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM ledger.refuse('append_only', jsonb_build_object('table', 'access.invitations', 'operation', 'DELETE'));
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.invited_by IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'invited_by', 'operation', 'create'));
    END IF;
    IF NEW.created_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'create'));
    END IF;
    IF NEW.expires_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'expires_at', 'operation', 'create'));
    END IF;
    IF NEW.accepted_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'accepted_at', 'operation', 'create'));
    END IF;
    IF NEW.superseded_at IS NOT NULL THEN
      PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'superseded_at', 'operation', 'create'));
    END IF;
    PERFORM FROM access.memberships AS m WHERE m.company_id = NEW.company_id AND m.id = NEW.membership_id FOR NO KEY UPDATE;
    SELECT a.actor_id INTO NEW.invited_by FROM ledger.current_actor() AS a;
    NEW.created_at := date_trunc('milliseconds', clock_timestamp());
    NEW.expires_at := NEW.created_at + make_interval(hours => 24 * 14);
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'id', 'operation', 'update'));
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'company_id', 'operation', 'update'));
  END IF;
  IF NEW.membership_id IS DISTINCT FROM OLD.membership_id THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'membership_id', 'operation', 'update'));
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'name', 'operation', 'update'));
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'email', 'operation', 'update'));
  END IF;
  IF NEW.invited_by IS DISTINCT FROM OLD.invited_by THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'invited_by', 'operation', 'update'));
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'created_at', 'operation', 'update'));
  END IF;
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    PERFORM ledger.refuse('immutable_field', jsonb_build_object('field', 'expires_at', 'operation', 'update'));
  END IF;
  RETURN NEW;
END
$rules$;

CREATE TRIGGER invitations_rules BEFORE INSERT OR UPDATE OR DELETE ON access.invitations
  FOR EACH ROW EXECUTE FUNCTION access.invitations_rules();
CREATE TRIGGER invitations_set_once BEFORE UPDATE ON access.invitations
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('accepted_at', 'superseded_at');
SELECT meta.protect_company_table('access.invitations', 'id');
-- An invitation is never deleted, so the app may add them and mark them only.
GRANT INSERT, UPDATE ON access.invitations TO nortfox_app;

-- A new invitation of a member stops the member's earlier ones that are
-- still open, at the new one's time (open point 5): a member has one open
-- invitation at most. The new one holds the member's row (above), so it
-- sees an invitation that another transaction made and committed first.
CREATE FUNCTION access.supersede_invitations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $supersede$
BEGIN
  UPDATE access.invitations AS i SET superseded_at = NEW.created_at
  WHERE i.company_id = NEW.company_id AND i.membership_id = NEW.membership_id AND i.id <> NEW.id
    AND i.accepted_at IS NULL AND i.superseded_at IS NULL;
  RETURN NULL;
END
$supersede$;

CREATE TRIGGER invitations_supersede AFTER INSERT ON access.invitations
  FOR EACH ROW EXECUTE FUNCTION access.supersede_invitations();

-- An invited member's removal stops their open invitation, at the
-- database's clock.
CREATE FUNCTION access.withdraw_invitations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $withdraw$
BEGIN
  UPDATE access.invitations AS i SET superseded_at = clock_timestamp()
  WHERE i.company_id = NEW.company_id AND i.membership_id = NEW.id AND i.accepted_at IS NULL AND i.superseded_at IS NULL;
  RETURN NULL;
END
$withdraw$;

CREATE TRIGGER memberships_withdraw_invitations AFTER UPDATE ON access.memberships
  FOR EACH ROW WHEN (OLD.status = 'invited' AND NEW.status = 'removed') EXECUTE FUNCTION access.withdraw_invitations();

-- The invitation links -------------------------------------------------------------
--
-- The link of an invitation, "Acceptera inbjudan": the token's hash, the
-- invitation it opens, paired with its company, and what the link's page
-- shows before anyone accepts: the name and the address the invitation was
-- sent to, and the company's and the sender's names as they were then. An
-- invitation has one link. It works once, until the invitation's end, and
-- stops when its invitation does. A link is used or stopped, never both, and
-- either mark is set once. A secret install-wide table: the app reaches it
-- only through the functions below, and the purge deletes a link at its
-- end.
CREATE TABLE access.invitation_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL CONSTRAINT invitation_links_token_hash_form CHECK (octet_length(token_hash) = 32),
  invited_company_id uuid NOT NULL,
  invitation_id uuid NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  company_name text NOT NULL CONSTRAINT invitation_links_company_name_one_line CHECK (company_name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  inviter_name text NOT NULL CONSTRAINT invitation_links_inviter_name_one_line CHECK (inviter_name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT invitation_links_token_hash_key UNIQUE (token_hash),
  CONSTRAINT invitation_links_once UNIQUE (invited_company_id, invitation_id),
  CONSTRAINT invitation_links_invitation_fkey FOREIGN KEY (invited_company_id, invitation_id) REFERENCES access.invitations (company_id, id),
  CONSTRAINT invitation_links_used_or_superseded CHECK (used_at IS NULL OR superseded_at IS NULL)
);
CREATE TRIGGER invitation_links_set_once BEFORE UPDATE ON access.invitation_links
  FOR EACH ROW EXECUTE FUNCTION access.keep_set_once('used_at', 'superseded_at');
SELECT meta.protect_install_table('access.invitation_links');

-- An invitation that stops, by a newer one or by the member's removal,
-- stops its link, at the same time, unless the link was used.
CREATE FUNCTION access.stop_invitation_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $stop$
BEGIN
  UPDATE access.invitation_links AS l SET superseded_at = NEW.superseded_at
  WHERE l.invited_company_id = NEW.company_id AND l.invitation_id = NEW.id AND l.used_at IS NULL AND l.superseded_at IS NULL;
  RETURN NULL;
END
$stop$;

CREATE TRIGGER invitations_stop_links AFTER UPDATE OF superseded_at ON access.invitations
  FOR EACH ROW WHEN (OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL) EXECUTE FUNCTION access.stop_invitation_links();

-- The functions of the links ---------------------------------------------------------

-- Makes the link of an open invitation of the transaction's company, and
-- gives true; or gives false, and makes none, for an invitation that the
-- company does not have, or that was accepted or stopped. The link takes the
-- invitation's name, address and end. The server gives the company's and
-- the sender's names, which it reads in the same transaction: no function
-- that the app may run reads the companies. It locks the invitation's row
-- when it reads it as open, FOR NO KEY UPDATE, until the transaction ends.
-- So a stop of the invitation, by a newer one or by the member's removal,
-- waits for the link's commit, and then stops the link too; and a stop that
-- came first is seen once it commits, and no link is made.
CREATE FUNCTION access.issue_invitation_link(token_hash bytea, invitation uuid, company_name text, inviter_name text, at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $issue$
DECLARE
  open record;
BEGIN
  SELECT i.name, i.email, i.expires_at INTO open
  FROM access.invitations AS i
  WHERE i.id = issue_invitation_link.invitation AND i.company_id = ledger.current_company_id() AND i.accepted_at IS NULL AND i.superseded_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO access.invitation_links (token_hash, invited_company_id, invitation_id, name, email, company_name, inviter_name, created_at, expires_at)
  VALUES (
    issue_invitation_link.token_hash, ledger.current_company_id(), issue_invitation_link.invitation, open.name, open.email,
    issue_invitation_link.company_name, issue_invitation_link.inviter_name, issue_invitation_link.at, open.expires_at
  );
  RETURN true;
END
$issue$;

-- A live link, by its hash, at `at`: one that is not used, not stopped and
-- not past its end. It gives the invitation and its company, and what the
-- link's page shows. Nothing for any other link.
CREATE FUNCTION access.invitation_by_token(token_hash bytea, at timestamptz)
RETURNS TABLE (invited_company_id uuid, invitation_id uuid, name text, email text, company_name text, inviter_name text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT l.invited_company_id, l.invitation_id, l.name, l.email, l.company_name, l.inviter_name, l.expires_at
  FROM access.invitation_links AS l
  WHERE l.token_hash = invitation_by_token.token_hash AND l.used_at IS NULL AND l.superseded_at IS NULL AND l.expires_at > invitation_by_token.at;
END;

-- Uses a live link once, for the transaction's person, whose identity is
-- active, in the link's company, which the transaction has entered: it
-- gives true, or false when no row changed. Of two uses at once, the second
-- waits for the first's row lock, then finds the link used.
CREATE FUNCTION access.use_invitation_link(token_hash bytea, at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $use$
BEGIN
  UPDATE access.invitation_links AS l SET used_at = use_invitation_link.at
  WHERE l.token_hash = use_invitation_link.token_hash AND l.used_at IS NULL AND l.superseded_at IS NULL AND l.expires_at > use_invitation_link.at
    AND l.invited_company_id = ledger.current_company_id()
    AND EXISTS (SELECT FROM access.identities AS i WHERE i.id = access.current_person_id() AND i.status = 'active');
  RETURN FOUND;
END
$use$;

-- Uses a live link once, as access.use_invitation_link does, and makes a new
-- identity with it: the transaction's person, whose id the server picked,
-- with the name, the link's e-mail address, the password and a pending TOTP
-- secret, which the server sealed bound to the identity and the secret's
-- row. It gives false, and makes nothing, for a link that is not live, or
-- with no person set. An address that another identity has is refused by
-- the identities' unique index (23505), and nothing is kept.
CREATE FUNCTION access.accept_invitation_as_new(token_hash bytea, at timestamptz, name text, password_hash text, totp_secret_id uuid, totp_secret bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $accept$
DECLARE
  person uuid := access.current_person_id();
  address text;
BEGIN
  IF person IS NULL THEN
    RETURN false;
  END IF;
  UPDATE access.invitation_links AS l SET used_at = accept_invitation_as_new.at
  WHERE l.token_hash = accept_invitation_as_new.token_hash AND l.used_at IS NULL AND l.superseded_at IS NULL AND l.expires_at > accept_invitation_as_new.at
    AND l.invited_company_id = ledger.current_company_id()
  RETURNING l.email INTO address;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO access.identities (id, name, email) VALUES (person, accept_invitation_as_new.name, address);
  INSERT INTO access.password_credentials (identity_id, password_hash, changed_at) VALUES (person, accept_invitation_as_new.password_hash, accept_invitation_as_new.at);
  INSERT INTO access.totp_secrets (id, identity_id, secret, state, created_at)
  VALUES (accept_invitation_as_new.totp_secret_id, person, accept_invitation_as_new.totp_secret, 'pending', accept_invitation_as_new.at);
  RETURN true;
END
$accept$;

GRANT EXECUTE ON FUNCTION
  access.issue_invitation_link(bytea, uuid, text, text, timestamptz),
  access.invitation_by_token(bytea, timestamptz),
  access.use_invitation_link(bytea, timestamptz),
  access.accept_invitation_as_new(bytea, timestamptz, text, text, uuid, bytea)
TO nortfox_app;

-- The turns of the user administration ----------------------------------------------
--
-- Two turns of the transaction's company, each an advisory lock on the hash
-- of the company's id, in a class of keys of its own, held until the
-- transaction ends, as the ledger's turn is (ledger.take_turn, 0002). Each
-- orders the changes whose check the server must see settled before it
-- sends a mail, which it does before its commit (plan 2.15), without the
-- company's row: every change of a membership, a new fiscal year and
-- updateCompany lock that row, and would wait for the mail.
--
-- - The invitations' turn, alone: inviteUser takes it before it reads the
--   addresses of the company. Of two invitations to one address at once, the
--   second waits for the first's commit, and then reads its invitation.
-- - The administrators' turn: a change that takes an active system
--   administrator away takes it before the server's check of the last one.
--   A disconnect takes it alone, since it sends its mail before its commit;
--   a removal, a deactivation, a demotion and a leave take it with each
--   other. So a disconnect's check reads after each such change has
--   committed, none of them commits while the disconnect sends its mail, and
--   the loser of a race sends none. The database's check at the commit stays
--   the authority (keep_system_administrator, 0007).
--
-- No role but the owner may take an advisory lock (db/database.sql): the app
-- takes these through the functions alone, in the transaction's company. A
-- write that waits here holds a connection of the server's pool, so the
-- server makes each such write wait for the same turn in its own process
-- first, before it asks the pool for a connection
-- (apps/server/src/api/turns.ts): a burst of one company's invitations never
-- takes the pool from the other companies. Here a write waits only for one
-- of another process. Two companies whose ids hash alike share a turn, which
-- costs only a wait. A transaction that works in no company takes none and
-- is refused.
CREATE FUNCTION access.take_invitations_turn() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $turn$
DECLARE
  company uuid := ledger.current_company_id();
BEGIN
  IF company IS NULL THEN
    RAISE EXCEPTION 'The transaction works in no company, so it has no turn of its invitations to take.';
  END IF;
  PERFORM pg_advisory_xact_lock(4646211, hashtext(company::text));
END
$turn$;

CREATE FUNCTION access.take_administrators_turn(alone boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $turn$
DECLARE
  company uuid := ledger.current_company_id();
BEGIN
  IF company IS NULL THEN
    RAISE EXCEPTION 'The transaction works in no company, so it has no turn of its administrators to take.';
  END IF;
  IF take_administrators_turn.alone THEN
    PERFORM pg_advisory_xact_lock(4646212, hashtext(company::text));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(4646212, hashtext(company::text));
  END IF;
END
$turn$;

GRANT EXECUTE ON FUNCTION access.take_invitations_turn(), access.take_administrators_turn(boolean) TO nortfox_app;

-- The purge, as 0008 made it, but for one thing: it deletes the invitation
-- links at their end, used and stopped ones too, after the setup links.
CREATE OR REPLACE FUNCTION access.purge_expired(at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $purge$
BEGIN
  DELETE FROM access.setup_tokens AS t WHERE t.expires_at <= purge_expired.at AND t.used_at IS NULL;
  DELETE FROM access.invitation_links AS l WHERE l.expires_at <= purge_expired.at;
  DELETE FROM access.login_challenges AS c WHERE c.expires_at <= purge_expired.at;
  DELETE FROM access.sessions AS s
  WHERE s.ended_at <= purge_expired.at - interval '30 days'
    OR (s.ended_at IS NULL AND s.started_at <= purge_expired.at - interval '30 days 12 hours');
  DELETE FROM access.attempt_counters AS a
  WHERE a.window_started_at <= purge_expired.at - interval '1 hour' AND (a.locked_until IS NULL OR a.locked_until <= purge_expired.at);
  DELETE FROM access.idempotency_keys AS k WHERE k.created_at <= purge_expired.at - interval '24 hours';
  DELETE FROM access.account_events AS e
  WHERE e.id IN (
    SELECT r.id FROM (
      SELECT x.id, x.kind, x.details, x.at, row_number() OVER (PARTITION BY x.identity_id ORDER BY x.at DESC, x.id DESC) AS place
      FROM access.account_events AS x
    ) AS r
    WHERE r.place > 100
      AND NOT (r.kind = 'sign-in' AND r.details ->> 'outcome' IS NOT DISTINCT FROM 'failed' AND r.at > clock_timestamp() - interval '1 hour')
  );
END
$purge$;
