import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("local browser token discovery", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("does not probe an unused endpoint again for every authenticated API call", async () => {
    const axios = (await import("axios")).default;
    const get = vi.spyOn(axios, "get").mockRejectedValue({
      isAxiosError: true, response: { status: 404, data: { error: "local_token_unused" } },
    });
    const { ensureLocalBrowserToken } = await import("../api/client");
    expect(await ensureLocalBrowserToken()).toBe("");
    expect(await ensureLocalBrowserToken()).toBe("");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight discovery across concurrent API calls", async () => {
    const axios = (await import("axios")).default;
    const get = vi.spyOn(axios, "get").mockResolvedValue({ data: { token: "local-test-token" } });
    const { ensureLocalBrowserToken } = await import("../api/client");
    expect(await Promise.all([ensureLocalBrowserToken(), ensureLocalBrowserToken()]))
      .toEqual(["local-test-token", "local-test-token"]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("retries discovery after a transient transport failure", async () => {
    const axios = (await import("axios")).default;
    const get = vi.spyOn(axios, "get")
      .mockRejectedValueOnce({ isAxiosError: true, code: "ERR_NETWORK" })
      .mockResolvedValueOnce({ data: { token: "recovered-token" } });
    const { ensureLocalBrowserToken } = await import("../api/client");
    expect(await ensureLocalBrowserToken()).toBe("");
    expect(await ensureLocalBrowserToken()).toBe("recovered-token");
    expect(get).toHaveBeenCalledTimes(2);
  });
});
