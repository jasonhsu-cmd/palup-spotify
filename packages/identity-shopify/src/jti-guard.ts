// Single-use enforcement for the session-token `jti` (ADR-0011 "the exchange is single-use"). A
// validly-signed session token, if captured, must not be exchangeable twice inside its short lifetime.
// In-memory now; a RuntimeStatePort/Postgres adapter (durable, multi-instance) later behind this SAME
// interface. Prunes on write, keyed by exp, so a busy service does not accumulate dead jtis.

export interface JtiReplayGuard {
  useOnce(jti: string, expEpochSec: number): Promise<boolean>;
}

export function createInMemoryJtiGuard(nowSec: () => number = () => Math.floor(Date.now() / 1000)): JtiReplayGuard {
  const seen = new Map<string, number>(); // jti -> exp
  return {
    async useOnce(jti, expEpochSec) {
      const now = nowSec();
      for (const [k, exp] of seen) if (exp <= now) seen.delete(k); // prune expired
      if (!jti) return false;                 // an empty jti is never single-use-safe → refuse
      if (seen.has(jti)) return false;        // replay
      seen.set(jti, expEpochSec);
      return true;
    },
  };
}
