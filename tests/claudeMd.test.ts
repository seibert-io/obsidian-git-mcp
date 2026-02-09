import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm, realpath, utimes } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadRootClaudeMd, collectClaudeMdFiles } from "../src/guides/claudeMdLoader.js";
import { createMcpServer } from "../src/server.js";
import { createTestConfig } from "./helpers/testConfig.js";
import { startMcpTestServer, initTestGitRepo } from "./helpers/mcpTestServer.js";

const TEST_VAULT = "/tmp/test-vault-claude-md";

// --- Unit Tests: claudeMdLoader ---

describe("claudeMdLoader", () => {
  let resolvedVault: string;

  beforeAll(async () => {
    await mkdir(TEST_VAULT, { recursive: true });
    resolvedVault = await realpath(TEST_VAULT);
  });

  afterAll(async () => {
    await rm(TEST_VAULT, { recursive: true, force: true });
  });

  describe("loadRootClaudeMd", () => {
    it("returns content when CLAUDE.md exists in vault root", async () => {
      await writeFile(path.join(resolvedVault, "CLAUDE.md"), "# Vault Instructions\n\nUse wikilinks.");
      const result = await loadRootClaudeMd(resolvedVault);
      expect(result).toBe("# Vault Instructions\n\nUse wikilinks.");
    });

    it("returns null when CLAUDE.md does not exist", async () => {
      const emptyVault = path.join(resolvedVault, "empty-sub");
      await mkdir(emptyVault, { recursive: true });
      const result = await loadRootClaudeMd(emptyVault);
      expect(result).toBeNull();
    });

    it("detects file changes via mtime", async () => {
      const claudeMdPath = path.join(resolvedVault, "CLAUDE.md");
      await writeFile(claudeMdPath, "version 1");

      const first = await loadRootClaudeMd(resolvedVault);
      expect(first).toBe("version 1");

      // Advance mtime to ensure cache invalidation
      const future = new Date(Date.now() + 2000);
      await writeFile(claudeMdPath, "version 2");
      await utimes(claudeMdPath, future, future);

      const second = await loadRootClaudeMd(resolvedVault);
      expect(second).toBe("version 2");
    });
  });

  describe("collectClaudeMdFiles", () => {
    beforeAll(async () => {
      // Create directory structure with CLAUDE.md files
      await mkdir(path.join(resolvedVault, "projects", "webapp"), { recursive: true });
      await writeFile(path.join(resolvedVault, "CLAUDE.md"), "root instructions");
      await writeFile(path.join(resolvedVault, "projects", "CLAUDE.md"), "project instructions");
      await writeFile(path.join(resolvedVault, "projects", "webapp", "CLAUDE.md"), "webapp instructions");
    });

    it("collects CLAUDE.md files along path, excluding root", async () => {
      const entries = await collectClaudeMdFiles(resolvedVault, "projects/webapp");
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ path: "projects", content: "project instructions" });
      expect(entries[1]).toEqual({ path: "projects/webapp", content: "webapp instructions" });
    });

    it("excludes root CLAUDE.md", async () => {
      const entries = await collectClaudeMdFiles(resolvedVault, "projects");
      const paths = entries.map((e) => e.path);
      expect(paths).not.toContain(".");
      expect(paths).not.toContain("");
    });

    it("returns empty array when no CLAUDE.md files on path", async () => {
      await mkdir(path.join(resolvedVault, "empty", "deep"), { recursive: true });
      const entries = await collectClaudeMdFiles(resolvedVault, "empty/deep");
      expect(entries).toEqual([]);
    });

    it("rejects path traversal attempts", async () => {
      await expect(
        collectClaudeMdFiles(resolvedVault, "../../etc"),
      ).rejects.toThrow(/traversal/i);
    });

    it("handles single directory level", async () => {
      const entries = await collectClaudeMdFiles(resolvedVault, "projects");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ path: "projects", content: "project instructions" });
    });

    it("handles target path that is vault root", async () => {
      const entries = await collectClaudeMdFiles(resolvedVault, ".");
      expect(entries).toEqual([]);
    });
  });
});

// --- Integration Tests: MCP Server with CLAUDE.md ---

