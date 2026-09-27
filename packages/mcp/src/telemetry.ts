import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const TOOLS = new Set([
  "list_workflows", "get_workflow", "list_components", "get_component",
  "search_components", "get_tokens", "get_install", "get_guide",
]);

export type McpToolMetric = {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  tool: string;
  source: "openai_hint" | "unknown";
  outcome: "success" | "error";
  durationMs: number;
};

export type McpMetricObserver = (event: McpToolMetric) => void;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Client metadata is an unverified hint, never an identity or proof of installation. */
export function metricSource(meta: unknown): McpToolMetric["source"] {
  const fields = object(meta);
  return ["openai/userAgent", "openai/session", "openai/subject"].some(key =>
    typeof fields?.[key] === "string" && (fields[key] as string).length > 0,
  ) ? "openai_hint" : "unknown";
}

/** Attach after server.connect(), before accepting requests. Never retain arguments or identifiers. */
export function observeToolCalls(transport: Transport, observe: McpMetricObserver): void {
  const pending = new Map<string | number, { started: number; tool: string; source: McpToolMetric["source"] }>();
  const onmessage = transport.onmessage;
  const send = transport.send.bind(transport);
  const onclose = transport.onclose;

  transport.onmessage = (message, extra) => {
    if ("method" in message && message.method === "tools/call" && "id" in message) {
      const params = object(message.params);
      if (typeof params?.name === "string" && TOOLS.has(params.name)) {
        pending.set(message.id, {
          started: performance.now(), tool: params.name, source: metricSource(params._meta),
        });
      }
    }
    onmessage?.(message, extra);
  };

  transport.send = async (message, options) => {
    const id = "id" in message ? message.id : undefined;
    const metric = id !== undefined && !("method" in message) ? pending.get(id) : undefined;
    if (!metric) return send(message, options);
    // Remove before yielding so a duplicate response cannot count twice.
    if (id !== undefined) pending.delete(id);
    let outcome: McpToolMetric["outcome"] = "error" in message ||
      ("result" in message && message.result.isError === true) ? "error" : "success";
    try {
      await send(message, options);
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      try {
        observe({
          schemaVersion: 1, eventId: randomUUID(), occurredAt: new Date().toISOString(),
          tool: metric.tool, source: metric.source, outcome,
          durationMs: Math.min(30_000, Math.max(0, Math.round(performance.now() - metric.started))),
        });
      } catch {
        // Analytics must never change a tool response or leak its contents.
      }
    }
  };

  transport.onclose = () => {
    pending.clear();
    onclose?.();
  };
}
