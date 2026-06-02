import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CONTENT_FILE_BYTES,
  resolveVaultFileBody,
} from "./index";

describe("resolveVaultFileBody", () => {
  let dir: string;
  let filePath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vault-body-"));
    filePath = join(dir, "note.md");
    await writeFile(filePath, "from file", "utf-8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns inline content", async () => {
    expect(await resolveVaultFileBody({ content: "hello" })).toBe("hello");
  });

  test("returns empty string content (valid empty file)", async () => {
    expect(await resolveVaultFileBody({ content: "" })).toBe("");
  });

  test("reads file content from absolute contentPath", async () => {
    expect(await resolveVaultFileBody({ contentPath: filePath })).toBe(
      "from file",
    );
  });

  test("rejects when both content and contentPath are given", async () => {
    await expect(
      resolveVaultFileBody({ content: "a", contentPath: filePath }),
    ).rejects.toBeInstanceOf(McpError);
  });

  test("rejects when neither is given", async () => {
    await expect(resolveVaultFileBody({})).rejects.toBeInstanceOf(McpError);
  });

  test("rejects a relative contentPath", async () => {
    await expect(
      resolveVaultFileBody({ contentPath: "relative/note.md" }),
    ).rejects.toBeInstanceOf(McpError);
  });

  test("rejects a non-existent contentPath", async () => {
    await expect(
      resolveVaultFileBody({ contentPath: join(dir, "missing.md") }),
    ).rejects.toBeDefined();
  });

  test("rejects a file exceeding the size limit", async () => {
    const bigPath = join(dir, "big.md");
    await writeFile(bigPath, "x".repeat(MAX_CONTENT_FILE_BYTES + 1), "utf-8");
    await expect(
      resolveVaultFileBody({ contentPath: bigPath }),
    ).rejects.toBeInstanceOf(McpError);
  });
});
