/**
 * Tolerant readers for API payloads.
 *
 * The models are built from JSON the server controls, so every reader here
 * accepts whatever arrives and falls back rather than throwing. A field this
 * library does not understand is never fatal, and every model keeps a `raw`
 * copy so nothing is lost either.
 *
 * @internal
 */

export type JsonObject = Readonly<Record<string, unknown>>;

const EMPTY: JsonObject = Object.freeze({});

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : EMPTY;
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value : String(value);
}

export function asInt(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return fallback;
}

export function asIntOrNull(value: unknown): number | null {
  const parsed = asInt(value, Number.NaN);
  return Number.isNaN(parsed) ? null : parsed;
}

/** A shallow, frozen copy, so a model's `raw` cannot be mutated through it. */
export function snapshot(value: unknown): JsonObject {
  return isObject(value) ? Object.freeze({ ...value }) : EMPTY;
}

/**
 * Accept an ISO-8601 string or epoch seconds (as a number or a digit string)
 * and return a `Date`, or `null` if the value is absent or unreadable.
 *
 * An ISO date-time without an offset is read as UTC, not local time: that is
 * what the server means, and `Date.parse` would otherwise shift it by the
 * caller's timezone.
 */
export function parseTimestamp(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value * 1000) : null;
  }
  if (typeof value !== "string") return null;

  let text = value.trim();
  if (/^\d+$/.test(text)) return new Date(Number(text) * 1000);
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(text)) text = `${text}Z`;

  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}
