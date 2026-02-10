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

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function getToolText(result: ToolResult): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

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

    // Create multi-line files for read_file_lines tests
    const multiLineContent = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} content`).join("\n");
    await writeFile(path.join(resolvedVault, "multiline.md"), multiLineContent);
    const largeContent = Array.from({ length: 600 }, (_, i) => `Row ${i + 1}`).join("\n");
    await writeFile(path.join(resolvedVault, "large.md"), largeContent);
    // Create a binary file for null-byte detection tests
    await writeFile(path.join(resolvedVault, "binary.dat"), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0A, 0x1A, 0x0A]));

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
    expect(toolNames).toContain("read_file_lines");
    expect(toolNames).not.toContain("tail_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
    expect(toolNames).toContain("delete_file");
    expect(toolNames).toContain("rename_file");
    expect(toolNames).toContain("move_file");
    expect(toolNames).toContain("move_directory");
    expect(toolNames).toContain("is_directory");
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
    const text = getToolText(result);
    expect(text).toContain("# Hello World");
  });

  it("lists directory contents", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: "." },
    });
    const text = getToolText(result);
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
      const text = getToolText(result);
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
    const text = getToolText(result);
    expect(text).toContain("hello.md");
    expect(text).toContain("subfolder/nested.md");
  });

  it("greps file contents", async () => {
    const result = await client.callTool({
      name: "grep",
      arguments: { query: "Hello World" },
    });
    const text = getToolText(result);
    expect(text).toContain("hello.md");
  });

  it("gets backlinks", async () => {
    const result = await client.callTool({
      name: "get_backlinks",
      arguments: { path: "hello.md" },
    });
    const text = getToolText(result);
    expect(text).toContain("subfolder/nested.md");
  });

  it("gets tags", async () => {
    const result = await client.callTool({
      name: "get_tags",
      arguments: { path: "hello.md" },
    });
    const text = getToolText(result);
    expect(text).toContain("#test");
    expect(text).toContain("#example");
  });

  it("gets vault info", async () => {
    const result = await client.callTool({
      name: "get_vault_info",
      arguments: {},
    });
    const text = getToolText(result);
    expect(text).toContain("Total files:");
    expect(text).toContain("Markdown files:");
  });

  it("excludes .claude directory from list_directory", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: "." },
    });
    const text = getToolText(result);
    expect(text).not.toContain(".claude");
  });

  it("excludes .claude directory from recursive list_directory", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: ".", recursive: true },
    });
    const text = getToolText(result);
    expect(text).not.toContain(".claude");
    expect(text).not.toContain("test-skill");
  });

  it("excludes .claude files from search_files", async () => {
    const result = await client.callTool({
      name: "search_files",
      arguments: { pattern: "**/*.md" },
    });
    const text = getToolText(result);
    expect(text).not.toContain(".claude");
    expect(text).not.toContain("test-skill");
  });

  it("excludes .claude files from grep", async () => {
    const result = await client.callTool({
      name: "grep",
      arguments: { query: "Skill file" },
    });
    const text = getToolText(result);
    expect(text).toBe("No matches found");
  });

  it("excludes .claude files from find_files", async () => {
    const result = await client.callTool({
      name: "find_files",
      arguments: { name: "**/*.md" },
    });
    const text = getToolText(result);
    expect(text).not.toContain(".claude");
    expect(text).not.toContain("test-skill");
  });

  it("excludes .claude from get_vault_info stats and folders", async () => {
    const result = await client.callTool({
      name: "get_vault_info",
      arguments: {},
    });
    const text = getToolText(result);
    expect(text).not.toContain(".claude");
  });

  it("returns error for path traversal attempt", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "../../etc/passwd" },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
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
    const text = getToolText(result);
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
    const text = getToolText(result);
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
    const text = getToolText(result);
    expect(text).toContain("--- [1/2] . ---");
    expect(text).toContain("subfolder/nested.md");
    expect(text).toContain("--- [2/2] subfolder ---");
  });

  it("batch list_directory excludes .claude directory", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { paths: [".", "subfolder"] },
    });
    const text = getToolText(result);
    expect(text).not.toContain(".claude");
  });

  it("single path via path param preserves backward compatibility", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { path: "subfolder" },
    });
    const text = getToolText(result);
    expect(text).toContain("subfolder/nested.md");
    // Single-path mode should NOT use batch format
    expect(text).not.toContain("---");
  });

  it("list_directory defaults to vault root when no path or paths given", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: {},
    });
    const text = getToolText(result);
    expect(text).toContain("hello.md");
    expect(text).toContain("subfolder/");
  });

  it("batch list_directory reports not-a-directory error for file paths", async () => {
    const result = await client.callTool({
      name: "list_directory",
      arguments: { paths: ["hello.md"] },
    });
    const text = getToolText(result);
    expect(text).toContain("Not a directory");
  });

  // --- Batch read_file tests ---

  it("batch reads multiple files via paths array", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { paths: ["hello.md", "subfolder/nested.md"] },
    });
    const text = getToolText(result);
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
    const text = getToolText(result);
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

  // --- read_file_lines tests ---

  it("reads a specific line range from a file", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "multiline.md", start_line: 3, end_line: 5 },
    });
    const text = getToolText(result);
    expect(text).toContain("Lines 3-5 of 20 total lines");
    expect(text).toContain("3: Line 3 content");
    expect(text).toContain("4: Line 4 content");
    expect(text).toContain("5: Line 5 content");
    expect(text).not.toContain("2: Line 2 content");
    expect(text).not.toContain("6: Line 6 content");
  });

  it("reads to end of file when end_line is omitted", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "multiline.md", start_line: 18 },
    });
    const text = getToolText(result);
    expect(text).toContain("Lines 18-20 of 20 total lines");
    expect(text).toContain("18: Line 18 content");
    expect(text).toContain("20: Line 20 content");
  });

  it("clamps end_line to total line count", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "multiline.md", start_line: 18, end_line: 100 },
    });
    const text = getToolText(result);
    expect(text).toContain("Lines 18-20 of 20 total lines");
    expect(text).toContain("18: Line 18 content");
    expect(text).toContain("20: Line 20 content");
  });

  it("reads last N lines with negative start_line", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "multiline.md", start_line: -3 },
    });
    const text = getToolText(result);
    expect(text).toContain("Lines 18-20 of 20 total lines");
    expect(text).toContain("18: Line 18 content");
    expect(text).toContain("19: Line 19 content");
    expect(text).toContain("20: Line 20 content");
    expect(text).not.toContain("17: Line 17 content");
  });

  it("clamps negative start_line to line 1 when it exceeds file length", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "multiline.md", start_line: -500 },
    });
    const text = getToolText(result);
    expect(text).toContain("Lines 1-20 of 20 total lines");
    expect(text).toContain("1: Line 1 content");
    expect(text).toContain("20: Line 20 content");
  });

  it("returns error when end_line is used with negative start_line", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "multiline.md", start_line: -5, end_line: 10 },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("end_line cannot be used with negative start_line");
  });

  it("returns error when start_line exceeds total lines", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "multiline.md", start_line: 100, end_line: 200 },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("beyond total line count");
  });

  it("returns error when end_line < start_line", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "multiline.md", start_line: 10, end_line: 5 },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("end_line must be >= start_line");
  });

  it("returns error when resolved line range exceeds maximum", async () => {
    // large.md has 600 lines; requesting all of them exceeds MAX_LINES_PER_PARTIAL_READ (500)
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "large.md", start_line: 1 },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("exceeds maximum");
  });

  it("blocks hidden directory access via read_file_lines", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: ".claude/skills/test-skill.md", start_line: 1, end_line: 10 },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("not allowed");
  });

  it("returns error for path traversal in read_file_lines", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "../../etc/passwd", start_line: 1, end_line: 10 },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("traversal");
  });

  it("rejects binary files in read_file_lines", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "binary.dat", start_line: 1, end_line: 5 },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("Binary file detected");
  });

  it("rejects binary files in read_file", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "binary.dat" },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("Binary file detected");
  });

  it("returns error for nonexistent file in read_file_lines", async () => {
    const result = await client.callTool({
      name: "read_file_lines",
      arguments: { path: "does-not-exist.md", start_line: -5 },
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
    const text = getToolText(result);
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
    const text = getToolText(result);
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
    const text = getToolText(result);
    expect(text).toContain("File edited: edit-partial.md");
    expect(text).toContain("ERROR:");
  });

  // --- is_directory tests ---

  it("is_directory returns true for existing directory", async () => {
    const result = await client.callTool({
      name: "is_directory",
      arguments: { path: "subfolder" },
    });
    const text = getToolText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Directory exists: subfolder");
  });

  it("is_directory returns false for nonexistent path", async () => {
    const result = await client.callTool({
      name: "is_directory",
      arguments: { path: "nonexistent-folder" },
    });
    const text = getToolText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Directory does not exist: nonexistent-folder");
  });

  it("is_directory reports file is not a directory", async () => {
    const result = await client.callTool({
      name: "is_directory",
      arguments: { path: "hello.md" },
    });
    const text = getToolText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Path exists but is not a directory: hello.md");
  });

  it("is_directory blocks path traversal", async () => {
    const result = await client.callTool({
      name: "is_directory",
      arguments: { path: "../../etc" },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("traversal");
  });

  it("is_directory blocks hidden directory access", async () => {
    const result = await client.callTool({
      name: "is_directory",
      arguments: { path: ".git" },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("not allowed");
  });

  // --- move_file tests ---

  it("move_file moves a file using git mv", async () => {
    // Create a file and commit it so git tracks it
    await client.callTool({
      name: "write_file",
      arguments: { path: "move-source.md", content: "File to move" },
    });
    // Wait for debounced sync to commit the file
    const { flushDebouncedSync } = await import("../src/git/debouncedSync.js");
    await flushDebouncedSync();

    // Create target directory
    await client.callTool({
      name: "create_directory",
      arguments: { path: "move-target-dir" },
    });

    const result = await client.callTool({
      name: "move_file",
      arguments: { old_path: "move-source.md", new_path: "move-target-dir/move-source.md" },
    });
    const text = getToolText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("File moved: move-source.md -> move-target-dir/move-source.md");

    // Verify file exists at new location
    const readResult = await client.callTool({
      name: "read_file",
      arguments: { path: "move-target-dir/move-source.md" },
    });
    expect(getToolText(readResult)).toBe("File to move");

    // Verify file no longer exists at old location
    const oldResult = await client.callTool({
      name: "read_file",
      arguments: { path: "move-source.md" },
    });
    expect(oldResult.isError).toBe(true);
  });

  it("move_file fails when target directory does not exist", async () => {
    await client.callTool({
      name: "write_file",
      arguments: { path: "move-nodir.md", content: "Content" },
    });
    const { flushDebouncedSync } = await import("../src/git/debouncedSync.js");
    await flushDebouncedSync();

    const result = await client.callTool({
      name: "move_file",
      arguments: { old_path: "move-nodir.md", new_path: "nonexistent-dir/move-nodir.md" },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("Target directory does not exist");
  });

  it("move_file fails when source is a directory", async () => {
    const result = await client.callTool({
      name: "move_file",
      arguments: { old_path: "subfolder", new_path: "subfolder-moved" },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("not a file");
  });

  it("move_file blocks path traversal", async () => {
    const result = await client.callTool({
      name: "move_file",
      arguments: { old_path: "../../etc/passwd", new_path: "stolen.txt" },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("traversal");
  });

  // --- move_directory tests ---

  it("move_directory moves a directory using git mv", async () => {
    // Create a directory with files and commit them
    await client.callTool({
      name: "create_directory",
      arguments: { path: "dir-to-move" },
    });
    await client.callTool({
      name: "write_file",
      arguments: { path: "dir-to-move/file1.md", content: "File 1" },
    });
    await client.callTool({
      name: "write_file",
      arguments: { path: "dir-to-move/file2.md", content: "File 2" },
    });
    const { flushDebouncedSync } = await import("../src/git/debouncedSync.js");
    await flushDebouncedSync();

    const result = await client.callTool({
      name: "move_directory",
      arguments: { old_path: "dir-to-move", new_path: "dir-moved" },
    });
    const text = getToolText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Directory moved: dir-to-move -> dir-moved");

    // Verify files exist at new location
    const read1 = await client.callTool({
      name: "read_file",
      arguments: { path: "dir-moved/file1.md" },
    });
    expect(getToolText(read1)).toBe("File 1");

    const read2 = await client.callTool({
      name: "read_file",
      arguments: { path: "dir-moved/file2.md" },
    });
    expect(getToolText(read2)).toBe("File 2");

    // Verify old directory no longer exists
    const dirCheck = await client.callTool({
      name: "is_directory",
      arguments: { path: "dir-to-move" },
    });
    expect(getToolText(dirCheck)).toContain("does not exist");
  });

  it("move_directory fails when target parent directory does not exist", async () => {
    await client.callTool({
      name: "create_directory",
      arguments: { path: "dir-noparent" },
    });
    await client.callTool({
      name: "write_file",
      arguments: { path: "dir-noparent/file.md", content: "Content" },
    });
    const { flushDebouncedSync } = await import("../src/git/debouncedSync.js");
    await flushDebouncedSync();

    const result = await client.callTool({
      name: "move_directory",
      arguments: { old_path: "dir-noparent", new_path: "nonexistent-parent/dir-noparent" },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("Target parent directory does not exist");
  });

  it("move_directory fails when source is a file", async () => {
    const result = await client.callTool({
      name: "move_directory",
      arguments: { old_path: "hello.md", new_path: "hello-moved" },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("not a directory");
  });

  it("move_directory blocks path traversal", async () => {
    const result = await client.callTool({
      name: "move_directory",
      arguments: { old_path: "../../etc", new_path: "stolen" },
    });
    expect(result.isError).toBe(true);
    const text = getToolText(result);
    expect(text).toContain("traversal");
  });
});
