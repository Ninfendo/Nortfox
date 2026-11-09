// SPDX-License-Identifier: AGPL-3.0-only

// Keeps every container image pinned (docs/decisions/0010-quality-gates.md).
// Each image that a workflow, a compose file or a Dockerfile names carries its
// digest, so a tag that moves never changes what CI or an install runs. And
// every PostgreSQL image has one digest, so the database tests, CI and an
// install all run the same PostgreSQL.

export interface ImageUse {
  readonly path: string;
  readonly line: number;
  readonly image: string;
}

/** Whether a file can name a container image: a YAML file or a Dockerfile. */
export function readsImages(path: string): boolean {
  return /\.ya?ml$/.test(path) || /(?:^|\/)Dockerfile$/.test(path);
}

/** A YAML line with an image: key, or a step that uses a docker:// action. */
const YAML_IMAGE = /^\s*(?:-\s+)?(?:image:\s*|uses:\s*docker:\/\/)(.*)$/;

/** A Dockerfile's FROM line: its image, and the name it gives the stage. */
const FROM = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i;

/** An image pinned by its digest. */
const PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/** A YAML value without its quotes and a comment after it. */
export function yamlValue(text: string): string {
  return text
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
}

/** The images a file names, each with its line. */
export function imagesIn(path: string, text: string): ImageUse[] {
  const lines = text.split(/\r?\n/);
  const found: ImageUse[] = [];
  if (/\.ya?ml$/.test(path)) {
    for (const [index, line] of lines.entries()) {
      const value = YAML_IMAGE.exec(line)?.[1];
      if (value !== undefined) {
        found.push({ path, line: index + 1, image: yamlValue(value) });
      }
    }
    return found;
  }
  const stages = new Set(["scratch"]);
  for (const [index, line] of lines.entries()) {
    const from = FROM.exec(line);
    const image = from?.[1];
    if (image === undefined) {
      continue;
    }
    if (!stages.has(image.toLowerCase())) {
      found.push({ path, line: index + 1, image });
    }
    const stage = from?.[2];
    if (stage !== undefined) {
      stages.add(stage.toLowerCase());
    }
  }
  return found;
}

/** Whether an image is PostgreSQL's own: its name, without a registry, tag or digest, ends in postgres. */
export function isPostgres(image: string): boolean {
  const name = image.split("@")[0]?.split(":")[0] ?? "";
  return /(?:^|\/)postgres$/.test(name);
}

/** What is wrong with the images, in plain words; empty when nothing is. */
export function imageProblems(uses: readonly ImageUse[]): string[] {
  const problems: string[] = [];
  for (const use of uses) {
    if (!PINNED.test(use.image)) {
      problems.push(
        `${use.path}:${String(use.line)} uses the image ${use.image} without its digest. Pin it as name:tag@sha256: and the 64 hex digits of its digest.`,
      );
    }
  }
  const digests = new Map<string, string[]>();
  for (const use of uses.filter((found) => isPostgres(found.image) && PINNED.test(found.image))) {
    const digest = use.image.slice(use.image.indexOf("@") + 1);
    digests.set(digest, [...(digests.get(digest) ?? []), `${use.path}:${String(use.line)}`]);
  }
  if (digests.size > 1) {
    const listed = [...digests].map(([digest, places]) => `${digest} (${places.join(", ")})`);
    problems.push(
      `The PostgreSQL images have ${String(digests.size)} digests: ${listed.slice(0, -1).join(", ")} and ${listed.at(-1) ?? ""}. ` +
        "Every PostgreSQL image uses one digest, so the tests, CI and an install run the same PostgreSQL.",
    );
  }
  return problems;
}
