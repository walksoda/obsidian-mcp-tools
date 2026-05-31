import { type } from "arktype";
import { SmartConnections } from "shared";

const searchRequest = type({
  query: type("string>0").describe("A search phrase for semantic search"),
  "filter?": {
    "folders?": type("string[]").describe(
      'An array of folder names to include. For example, ["Public", "Work"]',
    ),
    "excludeFolders?": type("string[]").describe(
      'An array of folder names to exclude. For example, ["Private", "Archive"]',
    ),
    "tags?": type("string[]").describe(
      'Include only notes having any of these tags (OR match, hierarchical: "project" also matches "project/active"). Leading # optional. For example, ["work", "draft"]',
    ),
    "excludeTags?": type("string[]").describe(
      "Exclude notes having any of these tags. Same matching rules as tags.",
    ),
    "limit?": type("number>0").describe(
      "The maximum number of results to return",
    ),
    "freshness?": type("boolean").describe(
      "Enable freshness-based score decay. Newer articles score higher. (default: false)",
    ),
    "freshnessHalfLife?": type("number>0").describe(
      "Half-life in days for freshness decay. Score halves every N days. (default: 365)",
    ),
  },
});
export const jsonSearchRequest = type("string.json.parse").to(searchRequest);

const searchResponse = type({
  results: type({
    path: "string",
    text: "string",
    score: "number",
    breadcrumbs: "string",
    "originalScore?": "number",
  }).array(),
});
export type SearchResponse = typeof searchResponse.infer;

export const searchParameters = type({
  query: "string",
  filter: SmartConnections.SmartSearchFilter,
});

export const searchParametersWithFreshness = type({
  query: "string",
  filter: SmartConnections.SmartSearchFilter,
  "tags?": "string[]",
  "excludeTags?": "string[]",
  "freshness?": "boolean",
  "freshnessHalfLife?": "number>0",
});