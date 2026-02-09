export const MAX_BATCH_SIZE = 10;

export interface BatchResult {
  readonly index: number;
  readonly path: string;
  readonly success: boolean;
  readonly content: string;
}

export function validateBatchSize(count: number): string | null {
  if (count < 1) return "Batch must contain at least one operation";
  if (count > MAX_BATCH_SIZE)
    return `Batch size exceeds maximum of ${MAX_BATCH_SIZE}`;
  return null;
}

export function formatBatchResults(results: readonly BatchResult[]): string {
  return results
    .map(
      (r) =>
        `--- [${r.index + 1}/${results.length}] ${r.path} ---\n${r.success ? r.content : `ERROR: ${r.content}`}`,
    )
    .join("\n\n");
}
