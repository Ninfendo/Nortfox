// SPDX-License-Identifier: AGPL-3.0-only

// A small GitHub REST client for the repository's own checks. It uses
// node:https (node:http only for a local test server), so the checks need no
// dependencies and the rule that only packages/client calls fetch holds here
// too.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export type Transport = (
  method: "GET" | "DELETE",
  url: string,
  headers: Readonly<Record<string, string>>,
) => Promise<RawResponse>;

export class GitHubError extends Error {
  override readonly name = "GitHubError";
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GitHub {
  /** GET a JSON value. */
  get(path: string): Promise<unknown>;
  /** GET a JSON value, or undefined on 404. */
  find(path: string): Promise<unknown>;
  /** GET every page of a JSON list. */
  list(path: string): Promise<unknown[]>;
  /** DELETE; a 404 counts as done. */
  remove(path: string): Promise<void>;
}

export const nodeTransport: Transport = (method, url, headers) =>
  new Promise((resolve, reject) => {
    const send = url.startsWith("http:") ? httpRequest : httpsRequest;
    const outgoing = send(url, { method, headers }, (incoming) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        body += chunk;
      });
      incoming.on("end", () => {
        const flat: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          flat[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        resolve({ status: incoming.statusCode ?? 0, headers: flat, body });
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });

function nextPage(link: string | undefined): string | undefined {
  for (const part of (link ?? "").split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
}

export function createGitHub(options: {
  readonly token: string;
  readonly apiUrl: string;
  readonly transport?: Transport;
}): GitHub {
  const transport = options.transport ?? nodeTransport;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${options.token}`,
    "user-agent": "nortfox-checks",
    "x-github-api-version": "2022-11-28",
  };
  const base = options.apiUrl.replace(/\/+$/, "");

  async function call(method: "GET" | "DELETE", url: string): Promise<RawResponse> {
    const response = await transport(method, url, headers);
    if (response.status === 404 || (response.status >= 200 && response.status < 300)) {
      return response;
    }
    throw new GitHubError(response.status, `GitHub answered ${String(response.status)} to ${method} ${url.slice(base.length)}.`);
  }

  function parse(response: RawResponse, url: string): unknown {
    if (response.status === 404) {
      throw new GitHubError(404, `GitHub answered 404 to GET ${url.slice(base.length)}.`);
    }
    return JSON.parse(response.body);
  }

  return {
    async get(path) {
      const url = `${base}${path}`;
      return parse(await call("GET", url), url);
    },
    async find(path) {
      const response = await call("GET", `${base}${path}`);
      return response.status === 404 ? undefined : (JSON.parse(response.body) as unknown);
    },
    async list(path) {
      const items: unknown[] = [];
      let url: string | undefined = `${base}${path}`;
      while (url !== undefined) {
        const response = await call("GET", url);
        const page = parse(response, url);
        if (!Array.isArray(page)) {
          throw new GitHubError(response.status, `GitHub did not answer a list to GET ${url.slice(base.length)}.`);
        }
        items.push(...(page as unknown[]));
        url = nextPage(response.headers["link"]);
        if (url !== undefined && !url.startsWith(`${base}/`)) {
          // The token goes with every request, so it never goes elsewhere.
          throw new GitHubError(response.status, "GitHub linked the next page to another host.");
        }
      }
      return items;
    },
    async remove(path) {
      await call("DELETE", `${base}${path}`);
    },
  };
}

/** Reads a property of an API object, which is unknown until checked. */
export function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

export function stringField(value: unknown, key: string): string {
  const found = field(value, key);
  if (typeof found !== "string") {
    throw new TypeError(`GitHub's answer has no text field "${key}".`);
  }
  return found;
}

export function numberField(value: unknown, key: string): number {
  const found = field(value, key);
  if (typeof found !== "number") {
    throw new TypeError(`GitHub's answer has no number field "${key}".`);
  }
  return found;
}

/** The settings every check reads from the Actions environment. */
export function pullRequestContext(env: Readonly<Record<string, string | undefined>>): {
  readonly repository: string;
  readonly number: number;
  readonly github: GitHub;
} {
  const token = env["GITHUB_TOKEN"];
  const repository = env["GITHUB_REPOSITORY"];
  const number = Number(env["PR_NUMBER"]);
  if (token === undefined || token === "" || repository === undefined || !Number.isInteger(number) || number <= 0) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER must be set.");
  }
  return {
    repository,
    number,
    github: createGitHub({ token, apiUrl: env["GITHUB_API_URL"] ?? "https://api.github.com" }),
  };
}
