import { describe, expect, it } from "vitest";
import { pluginPath, successPath, SUCCESS_PATH } from "../src/settings.js";

function context(id: string, configured: string | null = null): Parameters<typeof successPath>[0] {
  return {
    plugin: { id, version: "0.1.1" },
    settings: {
      async get<T>() { return configured as T | null; },
    },
  };
}
describe("installation-specific public URLs", () => {
  it.each(["payments", "r_rf3kg2if6lylfcdv"])("uses the actual runtime ID %s", async id => {
    const ctx = context(id);
    expect(pluginPath(ctx, "webhook")).toBe(`/_emdash/api/plugins/${id}/webhook`);
    expect(await successPath(ctx)).toBe(`/_emdash/api/plugins/${id}/complete`);
  });
  it("migrates the saved legacy default for a registry installation", async () => {
    expect(await successPath(context("r_rf3kg2if6lylfcdv", SUCCESS_PATH)))
      .toBe("/_emdash/api/plugins/r_rf3kg2if6lylfcdv/complete");
  });
  it("preserves a custom same-site thank-you page", async () => {
    expect(await successPath(context("r_rf3kg2if6lylfcdv", "/payment-success"))).toBe("/payment-success");
  });
  it("rejects an unsafe saved destination", async () => {
    await expect(successPath(context("r_rf3kg2if6lylfcdv", "//outside.example"))).rejects.toThrow();
  });
});
