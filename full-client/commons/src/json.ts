/**
 * Everything this app reads was written by another program, sometimes halfway:
 * treat any value as a plain object without trusting its shape. Not an object -> {}.
 */
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
export const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
