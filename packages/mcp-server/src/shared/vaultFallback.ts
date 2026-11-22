/**
 * Direct-filesystem fallback for when Obsidian (and so the Local REST API) is not running.
 *
 * The MCP server is spawned by the client, not by Obsidian, so it stays up when the app is
 * closed — but every tool used to fail with "Unable to connect". The vault tools are plain file
 * operations, so when the REST call cannot connect they are served from disk instead, with the
 * same argument shapes and (as far as the REST API defines them) the same result shapes.
 *
 * The fallback is used only on a connection failure. While Obsidian runs, every call still goes
 * through the REST API, so the app stays the single writer and nothing races it.
 *
 * Configuration (both optional):
 * - OBSIDIAN_VAULT_FS_PATH: absolute vault path. Default: derived from the server binary's own
 *   location when it lives at `<vault>/.obsidian/plugins/<id>/bin/`.
 * - SMART_SEARCH_FALLBACK_CMD: a command that answers a semantic search without Obsidian. It is
 *   run as `<cmd...> search '<request json>'` and must print the `/search/smart` response JSON.
 *   Without it, `search_vault_smart` keeps failing while Obsidian is down.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { logger } from "./logger";

export const OFFLINE_NOTE =
  "(Obsidian is not running: handled by direct file access to the vault.)";

export function vaultFsPath(): string | undefined {
  const fromEnv = process.env.OBSIDIAN_VAULT_FS_PATH;
  if (fromEnv) return fromEnv;
  const marker = `${sep}.obsidian${sep}plugins${sep}`;
  const i = process.execPath.indexOf(marker);
  return i > 0 ? process.execPath.slice(0, i) : undefined;
}

/** True when the error means the REST API could not be reached at all. */
export function isConnectionError(err: unknown): boolean {
  if (err instanceof McpError) return false; // the API answered (4xx/5xx)
  const e = err as { code?: string; message?: string } | undefined;
  if (!e) return false;
  if (["ECONNREFUSED", "ConnectionRefused", "ECONNRESET", "FailedToOpenSocket"].includes(e.code ?? "")) {
    return true;
  }
  return /Unable to connect|ECONNREFUSED|fetch failed|socket/i.test(e.message ?? "");
}

/**
 * Runs the REST call; on a connection failure runs the fallback instead (if a vault path is
 * known). Any other error — including an HTTP error from a running Obsidian — propagates.
 */
export async function withFallback<T>(
  tool: string,
  rest: () => Promise<T>,
  fallback: (vault: string) => Promise<T>,
): Promise<T> {
  try {
    return await rest();
  } catch (err) {
    const vault = vaultFsPath();
    if (!isConnectionError(err) || !vault) throw err;
    logger.info("REST unreachable; using filesystem fallback", { tool });
    return fallback(vault);
  }
}

export function offlineOnly(tool: string): McpError {
  return new McpError(
    ErrorCode.InternalError,
    `${tool} needs the Obsidian app, which is not running (vault file tools still work).`,
  );
}

// ---------- paths ----------
function resolveInVault(vault: string, vaultPath: string): string {
  const abs = resolve(vault, vaultPath.replace(/^\/+/, ""));
  const rel = relative(vault, abs);
  if (rel.startsWith("..") || resolve(vault, rel) !== abs) {
    throw new McpError(ErrorCode.InvalidParams, `Path escapes the vault: ${vaultPath}`);
  }
  return abs;
}

function notFound(method: string, vaultPath: string): McpError {
  return new McpError(
    ErrorCode.InternalError,
    `${method} /vault/${vaultPath} 404: ${JSON.stringify({ message: "Not Found", errorCode: 40400 })}`,
  );
}

const isHidden = (p: string) => p.split("/").some((s) => s.startsWith("."));

