import type { Request, Response } from "express";
import type { Config } from "../config.js";

export function handleMetadata(config: Config) {
  return (_req: Request, res: Response): void => {
    res.json({
      issuer: config.serverUrl,
      authorization_endpoint: `${config.serverUrl}/oauth/authorize`,
      token_endpoint: `${config.serverUrl}/oauth/token`,
      registration_endpoint: `${config.serverUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
  };
}
