import type { Request, Response } from "express";
import type { OAuthStore } from "./store.js";
import type { TokenEndpointAuthMethod } from "./store.js";
import type { RateLimiter } from "../utils/rateLimiter.js";
import { logger } from "../utils/logger.js";

const ALLOWED_REDIRECT_HOSTS = [
  "claude.ai",
  "claude.com",
];

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"];
const SUPPORTED_RESPONSE_TYPES = ["code"];
const SUPPORTED_AUTH_METHODS: readonly TokenEndpointAuthMethod[] = ["client_secret_post", "none"];
const MAX_CLIENTS = 500;

/** Validate an array field against a set of supported values. */
function validateSupportedValues(
  field: unknown,
  defaults: string[],
  supported: string[],
  fieldName: string,
): { values: string[] } | { error: string } {
  const values = field ?? defaults;
  if (!Array.isArray(values)) {
    return { error: `${fieldName} must be an array` };
  }
  for (const v of values) {
    if (!supported.includes(v)) {
      return { error: `Unsupported ${fieldName}: ${v}` };
    }
  }
  return { values };
}

export function handleRegistration(store: OAuthStore, rateLimiter: RateLimiter) {
  return (req: Request, res: Response): void => {
    const ip = req.ip ?? "unknown";
    if (!rateLimiter.check(ip)) {
      res.status(429).json({ error: "too_many_requests" });
      return;
    }

    if (store.clientCount() >= MAX_CLIENTS) {
      res.status(503).json({ error: "server_error", error_description: "Maximum number of registered clients reached" });
      return;
    }

    const {
      client_name,
      redirect_uris,
      grant_types,
      response_types,
      token_endpoint_auth_method,
    } = req.body;

    if (!client_name || typeof client_name !== "string") {
      res.status(400).json({ error: "invalid_request", error_description: "client_name is required and must be a string" });
      return;
    }
    if (client_name.length > 256) {
      res.status(400).json({ error: "invalid_request", error_description: "client_name too long (max 256 characters)" });
      return;
    }
    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      res.status(400).json({ error: "invalid_request", error_description: "redirect_uris is required and must be a non-empty array" });
      return;
    }
    if (redirect_uris.length > 10) {
      res.status(400).json({ error: "invalid_request", error_description: "Too many redirect_uris (max 10)" });
      return;
    }

    // Validate redirect URIs (RFC 8252: loopback redirects may use HTTP)
    for (const uri of redirect_uris) {
      try {
        const parsed = new URL(uri);
        const isLoopback = LOOPBACK_HOSTS.includes(parsed.hostname);

        if (isLoopback) {
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            res.status(400).json({ error: "invalid_request", error_description: "Loopback redirect_uris must use HTTP or HTTPS" });
            return;
          }
        } else {
          if (parsed.protocol !== "https:") {
            res.status(400).json({ error: "invalid_request", error_description: "redirect_uris must use HTTPS" });
            return;
          }
          if (!ALLOWED_REDIRECT_HOSTS.some((h) => parsed.hostname === h)) {
            res.status(400).json({ error: "invalid_request", error_description: `Redirect host not allowed: ${parsed.hostname}` });
            return;
          }
        }
      } catch {
        res.status(400).json({ error: "invalid_request", error_description: `Invalid redirect URI: ${uri}` });
        return;
      }
    }

    const grantTypesResult = validateSupportedValues(grant_types, ["authorization_code", "refresh_token"], SUPPORTED_GRANT_TYPES, "grant_type");
    if ("error" in grantTypesResult) {
      res.status(400).json({ error: "invalid_request", error_description: grantTypesResult.error });
      return;
    }

    const responseTypesResult = validateSupportedValues(response_types, ["code"], SUPPORTED_RESPONSE_TYPES, "response_type");
    if ("error" in responseTypesResult) {
      res.status(400).json({ error: "invalid_request", error_description: responseTypesResult.error });
      return;
    }

    const requestedAuthMethod = (token_endpoint_auth_method ?? "client_secret_post") as string;
    if (!SUPPORTED_AUTH_METHODS.includes(requestedAuthMethod as TokenEndpointAuthMethod)) {
      res.status(400).json({ error: "invalid_request", error_description: `Unsupported token_endpoint_auth_method: ${requestedAuthMethod}` });
      return;
    }

    const client = store.registerClient({
      clientName: client_name,
      redirectUris: redirect_uris,
      grantTypes: grantTypesResult.values,
      responseTypes: responseTypesResult.values,
      tokenEndpointAuthMethod: requestedAuthMethod as TokenEndpointAuthMethod,
    });

    logger.info("OAuth client registered", { clientId: client.clientId, clientName: client.clientName });

    const response: Record<string, unknown> = {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    };
    if (client.clientSecret !== undefined) {
      response.client_secret = client.clientSecret;
    }
    res.status(201).json(response);
  };
}
