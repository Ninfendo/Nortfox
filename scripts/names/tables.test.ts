// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Transport } from "../github/api.ts";
import { runGenerator, tableDifference } from "./tables.ts";

const TABLE = "# a header\nalpha 0061\nbeta 0062\n";
const noNetwork: Transport = () => Promise.reject(new Error("no network in this test"));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A table file holding the text, and a generator whose pinned file gives TABLE. */
function generatorFor(text: string | undefined): { file: URL; build: () => Promise<string> } {
  const dir = mkdtempSync(join(tmpdir(), "nortfox-tables-"));
  dirs.push(dir);
  const file = pathToFileURL(join(dir, "table.txt"));
  if (text !== undefined) {
    writeFileSync(file, text);
  }
  return { file, build: () => Promise.resolve(TABLE) };
}

describe("a table generator", () => {
  it("writes the table that the pinned file gives", async () => {
    const generator = generatorFor(undefined);
    await expect(runGenerator([], generator, noNetwork)).resolves.toEqual({
      code: 0,
      line: `Wrote ${fileURLToPath(generator.file)}.`,
    });
    expect(readFileSync(generator.file, "utf8")).toBe(TABLE);
  });

  it("with --check, passes the table the pinned file gives and writes nothing", async () => {
    const generator = generatorFor(TABLE);
    await expect(runGenerator(["--check"], generator, noNetwork)).resolves.toEqual({
      code: 0,
      line: `${fileURLToPath(generator.file)} is the table the pinned file gives.`,
    });
  });

  it.each([
    ["one changed value", "# a header\nalpha 0061\nbeta 0020\n", 'At line 3, the table has "beta 0020", and the pinned file gives "beta 0062".'],
    ["a changed header", "# a heater\nalpha 0061\nbeta 0062\n", 'At line 1, the table has "# a heater", and the pinned file gives "# a header".'],
    ["an entry too many", `${TABLE}gamma 0063\n`, 'At line 4, the table has "gamma 0063", and the pinned file ends.'],
    ["an empty line too many", `${TABLE}\n`, 'At line 4, the table has "", and the pinned file ends.'],
    ["an entry too few", "# a header\nalpha 0061\n", 'At line 3, the table ends, and the pinned file gives "beta 0062".'],
    ["no line break at its end", "# a header\nalpha 0061\nbeta 0062", "Only the line break at its end differs."],
    ["a carriage return", TABLE.replaceAll("\n", "\r\n"), 'At line 1, the table has "# a header\\r", and the pinned file gives "# a header".'],
  ])("with --check, fails a table with %s, names the line and writes nothing", async (_case, text, where) => {
    const generator = generatorFor(text);
    await expect(runGenerator(["--check"], generator, noNetwork)).resolves.toEqual({
      code: 1,
      line: `${fileURLToPath(generator.file)} is not the table the pinned file gives. ${where}`,
    });
    expect(readFileSync(generator.file, "utf8")).toBe(text);
  });

  it("refuses an unknown option, and neither downloads nor writes", async () => {
    const generator = { ...generatorFor(TABLE), build: () => Promise.reject(new Error("downloaded")) };
    await expect(runGenerator(["--chek"], generator, noNetwork)).resolves.toEqual({
      code: 2,
      line: 'Unknown option "--chek". Give no option to write the table, or --check to compare it.',
    });
    await expect(runGenerator(["--check", "x"], generator, noNetwork)).resolves.toMatchObject({ code: 2 });
    expect(readFileSync(generator.file, "utf8")).toBe(TABLE);
  });

  it("gives no result, and writes nothing, when the pinned file cannot be had", async () => {
    const generator = { ...generatorFor("old\n"), build: () => Promise.reject(new Error("answered 404.")) };
    await expect(runGenerator([], generator, noNetwork)).rejects.toThrow("answered 404.");
    await expect(runGenerator(["--check"], generator, noNetwork)).rejects.toThrow("answered 404.");
    expect(readFileSync(generator.file, "utf8")).toBe("old\n");
  });

  it("tells only whether two tables are the same", () => {
    expect(tableDifference("t.txt", TABLE, TABLE)).toBeUndefined();
    expect(tableDifference("t.txt", "", TABLE)).toBe(
      't.txt is not the table the pinned file gives. At line 1, the table ends, and the pinned file gives "# a header".',
    );
  });
});
