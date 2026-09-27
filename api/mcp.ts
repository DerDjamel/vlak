import type { ServerResponse } from "node:http";
import props from "../packages/core/props/props.json" with { type: "json" };
import { primeData, type Bundle, type PropsJson } from "../packages/mcp/src/data.js";
import { handleMcpRequest, type McpHttpRequest } from "../packages/mcp/src/http.js";
import bundle from "../registry/bundle.json" with { type: "json" };
import { createMcpMetricsReporter } from "../server/mcp-metrics.js";

primeData(bundle as Bundle, props as PropsJson);

export default async function handler(request: McpHttpRequest, response: ServerResponse) {
  const metrics = createMcpMetricsReporter(process.env, fetch, request.headers);
  try {
    await handleMcpRequest(request, response, metrics.enabled ? metrics.observe : undefined);
  } finally {
    await metrics.flush();
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};
