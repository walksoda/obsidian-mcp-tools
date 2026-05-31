import { type } from "arktype";
import type { Request, Response } from "express";
import { getAllTags, Notice, Plugin, TFile } from "obsidian";
import { shake } from "radash";
import { lastValueFrom } from "rxjs";
import {
  jsonSearchRequest,
  LocalRestAPI,
  searchParametersWithFreshness,
  Templater,
  type PromptArgAccessor,
  type SearchResponse,
} from "shared";
import { setup as setupCore } from "./features/core";
import { setup as setupMcpServerInstall } from "./features/mcp-server-install";
import {
  loadLocalRestAPI,
  loadSmartSearchAPI,
  loadTemplaterAPI,
  type Dependencies,
} from "./shared";
import { logger } from "./shared/logger";

export default class McpToolsPlugin extends Plugin {
  private localRestApi: Dependencies["obsidian-local-rest-api"] = {
    id: "obsidian-local-rest-api",
    name: "Local REST API",
    required: true,
    installed: false,
  };

  async getLocalRestApiKey(): Promise<string | undefined> {
    // The API key is stored in the plugin's settings
    return this.localRestApi.plugin?.settings?.apiKey;
  }

  async onload() {
    // Initialize features in order
    await setupCore(this);
    await setupMcpServerInstall(this);

    // Check for required dependencies
    lastValueFrom(loadLocalRestAPI(this)).then((localRestApi) => {
      this.localRestApi = localRestApi;

      if (!this.localRestApi.api) {
        new Notice(
          `${this.manifest.name}: Local REST API plugin is required but not found. Please install it from the community plugins and restart Obsidian.`,
          0,
        );
        return;
      }

      // Register endpoints
      this.localRestApi.api
        .addRoute("/search/smart")
        .post(this.handleSearchRequest.bind(this));

      this.localRestApi.api
        .addRoute("/templates/execute")
        .post(this.handleTemplateExecution.bind(this));

      logger.info("MCP Tools Plugin loaded");
    });
  }

  private async handleTemplateExecution(req: Request, res: Response) {
    try {
      const { api: templater } = await lastValueFrom(loadTemplaterAPI(this));
      if (!templater) {
        new Notice(
          `${this.manifest.name}: Templater plugin is not available. Please install it from the community plugins.`,
          0,
        );
        logger.error("Templater plugin is not available");
        res.status(503).json({
          error: "Templater plugin is not available",
        });
        return;
      }

      // Validate request body
      const params = LocalRestAPI.ApiTemplateExecutionParams(req.body);

      if (params instanceof type.errors) {
        const response = {
          error: "Invalid request body",
          body: req.body,
          summary: params.summary,
        };
        logger.debug("Invalid request body", response);
        res.status(400).json(response);
        return;
      }

      // Get prompt content from vault
      const templateFile = this.app.vault.getAbstractFileByPath(params.name);
      if (!(templateFile instanceof TFile)) {
        logger.debug("Template file not found", {
          params,
          templateFile,
        });
        res.status(404).json({
          error: `File not found: ${params.name}`,
        });
        return;
      }

      const config = templater.create_running_config(
        templateFile,
        templateFile,
        Templater.RunMode.CreateNewFromTemplate,
      );

      const prompt: PromptArgAccessor = (argName: string) => {
        return params.arguments[argName] ?? "";
      };

      const oldGenerateObject =
        templater.functions_generator.generate_object.bind(
          templater.functions_generator,
        );

      // Override generate_object to inject arg into user functions
      templater.functions_generator.generate_object = async function (
        config,
        functions_mode,
      ) {
        const functions = await oldGenerateObject(config, functions_mode);
        Object.assign(functions, { mcpTools: { prompt } });
        return functions;
      };

      // Process template with variables
      const processedContent = await templater.read_and_parse_template(config);

      // Restore original functions generator
      templater.functions_generator.generate_object = oldGenerateObject;

      // Create new file if requested
      if (params.createFile && params.targetPath) {
        await this.app.vault.create(params.targetPath, processedContent);
        res.json({
          message: "Prompt executed and file created successfully",
          content: processedContent,
        });
        return;
      }

      res.json({
        message: "Prompt executed without creating a file",
        content: processedContent,
      });
    } catch (error) {
      logger.error("Prompt execution error:", {
        error: error instanceof Error ? error.message : error,
        body: req.body,
      });
      res.status(503).json({
        error: "An error occurred while processing the prompt",
      });
      return;
    }
  }

