import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore, type VectorPort } from "@palup/platform-ports";
import { mergeGuestIntoAccount } from "../src/merge.js";
import { subjectNamespace, accountSubjectId } from "../src/identity.js";

// B12(b) — "all facts related to a user follow him from guest to account", AND "the guest remains usable".
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED AND WHY. The previous `mergeGuestIntoAccount` was a MOVE: it copied the facts and then
// `deleteNamespace`d the guest. That is exactly what made the withdrawn B12(a) attempt a DATA-THEFT
// vector rather than merely a read exposure — nothing proves a client-supplied `anonId` belongs to its
// caller (C1), so an attacker presenting a victim's `anonId` while signed in as themselves took the
// victim's facts AND the victim lost them.
//
// Copy-not-move removes the destruction half outright, which is what makes this shippable where the
// previous version was not:
//
//   * the residual becomes "someone with your device could COPY facts they can already READ" — C1
//     already grants recall against a namespace whose `anonId` you hold, so no new access is created,
//     only persistence of access that exists today;
//   * there is no deletion primitive to abuse at all, so the victim never loses anything;
//   * and it is what "the guest remains usable" actually requires — signing out must not wipe the memory
//     you built as a guest.
//
// The guest copy is not immortal: it stops being written to once the shopper is signed in, so the
// scheduled retention sweep (B4) reclaims it on the ordinary TTL. Data minimisation happens by expiry
// rather than by a delete this code could get wrong or an attacker could trigger.
//
// IDEMPOTENCE IS NOW BY CONTENT, NOT BY DELETION. The old function was self-limiting because it erased
// its own source. Copying is not, so this migrates only ids the account does NOT already hold, and
// writes NO audit when nothing moved. That matters concretely: the production caller runs on every
// verified turn that presents a guest `anonId`, so an unconditional audit would put a `merge` row in the
// immutable log on every single chat message.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const TENANT = "acme";
const GUEST = "GUESTAAAAAAAAAAAAAAAAAAAAA234567";
const ACCOUNT = "shopify:acme:1234";

const guestNs = () => subjectNamespace(TENANT, GUEST);
const acctNs = () => subjectNamespace(TENANT, accountSubjectId(ACCOUNT));

async function seed(vector: VectorPort, ns: string, facts: Array<{ id: string; text: string; cls?: "ordinary" | "special" }>) {
  await vector.upsert(
    ns,
    facts.map((f) => ({ id: f.id, text: f.text, metadata: { class: f.cls ?? "ordinary", text: f.text } })),
  );
}
const idsIn = async (vector: VectorPort, ns: string) =>
  (await vector.query(ns, { text: "", k: 100 })).map((m) => m.id).sort();

function fixture() {
  const vector = createInMemoryVectorStore();
  const audit = new InMemoryRuntimeStore();
  const merge = (consent2: "in" | "out" | "unknown" = "unknown") =>
    mergeGuestIntoAccount({ vector, audit, hmacKey: "k" }, { tenantId: TENANT, anonId: GUEST, accountId: ACCOUNT, consent2 });
  const mergeRows = async () =>
    (await audit.readAudit({ tenantId: TENANT }, { limit: 100 })).filter((a) => (a as { action?: string }).action === "merge");
  return { vector, audit, merge, mergeRows };
}

describe("B12 — facts FOLLOW the shopper to the account, and the guest keeps its own", () => {
  it("THE CHANGE: the guest namespace is INTACT after the merge — signing out must not wipe guest memory", async () => {
    const { vector, merge } = fixture();
    await seed(vector, guestNs(), [{ id: "f1", text: "prefers fragrance-free" }, { id: "f2", text: "dry skin" }]);

    expect((await merge()).merged).toBe(2);

    expect(await idsIn(vector, acctNs()), "the facts did not follow the shopper to the account").toEqual(["f1", "f2"]);
    expect(
      await idsIn(vector, guestNs()),
      "the guest namespace was emptied — that is the MOVE semantics this change exists to remove",
    ).toEqual(["f1", "f2"]);
  });

  it("the copied facts keep their text and class, so the account's recall sees the same content", async () => {
    const { vector, merge } = fixture();
    await seed(vector, guestNs(), [{ id: "f1", text: "prefers fragrance-free" }]);
    await merge();
    const [rec] = await vector.query(acctNs(), { text: "", k: 10 });
    expect((rec?.metadata as { text?: string } | undefined)?.text).toBe("prefers fragrance-free");
    expect((rec?.metadata as { class?: string } | undefined)?.class).toBe("ordinary");
  });
});

