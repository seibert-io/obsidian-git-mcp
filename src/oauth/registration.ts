import type { Request, Response } from "express";
import { oauthStore } from "./store.js";
import { RateLimiter } from "../utils/rateLimiter.js";
import { logger } from "../utils/logger.js";

const ALLOWED_REDIRECT_HOSTS = [
  "claude.ai",
  "claude.com",
];

const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"];
const SUPPORTED_RESPONSE_TYPES = ["code"];
const SUPPORTED_AUTH_METHODS = ["client_secret_post"];
const MAX_CLIENTS = 500;

export const registrationRateLimiter = new RateLimiter(10, 60_000);

export function handleRegistration() {
  return (req: Request, res: Response): void => {
    const ip = req.ip ?? "unknown";
    if (!registrationRateLimiter.check(ip)) {
      res.status(429).json({ error: "too_many_requests" });
      return;
    }

    if (oauthStore.clientCount() >= MAX_CLIENTS) {
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

    // Validate redirect URIs
    for (const uri of redirect_uris) {
      try {
        const parsed = new URL(uri);
        if (parsed.protocol !== "https:") {
          res.status(400).json({ error: "invalid_request", error_description: "redirect_uris must use HTTPS" });
          return;
        }
        if (!ALLOWED_REDIRECT_HOSTS.some((h) => parsed.hostname === h)) {
          res.status(400).json({ error: "invalid_request", error_description: `Redirect host not allowed: ${parsed.hostname}` });
          return;
        }
      } catch {
        res.status(400).json({ error: "invalid_request", error_description: `Invalid redirect URI: ${uri}` });
        return;
      }
    }

    // Validate grant_types against supported values
    const requestedGrantTypes = grant_types ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(requestedGrantTypes)) {
      res.status(400).json({ error: "invalid_request", error_description: "grant_types must be an array" });
      return;
    }
    for (const gt of requestedGrantTypes) {
      if (!SUPPORTED_GRANT_TYPES.includes(gt)) {
        res.status(400).json({ error: "invalid_request", error_description: `Unsupported grant_type: ${gt}` });
        return;
      }
    }

    // Validate response_types against supported values
    const requestedResponseTypes = response_types ?? ["code"];
    if (!Array.isArray(requestedResponseTypes)) {
      res.status(400).json({ error: "invalid_request", error_description: "response_types must be an array" });
      return;
    }
    for (const rt of requestedResponseTypes) {
      if (!SUPPORTED_RESPONSE_TYPES.includes(rt)) {
        res.status(400).json({ error: "invalid_request", error_description: `Unsupported response_type: ${rt}` });
        return;
      }
    }

    // Validate token_endpoint_auth_method
    const requestedAuthMethod = token_endpoint_auth_method ?? "client_secret_post";
    if (!SUPPORTED_AUTH_METHODS.includes(requestedAuthMethod)) {
      res.status(400).json({ error: "invalid_request", error_description: `Unsupported token_endpoint_auth_method: ${requestedAuthMethod}` });
      return;
    }

    const client = oauthStore.registerClient(
      client_name,
      redirect_uris,
      requestedGrantTypes,
      requestedResponseTypes,
      requestedAuthMethod,
    );

    logger.info("OAuth client registered", { clientId: client.clientId, clientName: client.clientName });

    res.status(201).json({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    });
  };
}
