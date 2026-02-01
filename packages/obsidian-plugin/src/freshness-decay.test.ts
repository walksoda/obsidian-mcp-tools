import { describe, expect, test } from "bun:test";
import { jsonSearchRequest, searchParametersWithFreshness } from "shared";
import { type } from "arktype";
import { shake } from "radash";

/**
 * Standalone decay function matching the implementation in main.ts
 */
function applyFreshnessDecay(
  score: number,
  date: Date | null,
  halfLifeDays: number,
): number {
  if (!date) return score;
  const ageDays = Math.max(0, (Date.now() - date.getTime()) / 86_400_000);
  return score * Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Replicate the pipe + validation chain from handleSearchRequest
 */
function parseRequest(body: string) {
  return jsonSearchRequest
    .pipe(({ query, filter = {} }) =>
      shake({
        query,
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

describe("Freshness Decay Formula", () => {
  test("brand new article (0 days) has no decay", () => {
    const now = new Date();
    const result = applyFreshnessDecay(1.0, now, 365);
    expect(result).toBeCloseTo(1.0, 2);
  });

  test("article at half-life age has 50% score", () => {
    const halfLifeDays = 365;
    const date = new Date(Date.now() - halfLifeDays * 86_400_000);
    const result = applyFreshnessDecay(1.0, date, halfLifeDays);
    expect(result).toBeCloseTo(0.5, 2);
  });

  test("article at 2x half-life has 25% score", () => {
    const halfLifeDays = 365;
    const date = new Date(Date.now() - 2 * halfLifeDays * 86_400_000);
    const result = applyFreshnessDecay(1.0, date, halfLifeDays);
    expect(result).toBeCloseTo(0.25, 2);
  });

  test("6-month article with 365-day half-life has ~71% score", () => {
    const halfLifeDays = 365;
    const date = new Date(Date.now() - 182.5 * 86_400_000);
    const result = applyFreshnessDecay(1.0, date, halfLifeDays);
    expect(result).toBeCloseTo(0.707, 2);
  });

  test("null date returns original score (no decay)", () => {
    const result = applyFreshnessDecay(0.85, null, 365);
    expect(result).toBe(0.85);
  });

  test("future date clamps to 0 age (no decay)", () => {
    const futureDate = new Date(Date.now() + 30 * 86_400_000);
    const result = applyFreshnessDecay(0.9, futureDate, 365);
    expect(result).toBeCloseTo(0.9, 2);
  });

  test("shorter half-life decays faster", () => {
    const date = new Date(Date.now() - 180 * 86_400_000); // 180 days ago
    const longHL = applyFreshnessDecay(1.0, date, 365);
    const shortHL = applyFreshnessDecay(1.0, date, 180);
    expect(shortHL).toBeLessThan(longHL);
    expect(shortHL).toBeCloseTo(0.5, 2); // 180 days with 180-day half-life = 0.5
  });

  test("preserves relative score differences", () => {
    const date = new Date(Date.now() - 365 * 86_400_000);
    const highScore = applyFreshnessDecay(0.9, date, 365);
    const lowScore = applyFreshnessDecay(0.3, date, 365);
    expect(highScore).toBeCloseTo(0.45, 2);
    expect(lowScore).toBeCloseTo(0.15, 2);
    expect(highScore / lowScore).toBeCloseTo(3.0, 1);
  });
});

describe("Sorting with Freshness", () => {
  test("newer article with lower original score can outrank older one", () => {
    const halfLifeDays = 365;
    // Old article: high relevance but 2 years old
    const oldDate = new Date(Date.now() - 730 * 86_400_000);
    const oldDecayed = applyFreshnessDecay(0.95, oldDate, halfLifeDays);

    // New article: moderate relevance but only 1 month old
    const newDate = new Date(Date.now() - 30 * 86_400_000);
    const newDecayed = applyFreshnessDecay(0.6, newDate, halfLifeDays);

    // New article should rank higher after decay
    expect(newDecayed).toBeGreaterThan(oldDecayed);
  });

  test("sort order: decayedScore desc, originalScore desc, path asc", () => {
    type ScoredResult = {
      path: string;
      decayedScore: number;
      originalScore: number;
    };

    const items: ScoredResult[] = [
      { path: "b.md", decayedScore: 0.5, originalScore: 0.8 },
      { path: "a.md", decayedScore: 0.5, originalScore: 0.8 },
      { path: "c.md", decayedScore: 0.9, originalScore: 0.9 },
      { path: "d.md", decayedScore: 0.5, originalScore: 0.9 },
    ];

    items.sort(
      (a, b) =>
        b.decayedScore - a.decayedScore ||
        b.originalScore - a.originalScore ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );

    expect(items.map((i) => i.path)).toEqual([
      "c.md", // highest decayedScore
      "d.md", // tied decayed=0.5, higher original=0.9
      "a.md", // tied decayed=0.5, tied original=0.8, path "a" < "b"
      "b.md", // tied decayed=0.5, tied original=0.8, path "b"
    ]);
  });
});

describe("Schema Validation", () => {
  test("parses request without freshness (backward compatible)", () => {
    const body = JSON.stringify({
      query: "test search",
      filter: { limit: 10 },
    });
    const result = parseRequest(body);
    expect(result).not.toBeInstanceOf(type.errors);
    if (!(result instanceof type.errors)) {
      expect(result.query).toBe("test search");
      expect(result.freshness).toBeUndefined();
      expect(result.freshnessHalfLife).toBeUndefined();
    }
  });

  test("parses request with freshness enabled", () => {
    const body = JSON.stringify({
      query: "test search",
      filter: { freshness: true, freshnessHalfLife: 180, limit: 5 },
    });
    const result = parseRequest(body);
    expect(result).not.toBeInstanceOf(type.errors);
    if (!(result instanceof type.errors)) {
      expect(result.query).toBe("test search");
      expect(result.freshness).toBe(true);
      expect(result.freshnessHalfLife).toBe(180);
      expect(result.filter.limit).toBe(5);
    }
  });

  test("parses request with freshness disabled explicitly", () => {
    const body = JSON.stringify({
      query: "test search",
      filter: { freshness: false },
    });
    const result = parseRequest(body);
    expect(result).not.toBeInstanceOf(type.errors);
    if (!(result instanceof type.errors)) {
      expect(result.freshness).toBe(false);
    }
  });

  test("rejects invalid freshnessHalfLife (0)", () => {
    const body = JSON.stringify({
      query: "test search",
      filter: { freshness: true, freshnessHalfLife: 0 },
    });
    const result = parseRequest(body);
    expect(result).toBeInstanceOf(type.errors);
  });

  test("rejects negative freshnessHalfLife", () => {
    const body = JSON.stringify({
      query: "test search",
      filter: { freshness: true, freshnessHalfLife: -10 },
    });
    const result = parseRequest(body);
    expect(result).toBeInstanceOf(type.errors);
  });

  test("parses request with folders and freshness", () => {
    const body = JSON.stringify({
      query: "test",
      filter: {
        folders: ["Notes", "Blog"],
        excludeFolders: ["Archive"],
        freshness: true,
        limit: 15,
      },
    });
    const result = parseRequest(body);
    expect(result).not.toBeInstanceOf(type.errors);
    if (!(result instanceof type.errors)) {
      expect(result.freshness).toBe(true);
      expect(result.filter.key_starts_with_any).toEqual(["Notes", "Blog"]);
      expect(result.filter.exclude_key_starts_with_any).toEqual(["Archive"]);
      expect(result.filter.limit).toBe(15);
    }
  });

  test("parses request with no filter at all", () => {
    const body = JSON.stringify({ query: "hello world" });
    const result = parseRequest(body);
    expect(result).not.toBeInstanceOf(type.errors);
    if (!(result instanceof type.errors)) {
      expect(result.query).toBe("hello world");
      expect(result.freshness).toBeUndefined();
    }
  });
});

describe("End-to-End Freshness Pipeline", () => {
  /**
   * Simulate the full pipeline from handleSearchRequest:
   *   1. Start with raw search results (score + file_path + date)
   *   2. Apply decay to each result
   *   3. Re-sort by decayedScore desc → originalScore desc → path asc
   *   4. Trim to limit
   *   5. Return results with both score (decayed) and originalScore
   */
  function simulateFreshnessPipeline(
    rawResults: { path: string; file_path: string; score: number; dateStr: string | null }[],
    halfLifeDays: number,
    limit: number,
  ) {
    const scored = rawResults.map((r) => {
      const date = r.dateStr ? new Date(r.dateStr) : null;
      const ageDays = date
        ? Math.max(0, (Date.now() - date.getTime()) / 86_400_000)
        : 0;
      const decayedScore = date
        ? r.score * Math.pow(0.5, ageDays / halfLifeDays)
        : r.score;
      return { path: r.path, decayedScore, originalScore: r.score };
    });

    scored.sort(
      (a, b) =>
        b.decayedScore - a.decayedScore ||
        b.originalScore - a.originalScore ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );

    return scored.slice(0, limit).map((s) => ({
      path: s.path,
      score: s.decayedScore,
      originalScore: s.originalScore,
    }));
  }

  function daysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString();
  }

  test("recent low-relevance article outranks old high-relevance article", () => {
    const results = simulateFreshnessPipeline(
      [
        { path: "old-great.md", file_path: "old-great.md", score: 0.95, dateStr: daysAgo(730) },
        { path: "new-ok.md", file_path: "new-ok.md", score: 0.60, dateStr: daysAgo(7) },
      ],
      365,
      10,
    );

    expect(results[0].path).toBe("new-ok.md");
    expect(results[1].path).toBe("old-great.md");
    // new-ok: 0.60 * 0.5^(7/365) ≈ 0.592
    // old-great: 0.95 * 0.5^(730/365) = 0.95 * 0.25 = 0.2375
    expect(results[0].score).toBeGreaterThan(0.58);
    expect(results[1].score).toBeCloseTo(0.2375, 2);
  });

  test("originalScore is preserved and differs from decayed score", () => {
    const results = simulateFreshnessPipeline(
      [
        { path: "a.md", file_path: "a.md", score: 0.90, dateStr: daysAgo(365) },
      ],
      365,
      10,
    );

    expect(results[0].originalScore).toBe(0.90);
    expect(results[0].score).toBeCloseTo(0.45, 2); // 0.90 * 0.5
    expect(results[0].score).not.toBe(results[0].originalScore);
  });

  test("limit trims after re-sort, not before", () => {
    // 5 results, limit=2. After decay the ranking changes.
    const results = simulateFreshnessPipeline(
      [
        { path: "1-old-best.md", file_path: "1-old-best.md", score: 0.99, dateStr: daysAgo(1000) },
        { path: "2-old-good.md", file_path: "2-old-good.md", score: 0.85, dateStr: daysAgo(800) },
        { path: "3-mid-mid.md", file_path: "3-mid-mid.md", score: 0.70, dateStr: daysAgo(200) },
        { path: "4-new-ok.md", file_path: "4-new-ok.md", score: 0.55, dateStr: daysAgo(30) },
        { path: "5-new-low.md", file_path: "5-new-low.md", score: 0.40, dateStr: daysAgo(10) },
      ],
      365,
      2,
    );

    expect(results).toHaveLength(2);
    // The two newest articles should win because old ones decay heavily
    // 4-new-ok: 0.55 * 0.5^(30/365) ≈ 0.517
    // 5-new-low: 0.40 * 0.5^(10/365) ≈ 0.392
    // 3-mid-mid: 0.70 * 0.5^(200/365) ≈ 0.479
    // 1-old-best: 0.99 * 0.5^(1000/365) ≈ 0.133
    // 2-old-good: 0.85 * 0.5^(800/365) ≈ 0.185
    // Sorted: 4-new-ok, 3-mid-mid, ...
    expect(results[0].path).toBe("4-new-ok.md");
    expect(results[1].path).toBe("3-mid-mid.md");
  });

  test("null date results in no decay (score unchanged)", () => {
    const results = simulateFreshnessPipeline(
      [
        { path: "no-date.md", file_path: "no-date.md", score: 0.80, dateStr: null },
        { path: "old.md", file_path: "old.md", score: 0.80, dateStr: daysAgo(730) },
      ],
      365,
      10,
    );

    // no-date keeps original score, old decays
    expect(results[0].path).toBe("no-date.md");
    expect(results[0].score).toBe(0.80);
    expect(results[0].originalScore).toBe(0.80);
    expect(results[1].score).toBeCloseTo(0.20, 2); // 0.80 * 0.25
  });

  test("without freshness, original order by score is preserved", () => {
    // Simulate non-freshness path: no decay applied
    const rawResults = [
      { path: "old-high.md", score: 0.95 },
      { path: "new-low.md", score: 0.60 },
    ];

    // Without freshness, results stay sorted by original score
    const sorted = [...rawResults].sort((a, b) => b.score - a.score);
    expect(sorted[0].path).toBe("old-high.md");
    expect(sorted[1].path).toBe("new-low.md");
  });

  test("decay values match the spec table", () => {
    const halfLife = 365;
    // Spec: 新着=1.0x, 6ヶ月≈0.71x, 1年=0.5x, 2年=0.25x
    const cases: [number, number][] = [
      [0, 1.0],
      [182.5, 0.707],
      [365, 0.5],
      [730, 0.25],
    ];

    for (const [ageDays, expectedMultiplier] of cases) {
      const date = new Date(Date.now() - ageDays * 86_400_000);
      const result = applyFreshnessDecay(1.0, date, halfLife);
      expect(result).toBeCloseTo(expectedMultiplier, 2);
    }
  });

  test("custom half-life of 180 days decays more aggressively", () => {
    const results365 = simulateFreshnessPipeline(
      [{ path: "a.md", file_path: "a.md", score: 1.0, dateStr: daysAgo(180) }],
      365,
      10,
    );
    const results180 = simulateFreshnessPipeline(
      [{ path: "a.md", file_path: "a.md", score: 1.0, dateStr: daysAgo(180) }],
      180,
      10,
    );

    // With 180-day half-life, 180 days old = exactly 0.5
    expect(results180[0].score).toBeCloseTo(0.5, 2);
    // With 365-day half-life, 180 days old ≈ 0.71
    expect(results365[0].score).toBeCloseTo(0.707, 2);
    expect(results180[0].score).toBeLessThan(results365[0].score);
  });
});

describe("Limit Expansion", () => {
  test("candidate pool expands to 3x when freshness enabled", () => {
    const originalLimit = 20;
    const expanded = Math.min(originalLimit * 3, 200);
    expect(expanded).toBe(60);
  });

  test("candidate pool capped at 200", () => {
    const originalLimit = 100;
    const expanded = Math.min(originalLimit * 3, 200);
    expect(expanded).toBe(200);
  });

  test("default limit is 20 when not specified", () => {
    const body = JSON.stringify({
      query: "test",
      filter: { freshness: true },
    });
    const result = parseRequest(body);
    expect(result).not.toBeInstanceOf(type.errors);
    if (!(result instanceof type.errors)) {
      const originalLimit = result.filter.limit ?? 20;
      expect(originalLimit).toBe(20);
    }
  });
});
