import { describe, expect, test } from "bun:test";
import { parseTunnelStatus } from "../src/tunnel";

describe("tunnel status boundary", () => {
  test("requires the managed runtime process, health, and readiness together", () => {
    expect(parseTunnelStatus(JSON.stringify({
      process_running: true,
      healthy: true,
      ready: true,
      runtime_state: "ready",
    }))).toEqual({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true healthy=true ready=true",
    });
    expect(parseTunnelStatus(JSON.stringify({
      process_running: false,
      healthy: true,
      ready: true,
      runtime_state: "ready",
    }))).toMatchObject({ ok: false, processRunning: false, healthy: true, ready: true });
  });

  test("redacts tunnel ids and keys from safe diagnostics", () => {
    const result = parseTunnelStatus(
      "failed tunnel_0123456789abcdef0123456789abcdef with sk-secretsecretsecret",
      1,
    );
    expect(result.detail).toBe("failed [tunnel-id] with [redacted-key]");
    expect(result.detail).not.toContain("0123456789abcdef");
  });
});