describe("Integration: CLAUDE.md Discovery", () => {
  describe("with root CLAUDE.md", () => {
    let client: Client;
    let httpServer: Server;
    let resolvedVault: string;
    const VAULT_DIR = "/tmp/test-vault-claude-md-integration";

    beforeAll(async () => {
      await mkdir(VAULT_DIR, { recursive: true });
      resolvedVault = await realpath(VAULT_DIR);

      // Create CLAUDE.md hierarchy
      await mkdir(path.join(resolvedVault, "projects", "webapp"), { recursive: true });
      await writeFile(path.join(resolvedVault, "CLAUDE.md"), "# Root Instructions");
      await writeFile(path.join(resolvedVault, "projects", "CLAUDE.md"), "# Project Rules");
      await writeFile(path.join(resolvedVault, "projects", "webapp", "CLAUDE.md"), "# Webapp Guidelines");

      await initTestGitRepo(resolvedVault);

      const testConfig = createTestConfig({ vaultPath: resolvedVault });
      const mcpServer = await createMcpServer(testConfig);
      const testServer = await startMcpTestServer(mcpServer);
      client = testServer.client;
      httpServer = testServer.httpServer;
    });

    afterAll(async () => {
      await client?.close();
      httpServer?.close();
      await rm(VAULT_DIR, { recursive: true, force: true });
    });

    it("instructions direct client to call get_obsidian_guide", () => {
      const instructions = client.getInstructions();
      expect(instructions).toContain("get_obsidian_guide");
      expect(instructions).toContain("conventions");
    });

    it("instructions do not contain root CLAUDE.md content directly", () => {
      const instructions = client.getInstructions();
      expect(instructions).not.toContain("# Root Instructions");
    });

    it("instructions mention get_claude_context for subdirectories", () => {
      const instructions = client.getInstructions();
      expect(instructions).toContain("get_claude_context");
    });

    it("get_obsidian_guide with conventions delivers root CLAUDE.md", async () => {
      const result = await client.callTool({
        name: "get_obsidian_guide",
        arguments: { topic: "conventions" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("# Root Instructions");
      expect(text).toContain("Vault Instructions (CLAUDE.md)");
    });

    it("get_obsidian_guide with all delivers root CLAUDE.md", async () => {
      const result = await client.callTool({
        name: "get_obsidian_guide",
        arguments: { topic: "all" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("# Root Instructions");
    });

    it("lists get_claude_context in available tools", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("get_claude_context");
    });

    it("returns CLAUDE.md files for path with CLAUDE.md and scope info", async () => {
      const result = await client.callTool({
        name: "get_claude_context",
        arguments: { path: "projects/webapp" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("# Project Rules");
      expect(text).toContain("# Webapp Guidelines");
      expect(text).toContain("CLAUDE.md from projects/");
      expect(text).toContain("applies to projects/ and all its subdirectories");
      expect(text).toContain("CLAUDE.md from projects/webapp/");
      expect(text).toContain("applies to projects/webapp/ and all its subdirectories");
    });

    it("excludes root CLAUDE.md from get_claude_context results", async () => {
      const result = await client.callTool({
        name: "get_claude_context",
        arguments: { path: "projects" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("# Project Rules");
      expect(text).not.toContain("# Root Instructions");
    });

    it("returns no-files message for path without CLAUDE.md", async () => {
      await mkdir(path.join(resolvedVault, "nocontext"), { recursive: true });
      const result = await client.callTool({
        name: "get_claude_context",
        arguments: { path: "nocontext" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("No CLAUDE.md files found");
    });

    it("rejects path traversal in get_claude_context", async () => {
      const result = await client.callTool({
        name: "get_claude_context",
        arguments: { path: "../../etc" },
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("without root CLAUDE.md", () => {
    let client: Client;
    let httpServer: Server;
    const NO_ROOT_VAULT = "/tmp/test-vault-claude-md-no-root";

    beforeAll(async () => {
      await mkdir(NO_ROOT_VAULT, { recursive: true });
      const resolved = await realpath(NO_ROOT_VAULT);

      await writeFile(path.join(resolved, "readme.md"), "hello");
      await initTestGitRepo(resolved);

      const testConfig = createTestConfig({ vaultPath: resolved });
      const mcpServer = await createMcpServer(testConfig);
      const testServer = await startMcpTestServer(mcpServer);
      client = testServer.client;
      httpServer = testServer.httpServer;
    });

    afterAll(async () => {
      await client?.close();
      httpServer?.close();
      await rm(NO_ROOT_VAULT, { recursive: true, force: true });
    });

    it("instructions direct client to call get_obsidian_guide even without root CLAUDE.md", () => {
      const instructions = client.getInstructions();
      expect(instructions).toContain("get_obsidian_guide");
      expect(instructions).toContain("get_claude_context");
      expect(instructions).not.toContain("# Root Instructions");
    });
  });
});
