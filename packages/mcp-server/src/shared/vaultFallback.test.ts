import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fsAppendFile,
  fsDeleteFile,
  fsGetFile,
  fsListDirectory,
  fsPatchFile,
  fsSimpleSearch,
  fsWriteFile,
  isConnectionError,
  parseFrontmatter,
} from "./vaultFallback";

let vault: string;
const NOTE = "---\ntitle: \"t\"\ntags: [a, b]\n---\n\n# Top\n\nintro\n\n## Sub\n\nbody line\n\n## Other\n\nx #inline\n";

beforeAll(() => {
  vault = mkdtempSync(join(process.env.FALLBACK_TEST_TMP ?? tmpdir(), "vault-"));
  mkdirSync(join(vault, "20_notes/d"), { recursive: true });
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  writeFileSync(join(vault, "20_notes/d/n.md"), NOTE);
  writeFileSync(join(vault, "20_notes/top.md"), "hello world\n");
  writeFileSync(join(vault, ".obsidian/app.json"), "{}");
});
afterAll(() => rmSync(vault, { recursive: true, force: true }));

describe("vault fallback", () => {
  test("connection errors are recognised, HTTP errors are not", () => {
    const e = Object.assign(new TypeError("ECONNREFUSED: Unable to connect. Is the computer able to access the url?"), { code: "ECONNREFUSED" });
    expect(isConnectionError(e)).toBe(true);
    expect(isConnectionError(new Error("GET /vault/x 404: Not Found"))).toBe(false);
  });

  test("list mirrors the REST shape (dirs end with /, hidden excluded, sorted)", async () => {
    expect(await fsListDirectory(vault, undefined)).toEqual({ files: ["20_notes/"] });
    expect(await fsListDirectory(vault, "20_notes")).toEqual({ files: ["d/", "top.md"] });
    await expect(fsListDirectory(vault, "nope")).rejects.toThrow(/404/);
  });

  test("get markdown and json", async () => {
    expect(await fsGetFile(vault, "20_notes/d/n.md", false)).toBe(NOTE);
    const j = (await fsGetFile(vault, "20_notes/d/n.md", true)) as { frontmatter: Record<string, unknown>; tags: string[] };
    expect(j.frontmatter.tags).toEqual(["a", "b"]);
    expect(j.tags).toEqual(["a", "b", "inline"]);
    await expect(fsGetFile(vault, "20_notes/missing.md", false)).rejects.toThrow(/404/);
  });

  test("path escape is refused", async () => {
    await expect(fsWriteFile(vault, "../evil.md", "x")).rejects.toThrow(/escapes/);
  });

  test("create (with new dirs) and append adds a newline only when needed", async () => {
    await fsWriteFile(vault, "20_notes/new/a.md", "line1");
    await fsAppendFile(vault, "20_notes/new/a.md", "line2");
    expect(readFileSync(join(vault, "20_notes/new/a.md"), "utf-8")).toBe("line1\nline2");
    await fsAppendFile(vault, "20_notes/new/b.md", "fresh");
    expect(readFileSync(join(vault, "20_notes/new/b.md"), "utf-8")).toBe("fresh");
  });

  test("patch heading append / prepend / replace", async () => {
    const f = "20_notes/d/p.md";
    await fsWriteFile(vault, f, NOTE);
    await fsPatchFile(vault, f, { operation: "append", targetType: "heading", target: "Top::Sub", content: "added" });
    expect(readFileSync(join(vault, f), "utf-8")).toContain("body line\nadded\n\n## Other");
    await fsPatchFile(vault, f, { operation: "prepend", targetType: "heading", target: "Top::Other", content: "first" });
    expect(readFileSync(join(vault, f), "utf-8")).toContain("## Other\nfirst\n");
    await fsPatchFile(vault, f, { operation: "replace", targetType: "heading", target: "Top::Sub", content: "only" });
    expect(readFileSync(join(vault, f), "utf-8")).toContain("## Sub\nonly\n\n## Other");
  });

  test("patch frontmatter keeps the flow-list style", async () => {
    const f = "20_notes/d/fm.md";
    await fsWriteFile(vault, f, NOTE);
    await fsPatchFile(vault, f, { operation: "replace", targetType: "frontmatter", target: "tags", content: '["x","y-z"]', contentType: "application/json" });
    expect(readFileSync(join(vault, f), "utf-8")).toContain("tags: [x, y-z]\n");
    await fsPatchFile(vault, f, { operation: "append", targetType: "frontmatter", target: "tags", content: '"w"', contentType: "application/json" });
    expect(parseFrontmatter(readFileSync(join(vault, f), "utf-8")).tags).toEqual(["x", "y-z", "w"]);
    await fsPatchFile(vault, f, { operation: "replace", targetType: "frontmatter", target: "status", content: "done" });
    expect(parseFrontmatter(readFileSync(join(vault, f), "utf-8")).status).toBe("done");
  });

  test("delete moves to .trash instead of unlinking", async () => {
    await fsWriteFile(vault, "20_notes/del.md", "bye");
    await fsDeleteFile(vault, "20_notes/del.md");
    expect(existsSync(join(vault, "20_notes/del.md"))).toBe(false);
    expect(readFileSync(join(vault, ".trash/20_notes/del.md"), "utf-8")).toBe("bye");
  });

  test("simple search requires all terms and skips hidden folders", async () => {
    const r = await fsSimpleSearch(vault, "hello WORLD", 5);
    expect(r.map((x) => x.filename)).toEqual(["20_notes/top.md"]);
    expect(r[0].matches[0].context).toContain("hello");
  });
});
