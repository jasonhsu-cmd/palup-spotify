import { describe, it, expect, vi } from "vitest";
import { exchangeSessionToken } from "../src/token-exchange.js";

const ARGS = {
  shopDomain: "acme.myshopify.com", clientId: "client-id-123", clientSecret: "secret",
  sessionToken: "sess.tok.en", tokenType: "online" as const,
};

function fetchOk(json: unknown) {
  return vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true, json: async () => json, __init: init,
  })) as unknown as typeof fetch;
}

describe("exchangeSessionToken", () => {
  it("POSTs the documented token-exchange grant to the shop's oauth endpoint", async () => {
    const f = fetchOk({ access_token: "at", scope: "read_orders,read_products",
      associated_user: { id: 42, account_owner: true, collaborator: false, email: "o@acme.test" } });
    await exchangeSessionToken(ARGS, f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://acme.myshopify.com/admin/oauth/access_token");
    expect((init as RequestInit).method).toBe("POST");
    const body = String((init as RequestInit).body);
    expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange");
    expect(body).toContain("subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token");
    expect(body).toContain("requested_token_type=urn%3Ashopify%3Aparams%3Aoauth%3Atoken-type%3Aonline-access-token");
    expect(body).toContain("subject_token=sess.tok.en");
    expect(body).toContain("client_id=client-id-123");
  });
  it("parses associated_user for the role bootstrap (online token)", async () => {
    const f = fetchOk({ access_token: "at", scope: "read_orders",
      associated_user: { id: 42, account_owner: true, collaborator: false, email: "o@acme.test" } });
    const r = await exchangeSessionToken(ARGS, f);
    expect(r?.accessToken).toBe("at");
    expect(r?.scope).toEqual(["read_orders"]);
    expect(r?.associatedUser).toEqual({ id: "42", accountOwner: true, collaborator: false, email: "o@acme.test" });
  });
  it("returns null on a non-2xx / missing access_token (never throws)", async () => {
    const bad = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await exchangeSessionToken(ARGS, bad)).toBeNull();
    const empty = fetchOk({ scope: "x" });
    expect(await exchangeSessionToken(ARGS, empty)).toBeNull();
  });
  it("refuses a non-myshopify host WITHOUT calling fetch (no secret egress)", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect(await exchangeSessionToken({ ...ARGS, shopDomain: "acme.evil.test" }, f)).toBeNull();
    expect((f as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
  it("swallows a transport throw into null (no code/secret leak upward)", async () => {
    const f = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    expect(await exchangeSessionToken(ARGS, f)).toBeNull();
  });
});
