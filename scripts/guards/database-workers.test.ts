// SPDX-License-Identifier: AGPL-3.0-only

// The database tests run one test file to a worker, and a file holds up to 34
// connections at once (row-locks.db.test.ts), the next busiest 28 and 19. The
// test cluster keeps PostgreSQL's limit of 100 connections, 3 of them for a
// superuser only (deploy/test-database/compose.yaml, and the service in CI).
// With one worker to a core, a 16-core machine runs 15 files at once, and a
// file now and then finds no connection left. So the database project runs at
// most three files at once, as CI's 4-core runner does: 34 + 28 + 19 is 81,
// under the 97 that the tests' roles may use, with room for the setup's own.

import { describe, expect, it } from "vitest";
import config from "../../vitest.config.ts";

describe("the database tests", () => {
  it("run at most three test files at once, so their connections fit the test cluster", () => {
    const projects = config.test?.projects ?? [];
    const database = projects.find((project) => typeof project === "object" && "test" in project && project.test.name === "database");
    expect(database).toBeDefined();
    const test = (database as { test: { maxWorkers?: unknown; sequence?: { groupOrder?: unknown } } }).test;
    expect(test.maxWorkers).toBe(3);
    // Vitest runs a project with a limit of its own in a group of its own.
    expect(test.sequence?.groupOrder).toBe(1);
  });
});
