import { describe, expect, test } from "bun:test";
import { Registry } from "prom-client";
import { createHealthApp, cpuPercent } from "./metrics";

describe("cpuPercent (pure)", () => {
  test("100% when the process uses one core-second per wall second", () => {
    // user/system are µs; wall is ns. 1s CPU over 1s wall = 100%.
    expect(cpuPercent({ user: 1_000_000, system: 0 }, 1_000_000_000, { user: 0, system: 0 }, 0)).toBe(100);
  });

  test("incremental slices: only the delta counts", () => {
    const t0 = 1_000_000_000;
    const busy = cpuPercent(
      { user: 500_000, system: 500_000 }, t0 + 1_000_000_000,
      { user: 0, system: 0 }, t0,
    );
    expect(busy).toBe(100);

    const idle = cpuPercent(
      { user: 500_010, system: 500_010 }, t0 + 1_100_000_000,
      { user: 500_000, system: 500_000 }, t0 + 1_000_000_000,
    );
    expect(idle).toBeLessThan(1); // 20µs CPU over 100ms wall
  });

  test("zero wall time never divides by zero", () => {
    const c = { user: 1, system: 1 };
    expect(cpuPercent(c, 5, c, 5)).toBe(0);
  });
});

describe("metrics endpoints", () => {
  const { app } = createHealthApp({ registry: new Registry() });

  test("/healthz → 204, no body", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("/metrics is scrapeable: CPU gauge + counters + RTT histogram", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("rz_cpu_percent");
    expect(body).toContain("rz_queries_total");
    expect(body).toContain("rz_query_rtt_ms");
  });

  test("default registry path also collects default process metrics", async () => {
    const prod = createHealthApp({});
    const res = await prod.app.request("/metrics");
    const body = await res.text();
    expect(body).toContain("process_resident_memory_bytes"); // collectDefaultMetrics
    expect(body).toContain("rz_cpu_percent"); // custom gauge on same registry
  });
});
