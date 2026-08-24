import { Badge, Card, CardBody, CardHeader, CardTitle, Note } from "@palup/design-system";
import type { HomeSummary } from "../../app/api";
import { fmtUsd } from "./format";

// W2 T7: "Your net position" (mockup #dashboard net card), with the honesty rules D3 demands:
//   • net shown ONLY when both sides are honest (≥1 ledger entry, metered, fully priced);
//   • net-NEGATIVE shown as-is with a fix-it path (spec §10 — hiding it inverts the moat);
//   • otherwise the reason is stated in words, never a fabricated $0 or a blank.
// Deviation from the mockup (D6): no fee line — the performance fee is W6's separately-gated
// boundary; until it exists this card is incremental revenue − model cost, and says so.

export interface NetPositionCardProps {
  summary: HomeSummary;
}

export function NetPositionCard({ summary }: NetPositionCardProps) {
  const { attributed, cost, net } = summary;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your net position</CardTitle>
      </CardHeader>
      <CardBody>
        {net.reason === "ok" && net.value !== null ? (
          <>
            <div className="pb-1 pt-[6px] text-center">
              <div className="text-[12.5px] text-ink-3">Incremental revenue − model cost</div>
              <div
                className={`mt-1 font-mono text-[34px] font-semibold tracking-[-.02em] ${net.value >= 0 ? "text-pos" : "text-dang"}`}
              >
                {fmtUsd(net.value)}
              </div>
              {net.value >= 0 && (
                <Badge variant="pos" className="mt-2">
                  Net positive this period
                </Badge>
              )}
            </div>
            <div className="my-3 border-t border-line-2" />
            <div className="mb-[10px] flex justify-between text-[13px]">
              <span className="text-ink-3">Incremental revenue created</span>
              <b className="font-mono">{fmtUsd(attributed.totalUsd)}</b>
            </div>
            <div className="flex justify-between text-[13px]">
              <span className="text-ink-3">Model cost (measured)</span>
              <b className="font-mono text-coral">{fmtUsd(-cost.totalUsd)}</b>
            </div>
            {net.value < 0 && (
              <Note variant="warn" className="mt-[14px] text-[12px]">
                Your agent currently costs more than the incremental revenue it has proven. This is shown
                honestly, never hidden. To fix it: tighten what runs automatically in Automation Rules, or
                reply to this in the Approval Center — we only want to earn when we create new revenue for you.
              </Note>
            )}
          </>
        ) : (
          <>
            {attributed.entryCount > 0 && (
              <div className="mb-[10px] flex justify-between text-[13px]">
                <span className="text-ink-3">Incremental revenue created</span>
                <b className="font-mono">{fmtUsd(attributed.totalUsd)}</b>
              </div>
            )}
            {net.reason === "attribution_underpowered" && (
              <Note variant="info">
                Still measuring. We only count revenue proven against a holdout — never sales you&apos;d have
                made anyway — and there isn&apos;t enough evidence yet to state a number. No number beats a
                made-up one.
              </Note>
            )}
            {net.reason === "cost_not_metered" && (
              <Note variant="info">
                Model cost isn&apos;t metered for this period yet, so we won&apos;t show a net figure we can&apos;t
                stand behind.
              </Note>
            )}
            {net.reason === "cost_not_fully_priced" && (
              <Note variant="warn">
                Some model costs aren&apos;t priced yet (measured so far: {`≥ ${fmtUsd(cost.totalUsd).replace("−", "")}`},
                a lower bound). Net is withheld rather than guessed.
              </Note>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
