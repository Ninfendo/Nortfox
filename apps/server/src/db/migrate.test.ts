// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, checksum, nameProblems, readMigrations } from "./migrate.ts";

describe("nameProblems", () => {
  it("passes names of four digits, an underscore and lower-case words, each number once", () => {
    expect(nameProblems(["0001_foundation.sql", "0002_fiscal_years.sql", "0010_x2.sql"])).toEqual([]);
    expect(nameProblems([])).toEqual([]);
  });

  it.each(["1_foundation.sql", "00001_foundation.sql", "0001-foundation.sql", "0001_Foundation.sql", "0001_.sql", "0001_a__b.sql", "0001_a.SQL", "0001_a.sql.bak", "README.md"])(
    "fails the name %s",
    (name) => {
      expect(nameProblems([name])).toEqual([
        `${name} is not a migration name: four digits, an underscore, lower-case words joined by underscores, and .sql, as in 0001_foundation.sql.`,
      ]);
    },
  );

  it("fails two files with one number, in any order", () => {
    expect(nameProblems(["0002_b.sql", "0001_a.sql", "0002_a.sql"])).toEqual(["0002_a.sql and 0002_b.sql have the same number."]);
  });
});

describe("checksum", () => {
  it("is the SHA-256 of the text, with CRLF read as LF", () => {
    expect(checksum("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(checksum("SELECT 1;\r\nSELECT 2;\r\n")).toBe(checksum("SELECT 1;\nSELECT 2;\n"));
    expect(checksum("SELECT 1;\n")).not.toBe(checksum("SELECT 2;\n"));
  });
});

describe("readMigrations", () => {
  let folder: string | undefined;

  afterEach(() => {
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
      folder = undefined;
    }
  });

  function folderWith(files: Record<string, string>): string {
    folder = mkdtempSync(join(tmpdir(), "nortfox-migrations-"));
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(folder, name), text);
    }
    return folder;
  }

  it("reads the files in order, each with its checksum", () => {
    const found = readMigrations(folderWith({ "0002_b.sql": "SELECT 2;\r\n", "0001_a.sql": "SELECT 1;\n" }));
    expect(found).toEqual([
      { name: "0001_a.sql", sql: "SELECT 1;\n", sha256: checksum("SELECT 1;\n") },
      { name: "0002_b.sql", sql: "SELECT 2;\r\n", sha256: checksum("SELECT 2;\n") },
    ]);
  });

  it("refuses a folder with a file or a folder that is not a migration", () => {
    const path = folderWith({ "0001_a.sql": "", "notes.txt": "" });
    expect(() => readMigrations(path)).toThrow("notes.txt is not a migration name");
    mkdirSync(join(path, "0002_old.sql"));
    rmSync(join(path, "notes.txt"));
    expect(() => readMigrations(path)).toThrow("0002_old.sql is a folder, not a migration file.");
  });

  it("reads db/migrations by default, and its files are named as the runner needs", () => {
    expect(MIGRATIONS_FOLDER.replaceAll("\\", "/")).toMatch(/\/db\/migrations\/?$/);
    const found = readMigrations();
    expect(found.map((migration) => migration.name)[0]).toBe("0001_foundation.sql");
    for (const migration of found) {
      expect(migration.sql.split("\n")[0]).toBe("-- SPDX-License-Identifier: AGPL-3.0-only");
    }
  });
});
