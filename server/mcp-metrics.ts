import type { McpToolMetric } from "../packages/mcp/src/telemetry.js";
import type { IncomingHttpHeaders } from "node:http";

const COLLECTOR = "https://noord.dev/api/analytics/vlak-mcp";
const TIMEOUT_MS = 1_000;

/** Hosted production only. Local stdio, previews, and unconfigured deployments collect nothing. */
export function createMcpMetricsReporter(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
  privacyHeaders: IncomingHttpHeaders = {},
) {
  const token = env.VLAK_MCP_METRICS_TOKEN;
  const validToken = typeof token === "string" && /^[\x21-\x7e]{32,512}$/.test(token);
  const enabled = env.VERCEL_ENV === "production" &&
    env.VLAK_MCP_METRICS_ENABLED === "true" && validToken &&
    privacyHeaders.dnt !== "1" && privacyHeaders["sec-gpc"] !== "1";
  const pending: Promise<void>[] = [];
  return {
    enabled,
    observe(event: McpToolMetric) {
      if (!enabled) return;
      // An explicit payload protects against future accidental additions to observer events.
      const payload: McpToolMetric = {
        schemaVersion: 1, eventId: event.eventId, occurredAt: event.occurredAt,
        tool: event.tool, source: event.source, outcome: event.outcome, durationMs: event.durationMs,
      };
      pending.push((async () => {
        try {
          const response = await fetcher(COLLECTOR, {
            method: "POST", redirect: "error", cache: "no-store",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!response.ok) console.warn("Vlak MCP metrics delivery failed");
          await response.body?.cancel();
        } catch {
          console.warn("Vlak MCP metrics delivery failed");
        }
      })());
    },
    async flush() {
      // Await after the MCP response is sent, before the serverless invocation can freeze.
      await Promise.all(pending.splice(0));
    },
  };
}
