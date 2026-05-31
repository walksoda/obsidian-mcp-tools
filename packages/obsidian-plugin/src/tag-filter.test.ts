import { describe, expect, test } from "bun:test";
import { jsonSearchRequest, searchParametersWithFreshness } from "shared";
import { type } from "arktype";
import { shake } from "radash";

/**
 * Standalone replica of McpToolsPlugin.tagsMatch in main.ts:
 * OR match with hierarchical prefix, leading # ignored on both sides.
 */
function tagsMatch(noteTags: string[], query: string[]): boolean {
  return query.some((q) => {
    const nq = q.replace(/^#/, "");
    return noteTags.some((t) => t === nq || t.startsWith(`${nq}/`));
  });
}

/**
 * Replica of the include/exclude filtering step in handleSearchRequest.
 */
function filterByTags<T extends { tags: string[] }>(
  results: T[],
  includeTags: string[],
  excludeTags: string[],
): T[] {
  return results.filter((r) => {
    if (includeTags.length > 0 && !tagsMatch(r.tags, includeTags)) return false;
    if (excludeTags.length > 0 && tagsMatch(r.tags, excludeTags)) return false;
    return true;
  });
}

/**
 * Replicate the pipe + validation chain from handleSearchRequest, including
 * the tags/excludeTags lift to the top level.
 */
function parseRequest(body: string) {
  return jsonSearchRequest
    .pipe(({ query, filter = {} }) =>
      shake({
        query,
        tags: filter.tags,
        excludeTags: filter.excludeTags,
        freshness: filter.freshness,
        freshnessHalfLife: filter.freshnessHalfLife,
        filter: shake({
          key_starts_with_any: filter.folders,
          exclude_key_starts_with_any: filter.excludeFolders,
          limit: filter.limit,
        }),
      }),
    )
    .to(searchParametersWithFreshness)(body);
}

describe("Tag Matching Semantics", () => {
  test("OR match: any of the query tags matches", () => {
    expect(tagsMatch(["work"], ["work", "draft"])).toBe(true);
    expect(tagsMatch(["draft"], ["work", "draft"])).toBe(true);
    expect(tagsMatch(["personal"], ["work", "draft"])).toBe(false);
  });

  test("exact single-tag match", () => {
    expect(tagsMatch(["project"], ["project"])).toBe(true);
    expect(tagsMatch(["projects"], ["project"])).toBe(false); // not a prefix segment
  });

  test("hierarchical prefix: parent query matches child note tag", () => {
    expect(tagsMatch(["project/active"], ["project"])).toBe(true);
    expect(tagsMatch(["project/done"], ["project"])).toBe(true);
    expect(tagsMatch(["project"], ["project"])).toBe(true);
  });

  test("hierarchical: child query does NOT match parent note tag", () => {
    expect(tagsMatch(["project"], ["project/active"])).toBe(false);
  });

  test("leading # in the query is normalized (note tags arrive pre-stripped)", () => {
    // getFileTags strips '#' from note tags, so only the query side may carry it.
    expect(tagsMatch(["work"], ["#work"])).toBe(true);
    expect(tagsMatch(["project/active"], ["#project"])).toBe(true);
  });

  test("empty note tags never match", () => {
    expect(tagsMatch([], ["work"])).toBe(false);
  });
});

describe("Include / Exclude Filtering", () => {
  const results = [
    { path: "a.md", tags: ["work", "draft"] },
    { path: "b.md", tags: ["personal"] },
    { path: "c.md", tags: ["project/active"] },
    { path: "d.md", tags: [] },
  ];

  test("include keeps only notes matching any include tag", () => {
    const out = filterByTags(results, ["work"], []);
    expect(out.map((r) => r.path)).toEqual(["a.md"]);
  });

  test("include with hierarchical prefix matches children", () => {
    const out = filterByTags(results, ["project"], []);
    expect(out.map((r) => r.path)).toEqual(["c.md"]);
  });

  test("exclude removes notes having any exclude tag", () => {
    const out = filterByTags(results, [], ["personal"]);
    expect(out.map((r) => r.path)).toEqual(["a.md", "c.md", "d.md"]);
  });

  test("include and exclude combine (include wins membership, exclude prunes)", () => {
    const out = filterByTags(results, ["work", "personal"], ["draft"]);
    // a.md matches include(work) but is pruned by exclude(draft); b.md kept
    expect(out.map((r) => r.path)).toEqual(["b.md"]);
  });

  test("no tag filters returns everything", () => {
    const out = filterByTags(results, [], []);
    expect(out).toHaveLength(4);
  });
});

describe("Tag Schema Validation (pipe lift)", () => {
  test("tags and excludeTags lift to top level", () => {
    const body = JSON.stringify({
      query: "test",
      filter: { tags: ["work"], excludeTags: ["archive"], limit: 5 },
    });
    const result = parseRequest(body);
    expect(result).not.toBeInstanceOf(type.errors);
    if (!(result instanceof type.errors)) {
      expect(result.tags).toEqual(["work"]);
      expect(result.excludeTags).toEqual(["archive"]);
      expect(result.filter.limit).toBe(5);
    }
  });

  test("request without tags stays backward compatible", () => {
    const body = JSON.stringify({ query: "test", filter: { limit: 10 } });
    const result = parseRequest(body);
    expect(result).not.toBeInstanceOf(type.errors);
    if (!(result instanceof type.errors)) {
      expect(result.tags).toBeUndefined();
      expect(result.excludeTags).toBeUndefined();
    }
  });

  test("tags combine with folders and freshness", () => {
    const body = JSON.stringify({
      query: "test",
      filter: {
        folders: ["Notes"],
        tags: ["work"],
        freshness: true,
        limit: 8,
      },
    });
    const result = parseRequest(body);
    expect(result).not.toBeInstanceOf(type.errors);
    if (!(result instanceof type.errors)) {
      expect(result.tags).toEqual(["work"]);
      expect(result.freshness).toBe(true);
      expect(result.filter.key_starts_with_any).toEqual(["Notes"]);
    }
  });
});

describe("Pool Expansion and Trim", () => {
  const hasTags = (inc: string[], exc: string[]) =>
    inc.length > 0 || exc.length > 0;

  test("tags-only query expands the candidate pool", () => {
    const freshness = false;
    const originalLimit = 20;
    const needsExpansion = freshness || hasTags(["work"], []);
    const searchLimit = needsExpansion
      ? Math.min(originalLimit * 3, 200)
      : originalLimit;
    expect(needsExpansion).toBe(true);
    expect(searchLimit).toBe(60);
  });

  test("plain query (no tags, no freshness) does not expand", () => {
    const needsExpansion = false || hasTags([], []);
    expect(needsExpansion).toBe(false);
  });

  test("tags-only result set is trimmed to originalLimit (no 200-result leak)", () => {
    const originalLimit = 20;
    // 60 candidates all carry the tag, so all pass the filter.
    const candidates = Array.from({ length: 60 }, (_, i) => ({
      path: `${i}.md`,
      tags: ["work"],
    }));
    const filtered = filterByTags(candidates, ["work"], []);
    expect(filtered).toHaveLength(60);
    // Non-freshness branch trims because the pool was expanded.
    const needsExpansion = true;
    const trimmed = needsExpansion
      ? filtered.slice(0, originalLimit)
      : filtered;
    expect(trimmed).toHaveLength(20);
  });

  test("tags + freshness: filter precedes decay/sort, then trim", () => {
    const originalLimit = 2;
    const halfLifeDays = 365;
    const daysAgo = (d: number) =>
      new Date(Date.now() - d * 86_400_000).toISOString();

    // Expanded candidate pool from search (limit*3).
    const candidates = [
      { path: "old-work.md", tags: ["work"], score: 0.95, dateStr: daysAgo(730) },
      { path: "new-work.md", tags: ["work"], score: 0.6, dateStr: daysAgo(7) },
      { path: "new-personal.md", tags: ["personal"], score: 0.99, dateStr: daysAgo(1) },
    ];

    // 1. tag filter (include work) drops the personal note even though it's
    //    newest and highest scored.
    const filtered = filterByTags(candidates, ["work"], []);
    expect(filtered.map((r) => r.path)).toEqual(["old-work.md", "new-work.md"]);

    // 2. decay + sort
    const scored = filtered.map((r) => {
      const date = new Date(r.dateStr);
      const ageDays = Math.max(0, (Date.now() - date.getTime()) / 86_400_000);
      return {
        path: r.path,
        decayedScore: r.score * Math.pow(0.5, ageDays / halfLifeDays),
        originalScore: r.score,
      };
    });
    scored.sort(
      (a, b) =>
        b.decayedScore - a.decayedScore ||
        b.originalScore - a.originalScore ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );

    // 3. trim
    const trimmed = scored.slice(0, originalLimit);
    // new-work decays little; old-work decays to ~0.24 → new-work ranks first.
    expect(trimmed[0].path).toBe("new-work.md");
    expect(trimmed).toHaveLength(2);
  });
});
