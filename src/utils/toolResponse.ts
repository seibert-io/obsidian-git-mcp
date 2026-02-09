const MAX_ERROR_MESSAGE_LENGTH = 500;

export function sanitizeErrorForClient(message: string): string {
  let sanitized = message;
  sanitized = sanitized.replace(
    /\/(?:vault|tmp|private|home|var|usr|etc|app|root|opt|mnt|data)\/[^\s:'"]+/g,
    (match) => {
      const parts = match.split("/");
      return parts[parts.length - 1];
    },
  );
  sanitized = sanitized.replace(/\b[0-9a-f]{40}\b/g, "<hash>");
  sanitized = sanitized.replace(/refs\/[^\s]+/g, "<ref>");
  if (sanitized.length > MAX_ERROR_MESSAGE_LENGTH) {
    sanitized = sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH) + "...";
  }
  return sanitized;
}

export function toolError(message: string) {
  return { content: [{ type: "text" as const, text: sanitizeErrorForClient(message) }], isError: true };
}

export function toolSuccess(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
