import { describe, it, expect } from "vitest";
import {
  validateBatchSize,
  formatBatchResults,
  MAX_BATCH_SIZE,
} from "../src/utils/batchUtils.js";
import type { BatchResult } from "../src/utils/batchUtils.js";

describe("validateBatchSize", () => {
  it("returns null for valid batch sizes", () => {
    expect(validateBatchSize(1)).toBeNull();
    expect(validateBatchSize(5)).toBeNull();
    expect(validateBatchSize(MAX_BATCH_SIZE)).toBeNull();
  });

  it("returns error for zero or negative operations", () => {
    expect(validateBatchSize(0)).toBe(
      "Batch must contain at least one operation",
    );
    expect(validateBatchSize(-1)).toBe(
      "Batch must contain at least one operation",
    );
    expect(validateBatchSize(-100)).toBe(
      "Batch must contain at least one operation",
    );
  });

  it("returns error for batch exceeding maximum", () => {
    expect(validateBatchSize(MAX_BATCH_SIZE + 1)).toBe(
      `Batch size exceeds maximum of ${MAX_BATCH_SIZE}`,
    );
  });
});

describe("formatBatchResults", () => {
  it("formats successful results with headers", () => {
    const results: BatchResult[] = [
      { index: 0, path: "file1.md", success: true, content: "Hello" },
      { index: 1, path: "file2.md", success: true, content: "World" },
    ];
    const output = formatBatchResults(results);
    expect(output).toContain("--- [1/2] file1.md ---");
    expect(output).toContain("Hello");
    expect(output).toContain("--- [2/2] file2.md ---");
    expect(output).toContain("World");
  });

  it("formats error results with ERROR prefix", () => {
    const results: BatchResult[] = [
      { index: 0, path: "good.md", success: true, content: "OK" },
      { index: 1, path: "bad.md", success: false, content: "File not found" },
    ];
    const output = formatBatchResults(results);
    expect(output).toContain("--- [1/2] good.md ---");
    expect(output).toContain("OK");
    expect(output).toContain("--- [2/2] bad.md ---");
    expect(output).toContain("ERROR: File not found");
  });

  it("handles single result", () => {
    const results: BatchResult[] = [
      { index: 0, path: "only.md", success: true, content: "Content" },
    ];
    const output = formatBatchResults(results);
    expect(output).toContain("--- [1/1] only.md ---");
    expect(output).toContain("Content");
  });
});
