import * as React from "react";
import { cn } from "../lib/cn";

export interface NavLinkItem {
  href: string;
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  pillCount?: number;
}

export interface NavGroupItem {
  title: string;
  links: NavLinkItem[];
}

export interface SidebarProps {
  groups: NavGroupItem[];
  brand?: React.ReactNode;
  open?: boolean;
  onNavigate?: (href: string) => void;
}

export function Sidebar({ groups, brand, open = false, onNavigate }: SidebarProps) {
  return (
    <aside
      id="palup-sidebar"
      data-open={open}
      className={cn(
        // The mockup's .sidebar hand-writes #D7DED9 for its base text — an on-dark tint with
        // no equivalent in tokens.css (ink-2/3/4 are calibrated for light surfaces). Rather than
        // invent a new hex, this expresses it as the `surface` token (#FFFFFF, i.e. mockup's
        // white) at reduced opacity over the `bg-ink` panel, the same "opacity modifier on an
        // existing token" pattern already used for the scrim (dialog.tsx, `bg-ink/40`).
        "sticky top-0 flex h-screen w-[264px] flex-col overflow-y-auto bg-ink text-surface/85",
        "max-[899px]:fixed max-[899px]:left-0 max-[899px]:top-0 max-[899px]:z-40 max-[899px]:w-[280px]",
        "max-[899px]:-translate-x-full max-[899px]:transition-transform",
        open && "max-[899px]:translate-x-0"
      )}
    >
      {brand && <div className="px-4 py-5">{brand}</div>}
      <nav aria-label="Primary" className="flex-1 px-3 pb-[18px] pt-1">
        {groups.map((group) => (
          <div key={group.title} className="mt-4">
            {/* mockup: #67756C group-title tint -> surface/40 over bg-ink, same rationale as above. */}
            <div className="px-3 pb-[5px] pt-[6px] text-[10.5px] font-bold uppercase tracking-[.09em] text-surface/40">
              {group.title}
            </div>
            {group.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                aria-current={link.active ? "page" : undefined}
                onClick={(event) => {
                  if (onNavigate) {
                    event.preventDefault();
                    onNavigate(link.href);
                  }
                }}
                className={cn(
                  // mockup: #C2CBC5 link text / #1E2A24 hover+active bg -> surface/75 text,
                  // surface/5 hover+active bg over bg-ink (same token-opacity rationale as above).
                  "relative flex items-center gap-[11px] rounded-[9px] px-3 py-2 text-[13.5px] font-medium text-surface/75 transition-colors hover:bg-surface/5 hover:text-surface",
                  link.active && "bg-surface/5 text-surface"
                )}
              >
                {link.icon}
                <span>{link.label}</span>
                {typeof link.pillCount === "number" && link.pillCount > 0 && (
                  <span className="ml-auto rounded-full bg-coral px-[7px] py-[1px] font-mono text-[10px] font-bold text-white">
                    {link.pillCount}
                  </span>
                )}
              </a>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

export interface AppShellProps {
  groups: NavGroupItem[];
  brand?: React.ReactNode;
  children: React.ReactNode;
  onNavigate?: (href: string) => void;
}

export function AppShell({ groups, brand, children, onNavigate }: AppShellProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <div className="min-h-screen bg-paper md:grid md:grid-cols-[264px_1fr]">
      <Sidebar
        groups={groups}
        brand={brand}
        open={mobileOpen}
        onNavigate={(href) => {
          setMobileOpen(false);
          onNavigate?.(href);
        }}
      />
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-ink/40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="flex flex-col">
        <button
          type="button"
          className="m-3 inline-flex items-center gap-2 self-start rounded border border-line bg-surface px-3 py-2 text-[13px] font-semibold text-ink md:hidden"
          onClick={() => setMobileOpen((v) => !v)}
          aria-expanded={mobileOpen}
          aria-controls="palup-sidebar"
        >
          Menu
        </button>
        <main className="flex-1 p-5">{children}</main>
      </div>
    </div>
  );
}
