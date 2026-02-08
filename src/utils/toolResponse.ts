export function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function toolSuccess(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
