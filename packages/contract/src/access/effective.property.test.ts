// SPDX-License-Identifier: AGPL-3.0-only

// The effective permissions and the roles, for any member: any admin level,
// any grants with any lists, also lists the database would refuse, any
// ends, any programs administered, at any time. What holds for each: a
// right comes only from a grant that still holds, lists it, may grant it,
// and gives its group's view right beside it; every such right comes; its
// end is the latest of the grants that give it, or none; the view right of
// a group never ends before an action right of it; the platform's
// permissions always come, with no end; the owner and the admin are the
// same; time and more grants only ever take away and add; "Full behörighet"
// never gives a manual-only right. effective.test.ts holds the six roles.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CATALOGUE_PERMISSIONS, PROGRAMS, fullPermissions, programPermissions, viewPermissionOf, type CataloguePermissionKey, type Program } from "./catalogue.ts";
import { ROLE_KEYS, effectivePermissions, rolesOf, type GrantAccess, type MemberAccess, type Role } from "./effective.ts";
import { ADMIN_LEVELS, PROGRAM_ADMINISTRATOR_PERMISSIONS, platformPermissions } from "./permissions.ts";

const KEYS: readonly CataloguePermissionKey[] = CATALOGUE_PERMISSIONS.map((permission) => permission.key);

/** Times in one quarter, so the ends and the moments fall on both sides of each other. */
const moment = fc.date({ min: new Date("2090-01-01T00:00:00.000Z"), max: new Date("2090-04-01T00:00:00.000Z"), noInvalidDate: true });

/** Any right a list may hold: a catalogue key most often, and now and then a platform permission, a near miss or any text. */
const anyRight = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom(...KEYS) },
  { weight: 1, arbitrary: fc.constantFrom("company:read", "vouchers", "VOUCHERS.VIEW", "vouchers.view ", "") },
  { weight: 1, arbitrary: fc.string() },
);

/** A grant of `program`: a part of its set, as the database takes, or any list; with no end, or any end. */
function grantOf(program: Program): fc.Arbitrary<GrantAccess> {
  return fc.record({
    program: fc.constant(program),
    permissions: fc.oneof(fc.subarray(programPermissions(program)), fc.constant(fullPermissions(program)), fc.array(anyRight, { maxLength: 30 })),
    expiresAt: fc.option(moment, { nil: null }),
  });
}

/** Any grants: each program at most once, as the database keeps them, or now and then a program twice. */
const grants: fc.Arbitrary<GrantAccess[]> = fc.oneof(
  { weight: 4, arbitrary: fc.subarray([...PROGRAMS]).chain((programs) => fc.tuple(...programs.map(grantOf))) },
  { weight: 1, arbitrary: fc.array(fc.constantFrom(...PROGRAMS).chain(grantOf), { maxLength: 6 }) },
);

/** Any member. */
const member: fc.Arbitrary<MemberAccess> = fc.record({
  adminLevel: fc.constantFrom(null, ...ADMIN_LEVELS),
  grants,
  programsAdministered: fc.subarray([...PROGRAMS]),
});

/** Whether `grant` gives `permission` by the rules: it lists it, its program may grant it, and it lists the group's view right too. */
function gives(grant: GrantAccess, permission: CataloguePermissionKey): boolean {
  const view = viewPermissionOf(permission);
  return grant.permissions.includes(permission) && programPermissions(grant.program).includes(permission) && (view === null || grant.permissions.includes(view));
}

/** Whether a grant still holds at `now`: it has no end, or its end is later. */
function holds(grant: GrantAccess, now: Date): boolean {
  return grant.expiresAt === null || now.getTime() < grant.expiresAt.getTime();
}

/** The six roles by the issue's words: the two admin levels, Bokföring with "Full behörighet", and each of the other three programs. */
const ROLE_RULES: readonly (readonly [Role, (access: MemberAccess, live: readonly GrantAccess[]) => boolean])[] = [
  ["owner", (access) => access.adminLevel === "owner"],
  ["admin", (access) => access.adminLevel === "admin"],
  ["bookkeeper", (_access, live) => live.some((grant) => grant.program === "bookkeeping" && fullPermissions("bookkeeping").every((permission) => gives(grant, permission)))],
  ["approver", (_access, live) => live.some((grant) => grant.program === "approval-read")],
  ["viewer", (_access, live) => live.some((grant) => grant.program === "read")],
  ["auditor", (_access, live) => live.some((grant) => grant.program === "auditor")],
];

/** The latest of some ends, where null, no end, is the latest of all. */
function latest(ends: readonly (Date | null)[]): Date | null {
  let most = -Infinity;
  for (const end of ends) {
    if (end === null) {
      return null;
    }
    most = Math.max(most, end.getTime());
  }
  return new Date(most);
}

/** The platform's permissions of a member: by being one, by its admin level, and by administering a program. */
function platformOf(access: MemberAccess): string[] {
  return [...platformPermissions(access.adminLevel), ...(access.programsAdministered.length > 0 ? PROGRAM_ADMINISTRATOR_PERMISSIONS : [])];
}

