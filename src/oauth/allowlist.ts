/**
 * Check whether a GitHub username is in the allowlist.
 * Comparison is case-insensitive (GitHub usernames are case-insensitive).
 */
export function isAllowedUser(
  username: string,
  allowedUsers: string[],
): boolean {
  const lower = username.toLowerCase();
  return allowedUsers.includes(lower);
}
