import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { metricSource, observeToolCalls, type McpToolMetric } from "../src/telemetry.js";
import { createMcpMetricsReporter } from "../../../server/mcp-metrics.js";

function fixture() {
  const events: McpToolMetric[] = [];
  const received = vi.fn();
  const sent = vi.fn(async () => {});
  const transport: Transport = { start: async () => {}, close: async () => {}, send: sent, onmessage: received };
  observeToolCalls(transport, event => { events.push(event); });
  return { events, transport, received, sent };
}

describe("Hosted MCP metrics", () => {
  it("counts a completed tool call once without retaining arguments or metadata values", async () => {
    const { events, transport, received, sent } = fixture();
    const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: {
      name: "get_install", arguments: { name: "private text" },
      _meta: { "openai/session": "private-session", "openai/subject": "private-person" },
    } };
    transport.onmessage?.(request);
    await transport.send({ jsonrpc: "2.0", id: 1, result: { content: [], secret: "private-result" } });
    await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(received).toHaveBeenCalledWith(request, undefined);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "get_install", source: "openai_hint", outcome: "success", schemaVersion: 1 });
    expect(Object.keys(events[0]!).sort()).toEqual(["schemaVersion", "eventId", "occurredAt", "tool", "source", "outcome", "durationMs"].sort());
    expect(JSON.stringify(events)).not.toContain("private");
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0]?.durationMs).toBeLessThanOrEqual(30_000);
  });

  it("counts protocol validation and application errors without storing their messages", async () => {
    const { transport, events } = fixture();
    for (const id of [1, 2]) transport.onmessage?.({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_component" } });
    await transport.send({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "private validation message" } });
    await transport.send({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [] } });
    expect(events.map(event => event.outcome)).toEqual(["error", "error"]);
    expect(events.every(event => event.source === "unknown")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("ignores discovery, initialization, unknown tool names, and notifications", async () => {
    const { transport, events } = fixture();
    for (const method of ["initialize", "tools/list", "resources/read", "tools/call"]) {
      transport.onmessage?.({ jsonrpc: "2.0", id: 1, method, params: { name: "private-tool" } });
      await transport.send({ jsonrpc: "2.0", id: 1, result: {} });
    }
    transport.onmessage?.({ jsonrpc: "2.0", method: "tools/call", params: { name: "get_install" } });
    expect(events).toHaveLength(0);
  });

  it("does not turn telemetry failures into failed tool calls", async () => {
    const transport: Transport = { start: async () => {}, close: async () => {}, send: async () => {} };
    observeToolCalls(transport, () => { throw new Error("sink down"); });
    transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_guide" } });
    await expect(transport.send({ jsonrpc: "2.0", id: 1, result: {} })).resolves.toBeUndefined();
  });

  it("uses optional client metadata only as a hint", () => {
    for (const value of [undefined, null, "ChatGPT", [], { "openai/userAgent": "" }, { "openai/session": 2 }, { userAgent: "ChatGPT" }]) {
      expect(metricSource(value)).toBe("unknown");
    }
    expect(metricSource({ "openai/userAgent": "untrusted client value" })).toBe("openai_hint");
  });
});

describe("Noord metrics delivery", () => {
  const event: McpToolMetric = { schemaVersion: 1, eventId: "00000000-0000-4000-8000-000000000000", occurredAt: "2026-09-27T12:00:00.000Z", tool: "get_install", source: "unknown", outcome: "success", durationMs: 10 };
  const enabled = { VERCEL_ENV: "production", VLAK_MCP_METRICS_ENABLED: "true", VLAK_MCP_METRICS_TOKEN: "x".repeat(32) };

  it("never sends from local development, previews, disabled or unconfigured deployments", async () => {
    const fetcher = vi.fn();
    for (const env of [{}, { ...enabled, VERCEL_ENV: "preview" }, { ...enabled, VLAK_MCP_METRICS_ENABLED: "false" }, { ...enabled, VLAK_MCP_METRICS_TOKEN: "short" }, { ...enabled, VLAK_MCP_METRICS_TOKEN: " ".repeat(32) }, { ...enabled, VLAK_MCP_METRICS_TOKEN: "x".repeat(513) }]) {
      const reporter = createMcpMetricsReporter(env, fetcher);
      reporter.observe(event);
      await reporter.flush();
      expect(reporter.enabled).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends only explicit fields to the fixed collector and awaits delivery", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const reporter = createMcpMetricsReporter(enabled, fetcher);
    reporter.observe({ ...event, privateField: "not sent" } as McpToolMetric);
    await reporter.flush();
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://noord.dev/api/analytics/vlak-mcp");
    expect(JSON.parse(options.body as string)).toEqual(event);
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    await reporter.flush();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("honors DNT and Global Privacy Control when a client sends them", async () => {
    const fetcher = vi.fn();
    for (const headers of [{ dnt: "1" }, { "sec-gpc": "1" }]) {
      const reporter = createMcpMetricsReporter(enabled, fetcher, headers);
      reporter.observe(event);
      await reporter.flush();
      expect(reporter.enabled).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("contains network failures and never logs tokens or event content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reporter = createMcpMetricsReporter(enabled, async () => { throw new Error("sensitive failure"); });
    reporter.observe(event);
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Vlak MCP metrics delivery failed");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
