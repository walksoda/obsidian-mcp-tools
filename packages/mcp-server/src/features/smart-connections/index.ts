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
    }).describe("Search for documents semantically matching a text string."),
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
  );
}
