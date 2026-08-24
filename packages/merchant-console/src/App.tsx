import { useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Shell } from "./app/shell";
import { makeApiClient } from "./app/api";
import { useSessionToken } from "./app/session";
import { ApprovalCenter } from "./screens/approvals/ApprovalCenter";
import { RevenueHome } from "./screens/home/RevenueHome";
import { LearnedView } from "./screens/learned/LearnedView";
import { RulesEditor } from "./screens/rules/RulesEditor";
import { OrdersView } from "./screens/orders/OrdersView";

// W1-UI Task 1: wires the shell + routing + a REAL (API-backed) pending-approval count. The
// Approval Center screen itself (queue/detail/approve/reject/kill/audit/live-reconcile,
// `ApprovalCenter` — Tasks 2-7) is wired below at `/approvals`; every OTHER nav link remains a
// stub route until its own task lands (plan Task 1, Step 3: "other items are visible-but-stub").

function StubScreen({ title, note }: { title: string; note?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-6 shadow-sm">
      <h1 className="font-display text-lg font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-sm text-ink-3">{note ?? "This screen is not built yet."}</p>
    </div>
  );
}

const STUB_ROUTES: Array<{ path: string; title: string }> = [
  { path: "/inbox", title: "Inbox" },
  { path: "/customers", title: "Customers" },
  { path: "/recovery", title: "Cart Recovery" },
  { path: "/campaigns", title: "Campaigns" },
  { path: "/outreach", title: "Outreach" },
  { path: "/upsell", title: "Upsell" },
  { path: "/payments", title: "Payments & Payouts" },
  { path: "/controls", title: "Agent Controls" },
  { path: "/benchmarks", title: "Benchmarks" },
  { path: "/share", title: "Share Results" },
  { path: "/billing", title: "Billing & Usage" },
  { path: "/plans", title: "Plans" },
  { path: "/widget", title: "Live Chat Widget" },
  { path: "/settings", title: "Settings" },
  { path: "/notifications", title: "Notifications" },
];

export function App() {
  const getToken = useSessionToken();
  const api = useMemo(
    () => makeApiClient({ baseUrl: "/api", getToken, fetch: (...a: Parameters<typeof fetch>) => fetch(...a) }),
    [getToken],
  );

  const [pendingCount, setPendingCount] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    api
      .listApprovals({ status: "pending" })
      .then((res) => {
        if (!cancelled) setPendingCount(res.items.length);
      })
      .catch(() => {
        // best-effort: the pill just keeps its last-known value; the real queue screen (Task 2)
        // surfaces the actual fetch error, this pill is not the source of truth.
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <Shell pendingCount={pendingCount} activePath={location.pathname} onNavigate={navigate}>
      <Routes>
        <Route path="/" element={<Navigate to="/approvals" replace />} />
        <Route path="/approvals" element={<ApprovalCenter api={api} />} />
        <Route path="/dashboard" element={<RevenueHome api={api} />} />
        <Route path="/learned" element={<LearnedView api={api} />} />
        <Route path="/rules" element={<RulesEditor api={api} />} />
        <Route path="/orders" element={<OrdersView api={api} />} />
        {STUB_ROUTES.map((r) => (
          <Route key={r.path} path={r.path} element={<StubScreen title={r.title} />} />
        ))}
        <Route path="*" element={<Navigate to="/approvals" replace />} />
      </Routes>
    </Shell>
  );
}