async function walkFiles(vault: string, dir = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(vault, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(vault, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Write via a hidden temp file + rename, so a reader never sees a half-written note. */
async function writeAtomic(abs: string, body: string) {
  await mkdir(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.mcp-fallback.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, body, "utf-8");
  await rename(tmp, abs);
}

// ---------- frontmatter (minimal YAML: scalars, flow lists, block lists) ----------
function splitFrontmatter(content: string): { fm: string | null; start: number; end: number } {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return { fm: null, start: -1, end: -1 };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return { fm: lines.slice(1, i).join("\n"), start: 0, end: i };
  }
  return { fm: null, start: -1, end: -1 };
}

function parseScalar(v: string): unknown {
  const t = v.trim();
  if (t === "") return null;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    if (t.startsWith('"')) {
      try {
        return JSON.parse(t);
      } catch {}
    }
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    return inner ? inner.split(",").map((x) => parseScalar(x)) : [];
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return t;
}

export function parseFrontmatter(content: string): Record<string, unknown> {
  const { fm } = splitFrontmatter(content);
  if (fm === null) return {};
  const out: Record<string, unknown> = {};
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([^\s:#][^:]*):(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const rest = m[2];
    if (rest.trim() === "" && lines[i + 1]?.trim().startsWith("- ")) {
      const arr: unknown[] = [];
      while (lines[i + 1]?.trim().startsWith("- ")) arr.push(parseScalar(lines[++i].trim().slice(2)));
      out[key] = arr;
    } else if (rest.trim() === "|" || rest.trim() === ">") {
      const buf: string[] = [];
      while (lines[i + 1] !== undefined && /^\s+/.test(lines[i + 1])) buf.push(lines[++i].trim());
      out[key] = buf.join(rest.trim() === "|" ? "\n" : " ");
    } else {
      out[key] = parseScalar(rest);
    }
  }
  return out;
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s === "" || /[:#\[\]{},&*!|>'"%@`]|^\s|\s$|^[-?]/.test(s)) return JSON.stringify(s);
  return s;
}
const yamlValue = (v: unknown) =>
  Array.isArray(v) ? `[${v.map(yamlScalar).join(", ")}]` : yamlScalar(v);

function noteTags(content: string, fm: Record<string, unknown>): string[] {
  const tags = new Set<string>();
  const raw = fm.tags;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
  for (const t of list) if (t) tags.add(String(t).replace(/^#/, ""));
  const { end } = splitFrontmatter(content);
  const body = end >= 0 ? content.split("\n").slice(end + 1).join("\n") : content;
  for (const m of body.matchAll(/(?<![\w#])#([\p{L}\p{N}_/-]+)/gu)) {
    if (!/^\d+$/.test(m[1])) tags.add(m[1]);
  }
  return [...tags];
}

// ---------- operations ----------
export async function fsGetFile(vault: string, filename: string, json: boolean) {
  const abs = resolveInVault(vault, filename);
  let content: string;
  try {
    content = await readFile(abs, "utf-8");
  } catch {
    throw notFound("GET", filename);
  }
  if (!json) return content;
  const st = await stat(abs);
  const frontmatter = parseFrontmatter(content);
  return {
    content,
    frontmatter,
    path: filename,
    stat: { ctime: st.birthtimeMs || st.ctimeMs, mtime: st.mtimeMs, size: st.size },
    tags: noteTags(content, frontmatter),
  };
}

export async function fsListDirectory(vault: string, directory: string | undefined) {
  const prefix = directory ? `${directory.replace(/\/+$/, "")}/` : "";
  if (prefix && isHidden(prefix)) throw notFound("GET", prefix);
  const all = await walkFiles(vault, prefix.replace(/\/$/, ""));
  const files = [
    ...new Set(
      all.map((p) => {
        const sub = p.slice(prefix.length);
        const i = sub.indexOf("/");
        return i > -1 ? sub.slice(0, i + 1) : sub;
      }),
    ),
  ].sort();
  if (!files.length) throw notFound("GET", prefix);
  return { files };
}

export async function fsWriteFile(vault: string, filename: string, body: string) {
  await writeAtomic(resolveInVault(vault, filename), body);
}

export async function fsAppendFile(vault: string, filename: string, content: string) {
  const abs = resolveInVault(vault, filename);
  if (!existsSync(abs)) return writeAtomic(abs, content);
  const cur = await readFile(abs, "utf-8");
  await appendFile(abs, (cur.endsWith("\n") || cur === "" ? "" : "\n") + content, "utf-8");
}

/** Same default as the REST API (not `permanent`): move to the vault's `.trash/`, never unlink. */
export async function fsDeleteFile(vault: string, filename: string) {
  const abs = resolveInVault(vault, filename);
  if (!existsSync(abs)) throw notFound("DELETE", filename);
  let dest = join(vault, ".trash", filename);
  if (existsSync(dest)) dest = dest.replace(/(\.[^./]+)?$/, ` ${Date.now()}$1`);
  await mkdir(dirname(dest), { recursive: true });
  await rename(abs, dest);
}

export async function fsSimpleSearch(vault: string, query: string, contextLength = 100) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out: { filename: string; score: number; matches: { match: { start: number; end: number }; context: string }[] }[] = [];
  for (const rel of await walkFiles(vault)) {
    if (!rel.endsWith(".md")) continue;
    const content = await readFile(join(vault, rel), "utf-8").catch(() => "");
    const lower = content.toLowerCase();
    if (!terms.every((t) => lower.includes(t))) continue;
    const matches = [];
    for (const t of terms) {
      let from = 0;
      for (let n = 0; n < 20; n++) {
        const i = lower.indexOf(t, from);
        if (i < 0) break;
        matches.push({
          match: { start: i, end: i + t.length },
          context: content.slice(Math.max(0, i - contextLength), i + t.length + contextLength),
        });
        from = i + t.length;
      }
    }
    out.push({ filename: rel, score: -matches.length, matches });
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 200);
}

// ---------- patch (heading / block / frontmatter), after the REST API's semantics ----------
export type PatchArgs = {
  operation: "append" | "prepend" | "replace";
  targetType: "heading" | "block" | "frontmatter";
  target: string;
  targetDelimiter?: string;
  trimTargetWhitespace?: boolean;
  content: string;
  contentType?: "text/markdown" | "application/json";
};

function patchHeading(lines: string[], args: PatchArgs): string[] {
  const delim = args.targetDelimiter || "::";
  const want = args.target.split(delim).map((s) => (args.trimTargetWhitespace ? s.trim() : s));
  const stack: { level: number; text: string }[] = [];
  let found = -1;
  let level = 0;
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("```")) inCode = !inCode;
    const m = !inCode && lines[i].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const lv = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= lv) stack.pop();
    stack.push({ level: lv, text: m[2] });
    const path = stack.map((s) => s.text);
    if (path.length === want.length && path.every((t, j) => t === want[j])) {
      found = i;
      level = lv;
      break;
    }
  }
  const content = args.content.replace(/\n+$/, "");
  if (found < 0) {
    // Create-Target-If-Missing: add the heading path at the end
    const add = want.map((t, j) => `${"#".repeat(j + 1)} ${t}`);
    const base = lines.join("\n").replace(/\n+$/, "");
    return `${base}\n\n${add.join("\n")}\n${content}\n`.split("\n");
  }
  let end = lines.length;
  inCode = false;
  for (let i = found + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("```")) inCode = !inCode;
    const m = !inCode && lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  let bodyEnd = end; // keep trailing blank lines between sections
  while (bodyEnd > found + 1 && lines[bodyEnd - 1].trim() === "") bodyEnd--;
  const ins = content.split("\n");
  if (args.operation === "prepend") return [...lines.slice(0, found + 1), ...ins, ...lines.slice(found + 1)];
  if (args.operation === "append") return [...lines.slice(0, bodyEnd), ...ins, ...lines.slice(bodyEnd)];
  return [...lines.slice(0, found + 1), ...ins, ...lines.slice(bodyEnd)];
}

function patchBlock(lines: string[], args: PatchArgs): string[] {
  const id = args.target.replace(/^\^/, "");
  const i = lines.findIndex((l) => new RegExp(`\\s\\^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).test(l));
  if (i < 0) throw new McpError(ErrorCode.InternalError, `PATCH block ^${id} 400: block not found`);
  const ins = args.content.replace(/\n+$/, "").split("\n");
  if (args.operation === "prepend") return [...lines.slice(0, i), ...ins, ...lines.slice(i)];
  if (args.operation === "append") return [...lines.slice(0, i + 1), ...ins, ...lines.slice(i + 1)];
  return [...lines.slice(0, i), `${ins.join("\n")} ^${id}`, ...lines.slice(i + 1)];
}

function patchFrontmatter(content: string, args: PatchArgs): string {
  const key = args.trimTargetWhitespace ? args.target.trim() : args.target;
  let value: unknown = args.content;
  if (args.contentType === "application/json") value = JSON.parse(args.content);
  const fm = parseFrontmatter(content);
  const cur = fm[key];
  let next: unknown = value;
  if (args.operation !== "replace" && cur !== undefined && cur !== null) {
    const add = Array.isArray(value) ? value : [value];
    if (Array.isArray(cur)) next = args.operation === "append" ? [...cur, ...add] : [...add, ...cur];
    else next = args.operation === "append" ? `${cur}${value}` : `${value}${cur}`;
  }
  const line = `${key}: ${yamlValue(next)}`;
  const { fm: raw, end } = splitFrontmatter(content);
  const lines = content.split("\n");
  if (raw === null) return `---\n${line}\n---\n${content}`;
  // replace the key's own line plus any continuation lines (block list / multi-line scalar)
  for (let i = 1; i < end; i++) {
    if (lines[i].match(/^([^\s:#][^:]*):/)?.[1].trim() !== key) continue;
    let j = i + 1;
    while (j < end && (/^\s+/.test(lines[j]) || lines[j].trim().startsWith("- "))) j++;
    return [...lines.slice(0, i), line, ...lines.slice(j)].join("\n");
  }
  return [...lines.slice(0, end), line, ...lines.slice(end)].join("\n");
}

export async function fsPatchFile(vault: string, filename: string, args: PatchArgs) {
  const abs = resolveInVault(vault, filename);
  let content: string;
  try {
    content = await readFile(abs, "utf-8");
  } catch {
    throw notFound("PATCH", filename);
  }
  let next: string;
  if (args.targetType === "frontmatter") next = patchFrontmatter(content, args);
  else if (args.targetType === "block") next = patchBlock(content.split("\n"), args).join("\n");
  else next = patchHeading(content.split("\n"), args).join("\n");
  await writeAtomic(abs, next);
  return next;
}

// ---------- semantic search ----------
export async function fallbackSmartSearch(args: unknown): Promise<unknown> {
  const cmd = process.env.SMART_SEARCH_FALLBACK_CMD;
  if (!cmd) throw offlineOnly("search_vault_smart");
  const [bin, ...pre] = cmd.split(" ").filter(Boolean);
  return new Promise((ok, ng) => {
    const p = spawn(bin, [...pre, "search", JSON.stringify(args)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", ng);
    p.on("close", (code) => {
      if (code !== 0) return ng(new McpError(ErrorCode.InternalError, `smart search fallback failed (${code}): ${err.slice(0, 500)}`));
      try {
        ok(JSON.parse(out));
      } catch (e) {
        ng(new McpError(ErrorCode.InternalError, `smart search fallback returned invalid JSON: ${String(e)}`));
      }
    });
  });
}
