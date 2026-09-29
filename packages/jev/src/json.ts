/**
 * The structural test both wire directions need.
 *
 * A request member and a response member are JSON objects, and telling a JSON
 * object from a string, an array or `null` is the same check on both sides. It
 * lives in one module so the two sides cannot drift into disagreeing about what
 * an object is.
 * @module @wowyuarm/dsh-jev/json
 */

/**
 * Whether a value is a JSON object.
 *
 * @param value — the value to test.
 * @returns `true` for an object that is neither `null` nor an array.
 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