  private getArticleDate(filePath: string): Date | null {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    for (const key of ["published", "created"]) {
      const val = fm?.[key];
      if (val != null) {
        if (typeof val !== "string" && typeof val !== "number") continue;
        const d = new Date(val);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
    return new Date(file.stat.ctime);
  }

  private getFileTags(filePath: string): string[] {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return [];
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return [];
    return (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, ""));
  }

  /**
   * OR match with hierarchical prefix: a query tag "project" matches a note
   * tag "project" or any child like "project/active". Leading # is ignored on
   * both sides.
   */
  private tagsMatch(noteTags: string[], query: string[]): boolean {
    return query.some((q) => {
      const nq = q.replace(/^#/, "");
      return noteTags.some((t) => t === nq || t.startsWith(`${nq}/`));
    });
  }

  private async handleSearchRequest(req: Request, res: Response) {
    try {
      const dep = await lastValueFrom(loadSmartSearchAPI(this));
      const smartSearch = dep.api;
      if (!smartSearch) {
        new Notice(
          "Smart Search REST API Plugin: smart-connections plugin is required but not found. Please install it from the community plugins.",
          0,
        );
        res.status(503).json({
          error: "Smart Connections plugin is not available",
        });
        return;
      }

      // Validate request body, extracting freshness params separately
      const requestBody = jsonSearchRequest
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
        .to(searchParametersWithFreshness)(req.body);
      if (requestBody instanceof type.errors) {
        res.status(400).json({
          error: "Invalid request body",
          summary: requestBody.summary,
        });
        return;
      }

      const freshness = requestBody.freshness ?? false;
      const halfLifeDays = requestBody.freshnessHalfLife ?? 365;
      const originalLimit = requestBody.filter.limit ?? 20;

      const includeTags = requestBody.tags ?? [];
      const excludeTags = requestBody.excludeTags ?? [];
      const hasTags = includeTags.length > 0 || excludeTags.length > 0;

      // Expand candidate pool when freshness or tag filtering is enabled, since
      // both trim the result set after the search runs.
      const needsExpansion = freshness || hasTags;
      const searchFilter = needsExpansion
        ? { ...requestBody.filter, limit: Math.min(originalLimit * 3, 200) }
        : requestBody.filter;

      // Perform search
      const rawResults = await smartSearch.search(
        requestBody.query,
        searchFilter,
      );

      // Apply tag filtering (OR include, OR exclude) against file metadata.
      const results = hasTags
        ? rawResults.filter((result) => {
            const noteTags = this.getFileTags(
              result.item.file_path ?? result.item.path,
            );
            if (includeTags.length > 0 && !this.tagsMatch(noteTags, includeTags)) {
              return false;
            }
            if (excludeTags.length > 0 && this.tagsMatch(noteTags, excludeTags)) {
              return false;
            }
            return true;
          })
        : rawResults;

      if (freshness) {
        // Apply freshness decay, re-sort, and trim to original limit
        const scored = results.map((result) => {
          const date = this.getArticleDate(result.item.file_path ?? result.item.path);
          const ageDays = date
            ? Math.max(0, (Date.now() - date.getTime()) / 86_400_000)
            : 0;
          const decayedScore = date
            ? result.score * Math.pow(0.5, ageDays / halfLifeDays)
            : result.score;
          return { result, decayedScore, originalScore: result.score };
        });

        // Sort: decayedScore desc → originalScore desc → path asc
        scored.sort((a, b) =>
          b.decayedScore - a.decayedScore
          || b.originalScore - a.originalScore
          || (a.result.item.path < b.result.item.path ? -1 : a.result.item.path > b.result.item.path ? 1 : 0),
        );

        const trimmed = scored.slice(0, originalLimit);

        const response: SearchResponse = {
          results: await Promise.all(
            trimmed.map(async ({ result, decayedScore, originalScore }) => ({
              path: result.item.path,
              text: await result.item.read(),
              score: decayedScore,
              breadcrumbs: result.item.breadcrumbs,
              originalScore,
            })),
          ),
        };

        res.json(response);
        return;
      }

      // Non-freshness path. When the candidate pool was expanded for tag
      // filtering, trim back to the requested limit; otherwise preserve the
      // original (search-limited) result set untouched.
      const trimmedResults = needsExpansion
        ? results.slice(0, originalLimit)
        : results;
      const response: SearchResponse = {
        results: await Promise.all(
          trimmedResults.map(async (result) => ({
            path: result.item.path,
            text: await result.item.read(),
            score: result.score,
            breadcrumbs: result.item.breadcrumbs,
          })),
        ),
      };

      res.json(response);
      return;
    } catch (error) {
      logger.error("Smart Search API error:", { error, body: req.body });
      res.status(503).json({
        error: "An error occurred while processing the search request",
      });
      return;
    }
  }

  onunload() {
    this.localRestApi.api?.unregister();
  }
}
