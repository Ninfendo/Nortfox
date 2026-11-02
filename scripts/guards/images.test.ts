// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitText, nulList } from "../names/git.ts";
import { imageProblems, imagesIn, isPostgres, readsImages } from "./images.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIGEST = "5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8";
const OTHER = "41a369edc91d9bdd7a58be6bc71ea0f8f7a3f49e82818a9f0829021ea7840b7c";

const tracked = nulList(gitText(ROOT, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));

describe("the repository", () => {
  it("pins every container image by its digest, and runs one PostgreSQL everywhere", () => {
    const uses = tracked.filter(readsImages).flatMap((path) => imagesIn(path, readFileSync(`${ROOT}/${path}`, "utf8")));
    expect(imageProblems(uses)).toEqual([]);
    const postgres = uses.filter((use) => isPostgres(use.image)).map((use) => use.path);
    expect(postgres).toEqual(expect.arrayContaining([".github/workflows/ci.yml", "deploy/test-database/compose.yaml"]));
  });
});

describe("the image guard", () => {
  it("reads the images of workflows, compose files and Dockerfiles", () => {
    expect(readsImages(".github/workflows/ci.yml")).toBe(true);
    expect(readsImages("deploy/compose.yaml")).toBe(true);
    expect(readsImages("deploy/server/Dockerfile")).toBe(true);
    expect(readsImages("Dockerfile")).toBe(true);
    expect(readsImages("deploy/README.md")).toBe(false);
    expect(
      imagesIn(
        ".github/workflows/ci.yml",
        [
          "jobs:",
          "  build:",
          "    services:",
          "      postgres:",
          `        image: postgres:18-bookworm@sha256:${DIGEST}`,
          `        image: "postgres:18@sha256:${DIGEST}" # quoted, with a comment`,
          "    steps:",
          `      - uses: docker://alpine:3@sha256:${OTHER}`,
          "      - uses: actions/checkout@v7",
          "      # image: not an image, a comment",
        ].join("\n"),
      ),
    ).toEqual([
      { path: ".github/workflows/ci.yml", line: 5, image: `postgres:18-bookworm@sha256:${DIGEST}` },
      { path: ".github/workflows/ci.yml", line: 6, image: `postgres:18@sha256:${DIGEST}` },
      { path: ".github/workflows/ci.yml", line: 8, image: `alpine:3@sha256:${OTHER}` },
    ]);
  });

  it("reads each FROM of a Dockerfile, but not a stage it built itself or scratch", () => {
    const dockerfile = [
      "# SPDX-License-Identifier: AGPL-3.0-only",
      `FROM --platform=linux/amd64 node:24-bookworm-slim@sha256:${DIGEST} AS build`,
      "FROM build AS test",
      "from scratch",
      `FROM postgres:18-bookworm@sha256:${DIGEST}`,
    ].join("\r\n");
    expect(imagesIn("deploy/postgres/Dockerfile", dockerfile)).toEqual([
      { path: "deploy/postgres/Dockerfile", line: 2, image: `node:24-bookworm-slim@sha256:${DIGEST}` },
      { path: "deploy/postgres/Dockerfile", line: 5, image: `postgres:18-bookworm@sha256:${DIGEST}` },
    ]);
  });

  it("passes images pinned by digest", () => {
    expect(
      imageProblems([
        { path: "a.yml", line: 1, image: `postgres:18-bookworm@sha256:${DIGEST}` },
        { path: "b.yml", line: 1, image: `docker.io/library/postgres@sha256:${DIGEST}` },
        { path: "c.yml", line: 1, image: `alpine:3@sha256:${OTHER}` },
      ]),
    ).toEqual([]);
  });

  it.each([
    ["a tag only", "postgres:18-bookworm"],
    ["no tag at all", "postgres"],
    ["a short digest", `postgres:18@sha256:${DIGEST.slice(1)}`],
    ["a digest in capitals", `postgres:18@sha256:${DIGEST.toUpperCase()}`],
    ["another algorithm", `postgres:18@sha512:${DIGEST}`],
    ["a variable", "${POSTGRES_IMAGE}"],
  ])("fails an image with %s", (_case, image) => {
    expect(imageProblems([{ path: "deploy/compose.yaml", line: 3, image }])).toEqual([
      `deploy/compose.yaml:3 uses the image ${image} without its digest. Pin it as name:tag@sha256: and the 64 hex digits of its digest.`,
    ]);
  });

  it("fails an unpinned FROM and an unpinned docker:// action", () => {
    expect(imageProblems(imagesIn("Dockerfile", "FROM node:24\n"))).toEqual([
      "Dockerfile:1 uses the image node:24 without its digest. Pin it as name:tag@sha256: and the 64 hex digits of its digest.",
    ]);
    expect(imageProblems(imagesIn("ci.yml", "      - uses: docker://alpine:3\n"))).toEqual([
      "ci.yml:1 uses the image alpine:3 without its digest. Pin it as name:tag@sha256: and the 64 hex digits of its digest.",
    ]);
  });

  it("fails two PostgreSQL images with two digests", () => {
    expect(
      imageProblems([
        { path: ".github/workflows/ci.yml", line: 30, image: `postgres:18-bookworm@sha256:${DIGEST}` },
        { path: "deploy/test-database/compose.yaml", line: 17, image: `postgres:18-bookworm@sha256:${OTHER}` },
        { path: "deploy/postgres/Dockerfile", line: 2, image: `docker.io/library/postgres:18@sha256:${OTHER}` },
      ]),
    ).toEqual([
      `The PostgreSQL images have 2 digests: sha256:${DIGEST} (.github/workflows/ci.yml:30) and sha256:${OTHER} (deploy/test-database/compose.yaml:17, deploy/postgres/Dockerfile:2). Every PostgreSQL image uses one digest, so the tests, CI and an install run the same PostgreSQL.`,
    ]);
  });

  it("knows a PostgreSQL image by its name", () => {
    expect(isPostgres(`postgres:18@sha256:${DIGEST}`)).toBe(true);
    expect(isPostgres(`docker.io/library/postgres:18@sha256:${DIGEST}`)).toBe(true);
    expect(isPostgres("postgres")).toBe(true);
    expect(isPostgres(`postgrest/postgrest:12@sha256:${DIGEST}`)).toBe(false);
  });
});