describe("B12 — idempotence is by CONTENT now, because the source is no longer destroyed", () => {
  it("a second merge reports 0 and does not duplicate anything", async () => {
    const { vector, merge } = fixture();
    await seed(vector, guestNs(), [{ id: "f1", text: "a" }, { id: "f2", text: "b" }]);
    expect((await merge()).merged).toBe(2);

    expect((await merge()).merged, "re-migrated facts the account already had").toBe(0);
    expect(await idsIn(vector, acctNs())).toEqual(["f1", "f2"]);
  });

  it("a no-op merge writes NO audit row — the caller runs per turn, so an unconditional audit would spam the immutable log", async () => {
    const { vector, merge, mergeRows } = fixture();
    await seed(vector, guestNs(), [{ id: "f1", text: "a" }]);
    await merge();
    expect(await mergeRows()).toHaveLength(1);

    await merge();
    await merge();
    expect(await mergeRows(), "every turn added a merge row even though nothing moved").toHaveLength(1);
  });

  it("a guest fact added AFTER the first sign-in still follows on the next merge — 'all facts', not 'the first batch'", async () => {
    const { vector, merge } = fixture();
    await seed(vector, guestNs(), [{ id: "f1", text: "a" }]);
    await merge();

    // The shopper signs out, chats as a guest again, then signs back in.
    await seed(vector, guestNs(), [{ id: "f2", text: "b" }]);
    expect((await merge()).merged).toBe(1);
    expect(await idsIn(vector, acctNs())).toEqual(["f1", "f2"]);
  });

  it("an account fact the guest never had is untouched by the merge", async () => {
    const { vector, merge } = fixture();
    await seed(vector, acctNs(), [{ id: "own", text: "written while signed in" }]);
    await seed(vector, guestNs(), [{ id: "f1", text: "a" }]);
    await merge();
    expect(await idsIn(vector, acctNs())).toEqual(["f1", "own"]);
  });

  it("an empty guest namespace is a cheap no-op: nothing written, nothing audited", async () => {
    const { vector, merge, mergeRows } = fixture();
    expect((await merge()).merged).toBe(0);
    expect(await idsIn(vector, acctNs())).toEqual([]);
    expect(await mergeRows()).toHaveLength(0);
  });
});

describe("B12 — Inv 9 still governs special-category facts (unchanged by copy-not-move)", () => {
  it("special facts are DROPPED without account Consent 2, and are NOT removed from the guest either", async () => {
    const { vector, merge } = fixture();
    await seed(vector, guestNs(), [
      { id: "ord", text: "prefers fragrance-free" },
      { id: "spec", text: "eczema", cls: "special" },
    ]);

    expect((await merge("unknown")).merged).toBe(1);
    expect(await idsIn(vector, acctNs()), "a special fact was promoted onto sign-up ToS consent").toEqual(["ord"]);
    // Dropped from the MIGRATION, not deleted from the shopper's own guest namespace.
    expect(await idsIn(vector, guestNs())).toEqual(["ord", "spec"]);
  });

  it("special facts DO follow once Consent 2 is granted for the account — including one dropped by an earlier merge", async () => {
    const { vector, merge } = fixture();
    await seed(vector, guestNs(), [
      { id: "ord", text: "prefers fragrance-free" },
      { id: "spec", text: "eczema", cls: "special" },
    ]);
    await merge("unknown"); // ord only
    expect(await idsIn(vector, acctNs())).toEqual(["ord"]);

    // Because the guest namespace was never emptied, granting Consent 2 later can still recover the
    // special fact. Under MOVE semantics it was gone for good.
    expect((await merge("in")).merged).toBe(1);
    expect(await idsIn(vector, acctNs())).toEqual(["ord", "spec"]);
  });
});
