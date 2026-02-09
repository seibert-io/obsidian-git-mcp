/**
 * GitHub API fetch mock for OAuth tests.
 *
 * Intercepts requests to github.com/login/oauth/access_token and
 * api.github.com/user, returning configurable mock responses.
 * All other URLs are passed through to the original fetch.
 *
 * Usage:
 *   beforeAll(() => installGitHubMock());
 *   beforeEach(() => resetGitHubMock());
 *   afterAll(() => uninstallGitHubMock());
 */

let originalFetch: typeof globalThis.fetch | undefined;

let mockGitHubTokenResponse: object = {};
let mockGitHubUserResponse: object = {};
let mockGitHubTokenStatus = 200;
let mockGitHubUserStatus = 200;

export function resetGitHubMock(): void {
  mockGitHubTokenResponse = { access_token: "gh_mock_token", token_type: "bearer", scope: "read:user" };
  mockGitHubUserResponse = { login: "AllowedUser", id: 12345 };
  mockGitHubTokenStatus = 200;
  mockGitHubUserStatus = 200;
}

export function setMockGitHubTokenResponse(response: object, status = 200): void {
  mockGitHubTokenResponse = response;
  mockGitHubTokenStatus = status;
}

export function setMockGitHubUserResponse(response: object, status = 200): void {
  mockGitHubUserResponse = response;
  mockGitHubUserStatus = status;
}

export function installGitHubMock(): void {
  if (originalFetch) return; // Already installed

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify(mockGitHubTokenResponse), {
        status: mockGitHubTokenStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify(mockGitHubUserResponse), {
        status: mockGitHubUserStatus,
        headers: { "Content-Type": "application/json" },
      });
    }

    return originalFetch!(input, init);
  };
}

export function uninstallGitHubMock(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
}
