import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import crypto from "node:crypto";
import { mkdir, writeFile, rm, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerFileOperations } from "../src/tools/fileOperations.js";
import { registerDirectoryOps } from "../src/tools/directoryOps.js";
import { registerSearchOperations } from "../src/tools/searchOperations.js";
import { registerVaultOperations } from "../src/tools/vaultOperations.js";
import { initDebouncedSync, stopDebouncedSync } from "../src/git/debouncedSync.js";
import { createTestConfig } from "./helpers/testConfig.js";

const TEST_VAULT = "/tmp/test-vault-integration";

const testConfig = createTestConfig({ vaultPath: TEST_VAULT });

describe("Integration: MCP Server over Streamable HTTP", () => {
  let httpServer: Server;
  let client: Client;
  let baseUrl: string;

  beforeAll(async () => {
    // Prepare test vault
    await mkdir(TEST_VAULT, { recursive: true });

    // Resolve symlinks (macOS /tmp → /private/tmp) so path validation passes
    const resolvedVault = await realpath(TEST_VAULT);
    testConfig.vaultPath = resolvedVault;

    await writeFile(path.join(resolvedVault, "hello.md"), "# Hello World\n\nThis is a test note.\n\n#test #example\n");
    await mkdir(path.join(resolvedVault, "subfolder"), { recursive: true });
    await writeFile(path.join(resolvedVault, "subfolder", "nested.md"), "Nested note with [[hello]] link.\n");

    // Create .claude directory that should be hidden from all listings/searches
    await mkdir(path.join(resolvedVault, ".claude", "skills"), { recursive: true });
    await writeFile(path.join(resolvedVault, ".claude", "skills", "test-skill.md"), "# Skill file\n");

    // Initialize debounced sync for write tools
    initDebouncedSync(testConfig);

    // Initialize git repo with a local bare remote so stageCommitAndPush works in write tests
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: resolvedVault });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: resolvedVault });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: resolvedVault });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: resolvedVault });
    await execFileAsync("git", ["add", "."], { cwd: resolvedVault });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: resolvedVault });

    // Create a bare repo as a local "remote" so git push/pull succeed
    const bareRepoPath = resolvedVault + "-bare.git";
    await execFileAsync("git", ["clone", "--bare", resolvedVault, bareRepoPath]);
    await execFileAsync("git", ["remote", "add", "origin", bareRepoPath], { cwd: resolvedVault });

    // Factory creates a fresh McpServer per session (mirrors production pattern)
    const createMcpServer = () => {
      const server = new McpServer({
        name: "test-server",
        version: "1.0.0",
      });
      registerFileOperations(server, testConfig);
      registerDirectoryOps(server, testConfig);
      registerSearchOperations(server, testConfig);
      registerVaultOperations(server, testConfig);
      return server;
    };

    // Set up Express app with Streamable HTTP transport
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
      await createMcpServer().connect(transport);
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

    // Start server on random port
    httpServer = app.listen(0);
    const port = (httpServer.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;

    // Create MCP client
    client = new Client({ name: "test-client", version: "1.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
    );
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    stopDebouncedSync();
    await client?.close();
    httpServer?.close();
    await rm(TEST_VAULT, { recursive: true, force: true });
    await rm(TEST_VAULT + "-bare.git", { recursive: true, force: true });
  });

  it("lists available tools", async () => {
    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
    expect(toolNames).toContain("delete_file");
    expect(toolNames).toContain("rename_file");
    expect(toolNames).toContain("list_directory");
    expect(toolNames).toContain("create_directory");
    expect(toolNames).toContain("search_files");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("find_files");
    expect(toolNames).toContain("get_vault_info");
    expect(toolNames).toContain("get_backlinks");
    expect(toolNames).toContain("get_tags");
  });

  it("reads a file", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "hello.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("# Hello World");
  });

  it("lists directory contents", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: "." },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("hello.md");
    expect(text).toContain("subfolder/");
  });

  it("excludes symlinks pointing outside vault from directory listing", async () => {
    const outsideDir = testConfig.vaultPath + "-outside";
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "secret.txt"), "should not appear");

    const symlinkPath = path.join(testConfig.vaultPath, "escape-link");
    try {
      await symlink(outsideDir, symlinkPath, "dir");

      const result = await client.callTool({
        name: "list_directory",
        arguments: { path: ".", recursive: true },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).not.toContain("escape-link");
      expect(text).not.toContain("secret.txt");
    } finally {
      await rm(symlinkPath, { force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("searches files by pattern", async () => {
    const result = await client.callTool({
      name: "search_files",
      arguments: { pattern: "**/*.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("hello.md");
    expect(text).toContain("subfolder/nested.md");
  });

  it("greps file contents", async () => {
    const result = await client.callTool({
      name: "grep",
      arguments: { query: "Hello World" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("hello.md");
  });

  it("gets backlinks", async () => {
    const result = await client.callTool({
      name: "get_backlinks",
      arguments: { path: "hello.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("subfolder/nested.md");
  });

  it("gets tags", async () => {
    const result = await client.callTool({
      name: "get_tags",
      arguments: { path: "hello.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("#test");
    expect(text).toContain("#example");
  });

  it("gets vault info", async () => {
    const result = await client.callTool({
      name: "get_vault_info",
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Total files:");
    expect(text).toContain("Markdown files:");
  });

  it("excludes .claude directory from list_directory", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: "." },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toContain(".claude");
  });

  it("excludes .claude directory from recursive list_directory", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: ".", recursive: true },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toContain(".claude");
    expect(text).not.toContain("test-skill");
  });

  it("excludes .claude files from search_files", async () => {
    const result = await client.callTool({
      name: "search_files",
      arguments: { pattern: "**/*.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toContain(".claude");
    expect(text).not.toContain("test-skill");
  });

  it("excludes .claude files from grep", async () => {
    const result = await client.callTool({
      name: "grep",
      arguments: { query: "Skill file" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe("No matches found");
  });

  it("excludes .claude files from find_files", async () => {
    const result = await client.callTool({
      name: "find_files",
      arguments: { name: "**/*.md" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toContain(".claude");
    expect(text).not.toContain("test-skill");
  });

  it("excludes .claude from get_vault_info stats and folders", async () => {
    const result = await client.callTool({
      name: "get_vault_info",
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toContain(".claude");
  });

  it("returns error for path traversal attempt", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "../../etc/passwd" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("traversal");
  });

  it("supports multiple concurrent sessions without 'Already connected' error", async () => {
    // Second client connects to the same server — must not fail
    const secondClient = new Client({ name: "test-client-2", version: "1.0.0" });
    const secondTransport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
    );
    await secondClient.connect(secondTransport);

    // Both clients can list tools independently
    const [firstResult, secondResult] = await Promise.all([
      client.listTools(),
      secondClient.listTools(),
    ]);

    expect(firstResult.tools.length).toBeGreaterThan(0);
    expect(secondResult.tools.length).toBeGreaterThan(0);
    expect(firstResult.tools.map(t => t.name)).toContain("read_file");
    expect(secondResult.tools.map(t => t.name)).toContain("read_file");

    await secondClient.close();
  });

  // --- Batch list_directory tests ---

  it("batch lists multiple directories via paths array", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { paths: [".", "subfolder"] },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("--- [1/2] . ---");
    expect(text).toContain("hello.md");
    expect(text).toContain("subfolder/");
    expect(text).toContain("--- [2/2] subfolder ---");
    expect(text).toContain("subfolder/nested.md");
  });

  it("batch list_directory handles partial failure", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { paths: [".", "nonexistent-dir"] },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("--- [1/2] . ---");
    expect(text).toContain("hello.md");
    expect(text).toContain("--- [2/2] nonexistent-dir ---");
    expect(text).toContain("ERROR:");
  });

  it("batch list_directory rejects empty batch", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { paths: [] },
    });
    expect(result.isError).toBe(true);
  });

  it("batch list_directory with recursive option", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { paths: [".", "subfolder"], recursive: true },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("--- [1/2] . ---");
    expect(text).toContain("subfolder/nested.md");
    expect(text).toContain("--- [2/2] subfolder ---");
  });

  it("batch list_directory excludes .claude directory", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { paths: [".", "subfolder"] },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toContain(".claude");
  });

  it("single path via path param preserves backward compatibility", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: "subfolder" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("subfolder/nested.md");
    // Single-path mode should NOT use batch format
    expect(text).not.toContain("---");
  });

  it("list_directory defaults to vault root when no path or paths given", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("hello.md");
    expect(text).toContain("subfolder/");
  });

  it("batch list_directory reports not-a-directory error for file paths", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { paths: ["hello.md"] },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Not a directory");
  });

  // --- Batch read_file tests ---

  it("batch reads multiple files via paths array", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { paths: ["hello.md", "subfolder/nested.md"] },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("--- [1/2] hello.md ---");
    expect(text).toContain("# Hello World");
    expect(text).toContain("--- [2/2] subfolder/nested.md ---");
    expect(text).toContain("Nested note");
  });

  it("batch read handles partial failure", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { paths: ["hello.md", "nonexistent.md"] },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("--- [1/2] hello.md ---");
    expect(text).toContain("# Hello World");
    expect(text).toContain("--- [2/2] nonexistent.md ---");
    expect(text).toContain("ERROR:");
  });

  it("batch read rejects empty batch", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { paths: [] },
    });
    expect(result.isError).toBe(true);
  });

  // --- Batch write_file tests ---

  it("batch writes multiple files with single git commit", async () => {
    const result = await client.callTool({
      name: "write_file",
      arguments: {
        files: [
          { path: "batch1.md", content: "Batch file 1" },
          { path: "batch2.md", content: "Batch file 2" },
        ],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("--- [1/2] batch1.md ---");
    expect(text).toContain("File written: batch1.md");
    expect(text).toContain("--- [2/2] batch2.md ---");
    expect(text).toContain("File written: batch2.md");

    // Verify files were actually written
    const read1 = await client.callTool({ name: "read_file", arguments: { path: "batch1.md" } });
    expect((read1.content as Array<{ type: string; text: string }>)[0].text).toBe("Batch file 1");
  });

  // --- Batch edit_file tests ---

  it("batch edits multiple files with single git commit", async () => {
    // Setup: write two files first
    await client.callTool({
      name: "write_file",
      arguments: { files: [
        { path: "edit-batch1.md", content: "Original text A" },
        { path: "edit-batch2.md", content: "Original text B" },
      ]},
    });

    const result = await client.callTool({
      name: "edit_file",
      arguments: {
        edits: [
          { path: "edit-batch1.md", old_text: "Original text A", new_text: "Modified text A" },
          { path: "edit-batch2.md", old_text: "Original text B", new_text: "Modified text B" },
        ],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("File edited: edit-batch1.md");
    expect(text).toContain("File edited: edit-batch2.md");

    // Verify edits
    const read1 = await client.callTool({ name: "read_file", arguments: { path: "edit-batch1.md" } });
    expect((read1.content as Array<{ type: string; text: string }>)[0].text).toBe("Modified text A");
  });

  it("batch edit handles partial failure", async () => {
    await client.callTool({
      name: "write_file",
      arguments: { path: "edit-partial.md", content: "Some content" },
    });

    const result = await client.callTool({
      name: "edit_file",
      arguments: {
        edits: [
          { path: "edit-partial.md", old_text: "Some content", new_text: "New content" },
          { path: "edit-partial.md", old_text: "Does not exist", new_text: "Replacement" },
        ],
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("File edited: edit-partial.md");
    expect(text).toContain("ERROR:");
  });
});
