import type { ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import props from "../packages/core/props/props.json" with { type: "json" };
import { primeData, type Bundle, type PropsJson } from "../packages/mcp/src/data.js";
import { handleMcpRequest, type McpHttpRequest } from "../packages/mcp/src/http.js";
import bundle from "../registry/bundle.json" with { type: "json" };
import { createMcpMetricsReporter } from "../server/mcp-metrics.js";

primeData(bundle as Bundle, props as PropsJson);

export default async function handler(request: McpHttpRequest, response: ServerResponse) {
  const metrics = createMcpMetricsReporter(process.env, fetch, request.headers);
  // Register the complete lifetime before the transport can end the HTTP response.
  // Awaiting after response.end() alone does not keep a Vercel invocation alive.
  const completed = Promise.resolve()
    .then(() => handleMcpRequest(request, response, metrics.enabled ? metrics.observe : undefined))
    .finally(() => metrics.flush());
  if (metrics.enabled) waitUntil(completed);
  await completed;
}

export const config = {
  api: {
    bodyParser: true,
  },
};
