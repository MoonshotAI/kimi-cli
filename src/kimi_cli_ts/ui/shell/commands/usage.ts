import { loadTokens } from "../../../auth/oauth.ts";
import type { Config } from "../../../config.ts";
import { logger } from "../../../utils/logging.ts";

export async function handleUsage(config: Config, modelKey: string | undefined): Promise<void> {
  if (!modelKey || !config.models[modelKey]) {
    logger.info("No model selected. Run /login first.");
    return;
  }
  const modelCfg = config.models[modelKey]!;
  const providerCfg = config.providers[modelCfg.provider];
  if (!providerCfg) {
    logger.info("Provider not found.");
    return;
  }

  // Resolve API key (try OAuth token first)
  let apiKey = providerCfg.api_key;
  if (providerCfg.oauth) {
    const token = await loadTokens(providerCfg.oauth);
    if (token) apiKey = token.access_token;
  }

  const baseUrl = providerCfg.base_url.replace(/\/+$/, "");
  const usageUrl = `${baseUrl}/usages`;

  try {
    const res = await fetch(usageUrl, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      if (res.status === 401) logger.info("Authorization failed. Please check your API key.");
      else if (res.status === 404) logger.info("Usage endpoint not available.");
      else logger.info(`Failed to fetch usage (HTTP ${res.status}).`);
      return;
    }
    const data = await res.json() as Record<string, any>;

    // Parse and display usage
    const usage = data.usage;
    if (usage) {
      const limit = usage.limit || 0;
      const used = usage.used ?? (limit - (usage.remaining || 0));
      const pct = limit > 0 ? ((limit - used) / limit * 100).toFixed(0) : "?";
      const label = usage.name || usage.title || "Weekly limit";
      logger.info(`\n  API Usage:`);
      logger.info(`  ${label}: ${used}/${limit} used (${pct}% remaining)`);
    }

    // Parse limits array
    const limits = data.limits;
    if (Array.isArray(limits) && limits.length > 0) {
      for (const item of limits) {
        const detail = item.detail || item;
        const limit = detail.limit || 0;
        const used = detail.used ?? (limit - (detail.remaining || 0));
        const pct = limit > 0 ? ((limit - used) / limit * 100).toFixed(0) : "?";
        const name = item.name || item.title || detail.name || "Limit";
        logger.info(`  ${name}: ${used}/${limit} used (${pct}% remaining)`);
      }
    }

    if (!usage && (!limits || !limits.length)) {
      logger.info("No usage data available.");
    }
  } catch (err) {
    logger.info(`Failed to fetch usage: ${err instanceof Error ? err.message : err}`);
  }
}
