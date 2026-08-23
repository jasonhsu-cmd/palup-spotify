import { useMemo, type ReactNode } from "react";
import { AppShell, type NavGroupItem } from "@palup/design-system";

// The merchant console's app shell (W1-UI Task 1) — F1's `AppShell`/`Sidebar` (dark `ink` panel,
// 264px, off-canvas drawer < 900px — verified in @palup/design-system/test/app-shell.test.tsx),
// carrying the FULL nav structure from the visual source of truth (`palup-merchant-app.html`'s
// `<nav class="nav">`, lines 270-311): same groups, same labels, same order.
//
// Two deliberate honesty-driven differences from the mockup, both because Task 1 has no real data
// source for them yet (this is the scaffold; the API only wires the Approval Center):
//   1. The mockup hardcodes demo pill counts on Inbox (5) / Cart Recovery (12) / Upsell (8) and a
//      demo store-picker ("Auria"). Those numbers aren't real yet, so we don't render them —
//      showing a fabricated count would misrepresent real state, which the design-system skill's
//      governance-surface rule ("never fake or hide state") is stricter about but the same
//      principle applies generally. Approval Center's pill IS real: it's `pendingCount`, wired to
//      `GET /approvals?status=pending` by App.tsx.
//   2. Nav icons (mockup's inline SVGs) are omitted for this scaffold — `NavLinkItem.icon` is
//      optional and can be filled in without touching this structure once an icon set is chosen.

export interface ShellProps {
  /** The real pending-approval count (`GET /approvals?status=pending`.items.length), shown as the
   *  Approval Center nav pill. `0` renders no pill at all — never a fake/misleading "0" badge. */
  pendingCount: number;
  children: ReactNode;
  /** The current route path (e.g. from react-router's `useLocation().pathname`), used to mark the
   *  matching nav link `aria-current="page"`. Omitted in isolated tests. */
  activePath?: string;
  /** Called with a link's `href` instead of letting the browser navigate — App.tsx wires this to
   *  react-router's `navigate`. Omitted, links behave as plain anchors (still works, just a full
   *  page load) — `AppShell`'s own contract. */
  onNavigate?: (path: string) => void;
}

function navGroups(pendingCount: number, activePath: string | undefined): NavGroupItem[] {
  const link = (href: string, label: string, pillCount?: number) => ({
    href,
    label,
    active: activePath === href,
    ...(typeof pillCount === "number" && pillCount > 0 ? { pillCount } : {}),
  });

  return [
    {
      title: "",
      links: [link("/dashboard", "Revenue Home"), link("/learned", "Agent Memory")],
    },
    {
      title: "Conversations",
      links: [link("/inbox", "Inbox"), link("/customers", "Customers")],
    },
    {
      title: "Growth",
      links: [
        link("/recovery", "Cart Recovery"),
        link("/campaigns", "Campaigns"),
        link("/outreach", "Outreach"),
        link("/upsell", "Upsell"),
      ],
    },
    {
      title: "Sales",
      links: [link("/orders", "Orders"), link("/payments", "Payments & Payouts")],
    },
    {
      title: "Approvals & Control",
      links: [
        link("/approvals", "Approval Center", pendingCount),
        link("/rules", "Automation Rules"),
        link("/controls", "Agent Controls"),
      ],
    },
    {
      title: "Insights",
      links: [link("/benchmarks", "Benchmarks"), link("/share", "Share Results")],
    },
    {
      title: "Account",
      links: [
        link("/billing", "Billing & Usage"),
        link("/plans", "Plans"),
        link("/widget", "Live Chat Widget"),
        link("/settings", "Settings"),
        link("/notifications", "Notifications"),
      ],
    },
  ];
}

function Brand() {
  return (
    <div className="flex items-center gap-[11px]">
      <span className="grid h-[34px] w-[34px] place-items-center rounded-lg bg-ever font-display text-[17px] font-extrabold text-surface">
        P
      </span>
      <span className="font-display text-[17px] font-extrabold tracking-tight text-surface">
        PalUp<span className="text-pos">.ai</span>
      </span>
    </div>
  );
}

export function Shell({ pendingCount, children, activePath, onNavigate }: ShellProps) {
  const groups = useMemo(() => navGroups(pendingCount, activePath), [pendingCount, activePath]);
  return (
    <AppShell groups={groups} brand={<Brand />} onNavigate={onNavigate}>
      {children}
    </AppShell>
  );
}
