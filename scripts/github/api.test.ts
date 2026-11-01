// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { startFakeGitHub, type FakeGitHub } from "../testing/fake-github.ts";
import { createGitHub, field, GitHubError, numberField, pullRequestContext, stringField, type Transport } from "./api.ts";

const servers: FakeGitHub[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function fake(routes: Parameters<typeof startFakeGitHub>[0]): Promise<FakeGitHub> {
  const server = await startFakeGitHub(routes);
  servers.push(server);
  return server;
}

describe("createGitHub", () => {
  it("sends the token and the API version", async () => {
    const seen: Record<string, string>[] = [];
    const transport: Transport = (_method, _url, headers) => {
      seen.push({ ...headers });
      return Promise.resolve({ status: 200, headers: {}, body: "{}" });
    };
    await createGitHub({ token: "secret", apiUrl: "https://api.example.com/", transport }).get("/x");
    expect(seen[0]).toMatchObject({ authorization: "Bearer secret", "x-github-api-version": "2022-11-28" });
  });

  it("reads JSON, a missing value, every page of a list, and deletes", async () => {
    const server = await fake({
      "GET /one": { body: { a: 1 } },
      "GET /list": { body: [1, 2], headers: { link: '<{base}/list?page=2>; rel="next", <{base}/list?page=9>; rel="last"' } },
      "GET /list?page=2": { body: [3] },
      "DELETE /label": { status: 204 },
    });
    const github = createGitHub({ token: "t", apiUrl: server.url });
    await expect(github.get("/one")).resolves.toEqual({ a: 1 });
    await expect(github.find("/one")).resolves.toEqual({ a: 1 });
    await expect(github.find("/none")).resolves.toBeUndefined();
    await expect(github.list("/list")).resolves.toEqual([1, 2, 3]);
    await expect(github.remove("/label")).resolves.toBeUndefined();
    await expect(github.remove("/gone")).resolves.toBeUndefined();
    expect(server.requests).toEqual([
      "GET /one",
      "GET /one",
      "GET /none",
      "GET /list",
      "GET /list?page=2",
      "DELETE /label",
      "DELETE /gone",
    ]);
  });

  it("fails on an error status, on 404 for a value it needs, and on a list that is not one", async () => {
    const server = await fake({ "GET /boom": { status: 502 }, "GET /object": { body: {} } });
    const github = createGitHub({ token: "t", apiUrl: server.url });
    await expect(github.get("/boom")).rejects.toThrow("GitHub answered 502 to GET /boom.");
    await expect(github.get("/none")).rejects.toThrow("GitHub answered 404 to GET /none.");
    await expect(github.list("/object")).rejects.toThrow("GitHub did not answer a list to GET /object.");
    await expect(github.get("/boom")).rejects.toBeInstanceOf(GitHubError);
    await expect(github.get("/boom")).rejects.toMatchObject({ name: "GitHubError", status: 502 });
  });

  it("never follows a next page to another host", async () => {
    const github = createGitHub({
      token: "t",
      apiUrl: "https://api.example.com",
      transport: () =>
        Promise.resolve({ status: 200, headers: { link: '<https://elsewhere.example.com/b>; rel="next"' }, body: "[]" }),
    });
    await expect(github.list("/a")).rejects.toThrow("GitHub linked the next page to another host.");
  });

  it("fails when the connection fails", async () => {
    const github = createGitHub({ token: "t", apiUrl: "http://127.0.0.1:1" });
    await expect(github.get("/x")).rejects.toThrow();
  });
});

describe("fields", () => {
  it("read what is there and refuse what is not", () => {
    expect(field({ a: 1 }, "a")).toBe(1);
    expect(field(null, "a")).toBeUndefined();
    expect(field("text", "a")).toBeUndefined();
    expect(stringField({ a: "x" }, "a")).toBe("x");
    expect(numberField({ a: 2 }, "a")).toBe(2);
    expect(() => stringField({ a: 1 }, "a")).toThrow('GitHub\'s answer has no text field "a".');
    expect(() => numberField({ a: "1" }, "a")).toThrow('GitHub\'s answer has no number field "a".');
  });
});

describe("pullRequestContext", () => {
  it("reads the settings", () => {
    const context = pullRequestContext({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", PR_NUMBER: "7" });
    expect(context).toMatchObject({ repository: "o/r", number: 7 });
  });

  it.each([
    [{ GITHUB_REPOSITORY: "o/r", PR_NUMBER: "7" }],
    [{ GITHUB_TOKEN: "", GITHUB_REPOSITORY: "o/r", PR_NUMBER: "7" }],
    [{ GITHUB_TOKEN: "t", PR_NUMBER: "7" }],
    [{ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", PR_NUMBER: "x" }],
    [{ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", PR_NUMBER: "0" }],
  ])("refuses %j", (env) => {
    expect(() => pullRequestContext(env)).toThrow("GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER must be set.");
  });
});
