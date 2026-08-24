import { describe, it, expect, vi } from "vitest";
import { makeApiClient } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const base = { baseUrl: "/api", getToken: async () => "tok" };

// Typed helper so `.mock.calls[n]` is a real `[string, RequestInit]` tuple (not `[]`) under this
// repo's `noUncheckedIndexedAccess` — matches api.test.ts's own `mockFetch` idiom.
function mockFetch(impl: () => Response) {
  return vi.fn<typeof fetch>(() => Promise.resolve(impl()));
}

describe("api client — rules methods", () => {
  it("getRules GETs /rules and returns the envelope", async () => {
    const fetch = mockFetch(() => jsonResponse({ envelope: { discount: { allowedAuto: false } } }));
    const api = makeApiClient({ ...base, fetch });
    const out = await api.getRules();
    expect(fetch).toHaveBeenCalledWith("/api/rules", expect.objectContaining({}));
    expect(out.envelope.discount!.allowedAuto).toBe(false);
  });

  it("putRules PUTs the patch and returns { envelope, bigJump }", async () => {
    const fetch = mockFetch(() => jsonResponse({ envelope: { discount: { allowedAuto: true, maxPct: 15 } }, bigJump: true }));
    const api = makeApiClient({ ...base, fetch });
    const out = await api.putRules({ discount: { allowedAuto: true, maxPct: 15 } });
    const [, init] = fetch.mock.calls[0]!;
    expect(init!.method).toBe("PUT");
    expect(JSON.parse(init!.body as string)).toEqual({ discount: { allowedAuto: true, maxPct: 15 } });
    expect(out.bigJump).toBe(true);
  });

  it("previewRules POSTs to /rules/preview", async () => {
    const fetch = mockFetch(() => jsonResponse({ before: {}, after: {}, bigJump: false }));
    const api = makeApiClient({ ...base, fetch });
    await api.previewRules({ ad_spend: { allowedAuto: true, roiFloor: 3 } });
    expect(fetch.mock.calls[0]![0]).toBe("/api/rules/preview");
    expect(fetch.mock.calls[0]![1]!.method).toBe("POST");
  });

  it("applyRulePreset POSTs the presetId", async () => {
    const fetch = mockFetch(() => jsonResponse({ envelope: {}, bigJump: true }));
    const api = makeApiClient({ ...base, fetch });
    await api.applyRulePreset("skincare");
    expect(fetch.mock.calls[0]![0]).toBe("/api/rules/apply-preset");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ presetId: "skincare" });
  });

  it("getFloors and listRulePresets GET their paths", async () => {
    const fetch = mockFetch(() => jsonResponse({ floors: {}, presets: [] }));
    const api = makeApiClient({ ...base, fetch });
    await api.getFloors();
    await api.listRulePresets();
    expect(fetch.mock.calls[0]![0]).toBe("/api/rules/floors");
    expect(fetch.mock.calls[1]![0]).toBe("/api/rules/presets");
  });
});
