/** Maximum file size for read/write/search operations (10 MB). */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Directory names excluded from all listings, searches, and vault stats. */
export const HIDDEN_DIRECTORIES = [".git", ".claude"] as const;

/** Glob ignore patterns derived from HIDDEN_DIRECTORIES (e.g. [".git/**", ".claude/**"]). */
export const HIDDEN_DIRECTORY_GLOBS = HIDDEN_DIRECTORIES.map((d) => `${d}/**`);
