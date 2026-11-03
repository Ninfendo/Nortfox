// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A write takes an idempotency key: the same key with the same input gives
 * the first answer back instead of a second write (the IETF draft for the
 * Idempotency-Key header). On REST the key is a header. On MCP, where a tool
 * call has no headers of its own, it is a tool argument.
 */

/** The header that carries the key on REST. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** The tool argument that carries the key on MCP, and its pointer's name in a field problem. */
export const IDEMPOTENCY_KEY_ARGUMENT = "idempotencyKey";

/** The longest key, in characters. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * The key's alphabet: visible ASCII without `"` and `\`. So the header's
 * quoted form, `"key"`, needs no escapes.
 */
export const IDEMPOTENCY_KEY_PATTERN = String.raw`^[\x21\x23-\x5b\x5d-\x7e]+$`;

/** What a key is, for a person or an agent who writes one. */
export const IDEMPOTENCY_KEY_DESCRIPTION =
  'A key you choose for this write, 1 to 255 characters of visible ASCII without " and \\. Send the same key with the same input again, and you get the first answer back instead of a second write.';
