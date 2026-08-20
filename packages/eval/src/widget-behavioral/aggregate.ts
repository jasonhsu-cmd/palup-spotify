// Task 7 — rolls up per-case outcome rows (built by main.ts from Task 3's CaseOutcome / Task 4's
// MultiOutcome) into a machine-readable Report: totals, per-family and per-severity pass/total,
// coverage (which string-valued signal values were actually exercised), and the list of failing
// cases main.ts prints as findings.

export type Report = {
  total: number;
  passed: number;
  byFamily: Record<string, { total: number; passed: number }>;
  bySeverity: Record<string, { total: number; passed: number }>;
  coverage: Record<string, string[]>; // axis -> values exercised
  failures: { id: string; family: string; severity: string; riskClass: string; failures: string[] }[];
};

type Row = {
  id: string;
  family: string;
  severity: string;
  riskClass: string;
  pass: boolean;
  failures: string[];
  signals?: Record<string, unknown>;
};

export function aggregate(rows: Row[]): Report {
  const bump = (m: Record<string, { total: number; passed: number }>, k: string, pass: boolean) => {
    m[k] ??= { total: 0, passed: 0 };
    m[k]!.total++;
    if (pass) m[k]!.passed++;
  };
  const byFamily: Record<string, { total: number; passed: number }> = {};
  const bySeverity: Record<string, { total: number; passed: number }> = {};
  const coverage: Record<string, Set<string>> = {};
  const failures: Report["failures"] = [];

  for (const r of rows) {
    bump(byFamily, r.family, r.pass);
    bump(bySeverity, r.severity, r.pass);
    for (const [k, v] of Object.entries(r.signals ?? {})) {
      if (typeof v === "string") (coverage[k] ??= new Set()).add(v);
    }
    if (!r.pass) {
      failures.push({ id: r.id, family: r.family, severity: r.severity, riskClass: r.riskClass, failures: r.failures });
    }
  }

  return {
    total: rows.length,
    passed: rows.filter((r) => r.pass).length,
    byFamily,
    bySeverity,
    coverage: Object.fromEntries(Object.entries(coverage).map(([k, s]) => [k, [...s].sort()])),
    failures,
  };
}