describe("the effective permissions of any member", () => {
  it("give a catalogue right only from a grant that holds and gives it, and every right that such a grant gives, with the latest end of them", () => {
    fc.assert(
      fc.property(member, moment, (access, now) => {
        const effective = effectivePermissions(access, now);
        const live = access.grants.filter((grant) => holds(grant, now));
        for (const permission of KEYS) {
          const giving = live.filter((grant) => gives(grant, permission));
          expect(effective.has(permission), permission).toBe(giving.length > 0);
          if (giving.length > 0) {
            expect(effective.get(permission), permission).toEqual(latest(giving.map((grant) => grant.expiresAt)));
          }
        }
      }),
    );
  });

  it("give the platform's permissions with no end, and nothing else outside the catalogue", () => {
    fc.assert(
      fc.property(member, moment, (access, now) => {
        const effective = effectivePermissions(access, now);
        const platform = platformOf(access);
        for (const permission of platform) {
          expect(effective.get(permission), permission).toBeNull();
        }
        const outside = [...effective.keys()].filter((key) => !(KEYS as readonly string[]).includes(key));
        expect(outside).toEqual(platform);
      }),
    );
  });

  it("give each right an end after the moment, or none", () => {
    fc.assert(
      fc.property(member, moment, (access, now) => {
        for (const end of effectivePermissions(access, now).values()) {
          expect(end === null || end.getTime() > now.getTime()).toBe(true);
        }
      }),
    );
  });

  it("give an action right only with its group's view right, which never ends before it", () => {
    fc.assert(
      fc.property(member, moment, (access, now) => {
        const effective = effectivePermissions(access, now);
        for (const [permission, end] of effective) {
          const view = (KEYS as readonly string[]).includes(permission) ? viewPermissionOf(permission as CataloguePermissionKey) : null;
          if (view !== null && view !== permission) {
            expect(effective.has(view), `${permission} without ${view}`).toBe(true);
            const viewEnd = effective.get(view) ?? null;
            expect(viewEnd === null || (end !== null && viewEnd.getTime() >= end.getTime()), `${view} ends before ${permission}`).toBe(true);
          }
        }
      }),
    );
  });

  it("list the platform's permissions first, then the catalogue's rights in the catalogue's order", () => {
    fc.assert(
      fc.property(member, moment, (access, now) => {
        const keys = [...effectivePermissions(access, now).keys()];
        const platform = platformOf(access);
        expect(keys.slice(0, platform.length)).toEqual(platform);
        expect(keys.slice(platform.length)).toEqual(KEYS.filter((key) => keys.includes(key)));
      }),
    );
  });

  it("are the same for the owner and the admin (open point 1)", () => {
    fc.assert(
      fc.property(member, moment, (access, now) => {
        expect(effectivePermissions({ ...access, adminLevel: "owner" }, now)).toEqual(effectivePermissions({ ...access, adminLevel: "admin" }, now));
      }),
    );
  });

  it("give a system administrator no catalogue right that the grants do not give", () => {
    fc.assert(
      fc.property(member, moment, fc.constantFrom(...ADMIN_LEVELS), (access, now, level) => {
        const asMember = [...effectivePermissions({ ...access, adminLevel: null }, now).keys()].filter((key) => (KEYS as readonly string[]).includes(key));
        const asAdministrator = [...effectivePermissions({ ...access, adminLevel: level }, now).keys()].filter((key) => (KEYS as readonly string[]).includes(key));
        expect(asAdministrator).toEqual(asMember);
      }),
    );
  });

  it("only ever lose rights as time goes on", () => {
    fc.assert(
      fc.property(member, moment, moment, (access, first, second) => {
        const [earlier, later] = first.getTime() <= second.getTime() ? [first, second] : [second, first];
        const before = effectivePermissions(access, earlier);
        for (const [permission, end] of effectivePermissions(access, later)) {
          expect(before.has(permission), permission).toBe(true);
          expect(before.get(permission), permission).toEqual(end);
        }
      }),
    );
  });

  it("only ever gain rights with one more grant", () => {
    fc.assert(
      fc.property(member, fc.constantFrom(...PROGRAMS).chain(grantOf), moment, (access, extra, now) => {
        const more = effectivePermissions({ ...access, grants: [...access.grants, extra] }, now);
        for (const permission of effectivePermissions(access, now).keys()) {
          expect(more.has(permission), permission).toBe(true);
        }
      }),
    );
  });

  it("never give a manual-only right from grants of \"Full behörighet\"", () => {
    const manualOnly = CATALOGUE_PERMISSIONS.filter((permission) => permission.manualOnly).map((permission) => permission.key);
    fc.assert(
      fc.property(fc.subarray([...PROGRAMS]), fc.option(moment, { nil: null }), member, moment, (programs, end, access, now) => {
        const fullOnly: MemberAccess = { ...access, grants: programs.map((program) => ({ program, permissions: fullPermissions(program), expiresAt: end })) };
        for (const permission of manualOnly) {
          expect(effectivePermissions(fullOnly, now).has(permission), permission).toBe(false);
        }
      }),
    );
  });
});

describe("the roles of any member", () => {
  it("are the owner or the admin by the admin level, and a program's role by a grant of it that holds, in the roles' order", () => {
    fc.assert(
      fc.property(member, moment, (access, now) => {
        const live = access.grants.filter((grant) => holds(grant, now));
        const wanted = ROLE_RULES.filter(([, rule]) => rule(access, live)).map(([role]) => role);
        expect(rolesOf(access, now)).toEqual(wanted);
      }),
    );
  });

  it("hold the owner and the admin never both, and each role once", () => {
    fc.assert(
      fc.property(member, moment, (access, now) => {
        const roles = rolesOf(access, now);
        expect(roles.includes("owner") && roles.includes("admin")).toBe(false);
        expect(new Set(roles).size).toBe(roles.length);
        expect(ROLE_KEYS.filter((role) => roles.includes(role))).toEqual(roles);
      }),
    );
  });

  it("only ever lose roles as time goes on", () => {
    fc.assert(
      fc.property(member, moment, moment, (access, first, second) => {
        const [earlier, later] = first.getTime() <= second.getTime() ? [first, second] : [second, first];
        const before = rolesOf(access, earlier);
        for (const role of rolesOf(access, later)) {
          expect(before).toContain(role);
        }
      }),
    );
  });
});
