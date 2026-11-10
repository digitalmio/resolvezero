import type { CompileTarget } from "./db";

/** A list is stale when forced, never compiled, or older than the interval. */
export function isStale(
  target: Pick<CompileTarget, "artifactHash" | "compiledAt">,
  nowSeconds: number,
  intervalSeconds: number,
  force = false,
): boolean {
  if (force) return true;
  if (target.artifactHash == null || target.compiledAt == null) return true;
  return nowSeconds - target.compiledAt >= intervalSeconds;
}
