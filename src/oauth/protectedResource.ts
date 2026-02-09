import type { Request, Response } from "express";
import type { Config } from "../config.js";

/**
 * GET /.well-known/oauth-protected-resource
 *
 * RFC 9728 Protected Resource Metadata. MCP clients fetch this first
 * to discover which authorization server protects the /mcp endpoint.
 */
export function handleProtectedResource(config: Config) {
  return (_req: Request, res: Response): void => {
    res.json({
      resource: config.serverUrl,
      authorization_servers: [config.serverUrl],
    });
  };
}
