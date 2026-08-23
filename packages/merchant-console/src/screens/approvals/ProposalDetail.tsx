import type { ReactNode } from "react";
import type { Proposal } from "@palup/platform-ports";
import { Badge, Card, CardBody, CardHeader, CardHint, CardTitle, Note } from "@palup/design-system";
import { CATEGORY_LABEL, formatImpact, isIrreversible } from "./format";

// T3 (Proposal detail): the full decision surface for ONE pending proposal — rationale, every
// boundaryReason (why this needed a human at all), the estimated impact, and — most
// load-bearing — the reversal plan. A merchant must see the blast radius (is this reversible? how
// do we undo it if not?) BEFORE they approve, so `reversalPlan` gets its own prominent `Note`
// callout rather than a buried field: `dang` when irreversible (matches the mockup's warning-note
// treatment), `ever` (the "you're covered" reassurance color) when it can be undone. Never
// hidden, never softened for an irreversible action — a safety-critical governance surface.

export interface ProposalDetailProps {
  proposal: Proposal;
  /** Rendered below the reversal-plan callout — Task 4 wires `<ApproveDialog/>` here. Left
   *  optional so this view also renders standalone (e.g. a read-only history entry) without an
   *  action, and so it never needs to know how approving actually works. */
  actions?: ReactNode;
}

export function ProposalDetail({ proposal, actions }: ProposalDetailProps) {
  const irreversible = isIrreversible(proposal);

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{proposal.rationale}</CardTitle>
          <CardHint className="mt-1 block">{formatImpact(proposal)}</CardHint>
        </div>
        <Badge variant="gray">{CATEGORY_LABEL[proposal.category]}</Badge>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <Note variant={irreversible ? "dang" : "ever"}>
          <p className="font-semibold">
            {irreversible ? "Irreversible — read before you approve" : "Reversible"}
          </p>
          <p className="mt-1">{proposal.reversalPlan.plan}</p>
        </Note>

        {proposal.boundaryReasons.length > 0 && (
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[.06em] text-ink-4">Why this needs you</p>
            <ul className="mt-2 flex flex-col gap-2">
              {proposal.boundaryReasons.map((reason, i) => (
                <li key={`${reason.rule}-${i}`} className="text-[13px] text-ink-2">
                  <span className="font-semibold text-ink">{reason.rule}</span> — <span>{reason.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {actions && <div className="pt-2">{actions}</div>}
      </CardBody>
    </Card>
  );
}
