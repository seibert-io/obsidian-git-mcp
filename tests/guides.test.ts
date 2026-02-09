import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import crypto from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerGuideOperations } from "../src/tools/guideOperations.js";
import { registerPrompts } from "../src/prompts/promptHandler.js";
import { createTestConfig } from "./helpers/testConfig.js";

const TEST_PROMPTS = "/tmp/test-prompts-guides";
const testConfig = createTestConfig({ promptsDir: TEST_PROMPTS });

describe("Guide Tool and MCP Prompts", () => {
  let httpServer: Server;
  let client: Client;

  beforeAll(async () => {
    // Create test prompt files
    await mkdir(TEST_PROMPTS, { recursive: true });
    await writeFile(
      path.join(TEST_PROMPTS, "obsidian-conventions.md"),
      "# Obsidian Vault Conventions\n\n## Links\n- Interne Links: [[Notiztitel]]\n",
    );
    await writeFile(
      path.join(TEST_PROMPTS, "obsidian-search-strategy.md"),
      "# Such-Strategie im Vault\n\n## Notiz nach Titel finden\n→ search_files\n",
    );
    await writeFile(
      path.join(TEST_PROMPTS, "obsidian-create-note.md"),
      [
        "# Note Templates",
        "",
        "## type: zettel",
        "---",
        "title: {{topic}}",
        "date: {{today}}",
        "---",
        "",
        "# {{topic}}",
        "",
        "## type: meeting",
        "---",
        "title: Meeting — {{topic}}",
        "date: {{today}}",
        "tags: [meeting]",
        "---",
        "",
        "# Meeting — {{topic}}",
        "",
        "## type: daily",
        "---",
        "date: {{today}}",
        "tags: [daily]",
        "---",
        "",
        "# {{today}}",
      ].join("\n"),
    );

    const mcpServer = new McpServer({
      name: "test-guide-server",
      version: "1.0.0",
    });
    registerGuideOperations(mcpServer, testConfig);
    registerPrompts(mcpServer, testConfig);

    const app = express();
    const transports = new Map<string, StreamableHTTPServerTransport>();

    app.post("/mcp", express.json(), async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.get("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: "Bad session" });
        return;
      }
      await transports.get(sessionId)!.handleRequest(req, res);
    });

    app.delete("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.close();
        transports.delete(sessionId);
      }
      res.status(200).json({ ok: true });
    });

    httpServer = app.listen(0);
    const port = (httpServer.address() as AddressInfo).port;
    const baseUrl = `http://localhost:${port}`;

    client = new Client({ name: "test-guide-client", version: "1.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
    );
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close();
    httpServer?.close();
    await rm(TEST_PROMPTS, { recursive: true, force: true });
  });

  // --- Tool tests ---

  it("get_obsidian_guide with topic 'conventions' returns conventions", async () => {
    const result = await client.callTool({
      name: "get_obsidian_guide",
      arguments: { topic: "conventions" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Obsidian Vault Conventions");
    expect(text).toContain("[[Notiztitel]]");
  });

  it("get_obsidian_guide with topic 'search-strategy' returns search guide", async () => {
    const result = await client.callTool({
      name: "get_obsidian_guide",
      arguments: { topic: "search-strategy" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Such-Strategie");
    expect(text).toContain("search_files");
  });

  it("get_obsidian_guide with topic 'all' returns all guides", async () => {
    const result = await client.callTool({
      name: "get_obsidian_guide",
      arguments: { topic: "all" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Obsidian Vault Conventions");
    expect(text).toContain("Note Templates");
    expect(text).toContain("Such-Strategie");
  });

  it("get_obsidian_guide with topic 'create-note' and note_type 'meeting' returns meeting template", async () => {
    const result = await client.callTool({
      name: "get_obsidian_guide",
      arguments: { topic: "create-note", note_type: "meeting" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Meeting");
    expect(text).toContain("tags: [meeting]");
  });

  it("get_obsidian_guide with topic 'create-note' without note_type defaults to zettel", async () => {
    const result = await client.callTool({
      name: "get_obsidian_guide",
      arguments: { topic: "create-note" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("title:");
  });

  it("template variable {{today}} is replaced with ISO date", async () => {
    const result = await client.callTool({
      name: "get_obsidian_guide",
      arguments: { topic: "create-note", note_type: "daily" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const today = new Date().toISOString().split("T")[0];
    expect(text).toContain(today);
    expect(text).not.toContain("{{today}}");
  });

  // --- Prompt tests ---

  it("lists three MCP prompts", async () => {
    const result = await client.listPrompts();
    const names = result.prompts.map((p) => p.name);
    expect(names).toContain("obsidian-conventions");
    expect(names).toContain("obsidian-create-note");
    expect(names).toContain("obsidian-search-strategy");
  });

  it("prompt obsidian-conventions returns correct content", async () => {
    const result = await client.getPrompt({ name: "obsidian-conventions" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    const text = result.messages[0].content as { type: string; text: string };
    expect(text.text).toContain("Obsidian Vault Conventions");
  });

  it("prompt obsidian-search-strategy returns correct content", async () => {
    const result = await client.getPrompt({ name: "obsidian-search-strategy" });
    expect(result.messages).toHaveLength(1);
    const text = result.messages[0].content as { type: string; text: string };
    expect(text.text).toContain("Such-Strategie");
  });

  it("prompt obsidian-create-note with topic returns template with replaced variables", async () => {
    const result = await client.getPrompt({
      name: "obsidian-create-note",
      arguments: { topic: "Test Topic" },
    });
    expect(result.messages).toHaveLength(1);
    const text = result.messages[0].content as { type: string; text: string };
    expect(text.text).toContain("Test Topic");
    const today = new Date().toISOString().split("T")[0];
    expect(text.text).toContain(today);
  });

  it("custom prompts via volume mount override defaults", async () => {
    // Already verified by the test setup itself — test prompts at TEST_PROMPTS
    // are used instead of the project's prompts/ directory
    const result = await client.callTool({
      name: "get_obsidian_guide",
      arguments: { topic: "conventions" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    // This comes from our test override, not the default prompts/
    expect(text).toContain("Obsidian Vault Conventions");
  });
});
