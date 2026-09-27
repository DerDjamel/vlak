import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const lifetime = vi.hoisted(() => ({
  promises: [] as Promise<unknown>[],
  timeline: [] as string[],
}));

vi.mock("@vercel/functions", () => ({
  waitUntil(promise: Promise<unknown>) {
    lifetime.timeline.push("wait-until");
    lifetime.promises.push(promise);
  },
}));

import handler from "../../../api/mcp.js";

const localFetch = globalThis.fetch;
let httpServer: Server | undefined;
let releaseCollector: (() => void) | undefined;
const handlers: Promise<void>[] = [];

afterEach(async () => {
  releaseCollector?.();
  await Promise.allSettled(handlers);
  if (httpServer) {
    await new Promise<void>((resolve, reject) => httpServer!.close(error => error ? reject(error) : resolve()));
  }
  httpServer = undefined;
  releaseCollector = undefined;
  handlers.length = 0;
  lifetime.promises.length = 0;
  lifetime.timeline.length = 0;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Hosted MCP API lifetime", () => {
  it("registers background lifetime before ending the response and protects pending delivery", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VLAK_MCP_METRICS_ENABLED", "true");
    vi.stubEnv("VLAK_MCP_METRICS_TOKEN", "test-only-metrics-token-".repeat(3));

    const collectorResponse = new Promise<Response>(resolve => {
      releaseCollector = () => {
        lifetime.timeline.push("collector-done");
        resolve(new Response(null, { status: 204 }));
      };
    });
    // No outbound request reaches Noord. Only the saved fetch below reaches our loopback server.
    const collector = vi.fn((url: string | URL | Request) => {
      if (String(url) !== "https://noord.dev/api/analytics/vlak-mcp") {
        throw new Error("Unexpected outbound request blocked by test");
      }
      lifetime.timeline.push("collector-start");
      return collectorResponse;
    });
    vi.stubGlobal("fetch", collector);

    httpServer = createHttpServer((request, response) => {
      const end = response.end;
      response.end = ((...args: unknown[]) => {
        lifetime.timeline.push("response-end");
        return Reflect.apply(end, response, args);
      }) as typeof response.end;
      handlers.push(handler(request, response));
    });
    await new Promise<void>(resolve => httpServer!.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    const response = await localFetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_guide", arguments: {} } }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result.isError).not.toBe(true);
    expect(body.result.content).toBeInstanceOf(Array);
    expect(collector).toHaveBeenCalledOnce();
    expect(lifetime.promises).toHaveLength(1);
    expect(lifetime.timeline.indexOf("wait-until")).toBeLessThan(lifetime.timeline.indexOf("response-end"));

    let lifetimeSettled = false;
    const protectedCompletion = lifetime.promises[0]!.then(() => { lifetimeSettled = true; });
    await Promise.resolve();
    expect(lifetimeSettled).toBe(false);

    releaseCollector!();
    await protectedCompletion;
    await Promise.all(handlers);
    expect(lifetimeSettled).toBe(true);
    expect(lifetime.timeline.indexOf("collector-done")).toBeGreaterThan(lifetime.timeline.indexOf("response-end"));
  });
});
