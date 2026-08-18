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
// its own source. Copying is not, so this migrates only ids the account does NOT already hold.
//
// CORRECTED (F-8/C9, ADR-0019 Revision 2 task 7): an earlier version of this file said a no-op call
// "writes NO audit when nothing moved". That was itself the C9 defect — the carry-over is a
// CROSS-SUBJECT READ of the guest namespace regardless of whether anything ends up migrating, and an
// unaudited cross-subject read is unacceptable. Every call now writes exactly one `merge` audit row,
// carrying BOTH the source (guest) and destination (account) subject refs; the `count` field is what
// distinguishes a real migration (count > 0) from a read that moved nothing (count 0). See merge.ts and
// audit.test.ts's `destAnonId` tests.
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
  // R2-2/Q19(c) — this file's own describe block below ("Inv 9 still governs special-category facts")
  // exercises ONLY the account-side `consent2` variable, exactly as it did before the compound gate
  // existed; `consent2Source`/`healthDisclosed` default to already-satisfied ("in"/true) so varying
  // `consent2` alone still isolates that one leg. merge.test.ts's own new cases cover the other two legs.
  const merge = (consent2: "in" | "out" | "unknown" = "unknown", consent2Source: "in" | "out" | "unknown" = "in", healthDisclosed = true) =>
    mergeGuestIntoAccount({ vector, audit, hmacKey: "k" }, { tenantId: TENANT, anonId: GUEST, accountId: ACCOUNT, consent2, consent2Source, healthDisclosed });
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

  // CORRECTED (F-8/C9, ADR-0019 Revision 2 task 7): the earlier version of this test asserted a no-op
  // merge wrote NO audit row, on the reasoning that an unconditional audit would spam the immutable log.
  // That is exactly the defect C9 names: a no-op merge is still a CROSS-SUBJECT READ of the guest
  // namespace by/for an account, and an unaudited cross-subject read is unacceptable regardless of
  // whether anything moved. Every call now audits — count reflects what actually moved (0 for a no-op).
  it("every merge call audits, including no-op calls that move nothing — a cross-subject read is never silent (F-8/C9)", async () => {
    const { vector, merge, mergeRows } = fixture();
    await seed(vector, guestNs(), [{ id: "f1", text: "a" }]);
    await merge();
    expect(await mergeRows()).toHaveLength(1);

    await merge();
    await merge();
    expect(await mergeRows(), "a no-op merge is still a cross-subject read and must still be audited").toHaveLength(3);
    const rows = await mergeRows();
    expect(rows.map((r) => (r as { decision?: { count?: number } }).decision?.count)).toEqual([1, 0, 0]);
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

  // CORRECTED (F-8/C9): an empty guest namespace still gets READ (that read is the cross-subject
  // exposure C9 is about), so it is cheap in the sense of "nothing written to the vector store" but it
  // is NOT unaudited — the read itself is recorded, with count 0 and both subject refs.
  it("an empty guest namespace writes nothing to the vector store, but the read IS still audited (count 0)", async () => {
    const { vector, merge, mergeRows } = fixture();
    expect((await merge()).merged).toBe(0);
    expect(await idsIn(vector, acctNs())).toEqual([]);
    const rows = await mergeRows();
    expect(rows, "the empty-namespace read is an unaudited cross-subject read (C9)").toHaveLength(1);
    expect((rows[0] as { decision?: { count?: number } }).decision?.count).toBe(0);
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
