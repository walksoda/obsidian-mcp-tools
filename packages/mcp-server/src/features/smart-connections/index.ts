import { makeRequest, type ToolRegistry } from "$/shared";
import { type } from "arktype";
import { LocalRestAPI } from "shared";

export function registerSmartConnectionsTools(tools: ToolRegistry) {
  tools.register(
    type({
      name: '"search_vault_smart"',
      arguments: {
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
      },
    }).describe(
      "Search for documents semantically matching a text string. The tags/excludeTags filters narrow the semantic top-N candidate set (not the whole vault), so a rare tag whose notes are not semantically top-ranked may yield few or no results.",
    ),
    async ({ arguments: args }) => {
      const data = await makeRequest(
        LocalRestAPI.ApiSmartSearchResponse,
        `/search/smart`,
        {
          method: "POST",
          body: JSON.stringify(args),
        },
      );

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
    { readOnlyHint: true },
  );
}
