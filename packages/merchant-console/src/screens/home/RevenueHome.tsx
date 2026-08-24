import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Note,
  StatTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@palup/design-system";
import type { ActivityEntry, ApiClient, HomeSummary } from "../../app/api";
import { HandoffCard } from "./HandoffCard";
import { NetPositionCard } from "./NetPositionCard";
import { ActivityToday } from "./ActivityToday";
import { fmtUsd, GOAL_LABELS } from "./format";

// W2 T8: Revenue Home — the retention scoreboard (spec §9 W2), replacing the /dashboard stub.
// Layout matches palup-merchant-app.html #dashboard (handoff card → incremental-honesty note →
// stat-tile row → measurement + net cards → activity); every NUMBER is API-driven with honest
// "still measuring"/"not yet metered" states — the mockup's demo values are deliberately absent
// (governance rule, not style). Deviations D6: no time-series chart (no read model yet — the
// per-play measurement card takes that slot), no per-channel tiles (needs W5 touchpoints), no fee
// line (W6). Read-only: the one write this surface owns (the goal) is set by onboarding's guided
// flow via api.setPrimaryGoal; here the goal renders as a chip.

export interface RevenueHomeProps {
  api: Pick<ApiClient, "getHomeSummary" | "getActivity">;
}

type LoadState = "loading" | "ready" | "error";

export function RevenueHome({ api }: RevenueHomeProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [handoffDismissed, setHandoffDismissed] = useState(false);

  const load = useCallback(() => {
    setState("loading");
    Promise.all([api.getHomeSummary(), api.getActivity()]).then(
      ([s, a]) => {
        setSummary(s);
        setActivity(a.items);
        setState("ready");
      },
      () => setState("error"),
    );
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  if (state === "loading") {
    return (
      <div role="status" className="p-6 text-[13px] text-ink-3">
        Loading Revenue Home…
      </div>
    );
  }

  if (state === "error" || summary === null) {
    return (
      <Note variant="dang">
        <div className="flex items-center gap-3">
          <span>Couldn&apos;t load Revenue Home.</span>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      </Note>
    );
  }

  const attributedValue = summary.attributed.underpowered ? "Still measuring" : fmtUsd(summary.attributed.totalUsd);
  const attributedFootnote = summary.attributed.underpowered
    ? "Proven against a holdout — needs more evidence before we state a number"
    : `${summary.attributed.entryCount} reconciled ledger entries · ${summary.period}`;

  const costValue = !summary.cost.metered
    ? "Not yet metered"
    : summary.cost.fullyPriced
      ? fmtUsd(summary.cost.totalUsd)
      : `≥ ${fmtUsd(summary.cost.totalUsd)}`;
  const costFootnote = !summary.cost.metered
    ? "No model calls recorded this period"
    : summary.cost.fullyPriced
      ? `${summary.cost.events} model calls · ${summary.period}`
      : `Lower bound — some models unpriced (${summary.cost.unpricedModels.join(", ")})`;

  const netValue = summary.net.value === null ? "—" : fmtUsd(summary.net.value);
  const netFootnote =
    summary.net.reason === "ok"
      ? "Incremental revenue − model cost"
      : summary.net.reason === "attribution_underpowered"
        ? "Withheld until attribution has enough evidence"
        : summary.net.reason === "cost_not_metered"
          ? "Withheld — model cost not metered this period"
          : "Withheld — some model costs are unpriced";

  return (
    <div className="flex flex-col gap-4">
      {summary.handoff && !handoffDismissed && (
        <HandoffCard handoff={summary.handoff} onDismiss={() => setHandoffDismissed(true)} />
      )}

      <Note variant="ever">
        <b>This is the value PalUp added that you would not have captured otherwise.</b> We only count{" "}
        <i>incremental</i> revenue your agent created, proven against a holdout — never sales you&apos;d have
        made anyway.
      </Note>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Revenue PalUp brought in" value={attributedValue} mono={!summary.attributed.underpowered} footnote={attributedFootnote} />
        <StatTile label="Model cost" value={costValue} mono={summary.cost.metered} footnote={costFootnote} />
        <StatTile label="Net position" value={netValue} mono={summary.net.value !== null} footnote={netFootnote} />
        <StatTile label="Agent actions (recent)" value={String(activity.length)} footnote="From the audit log — every action, no silent ones" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>What&apos;s being measured</CardTitle>
            {summary.goal ? (
              <Badge variant="ever" dot={false}>{GOAL_LABELS[summary.goal.kind]}</Badge>
            ) : (
              <Badge variant="gray" dot={false}>No primary goal set yet</Badge>
            )}
          </CardHeader>
          <CardBody>
            {summary.attributed.plays.length === 0 ? (
              <Note variant="info">
                No plays are being measured yet. Measurement begins once your agent runs its first play
                against the holdout — the proof behind every number on this page.
              </Note>
            ) : (
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Play</TableHeaderCell>
                    <TableHeaderCell>Incremental lift</TableHeaderCell>
                    <TableHeaderCell>Confidence</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {summary.attributed.plays.map((p) => (
                    <TableRow key={p.play}>
                      <TableCell>{p.play}</TableCell>
                      <TableCell>{p.underpowered ? "—" : fmtUsd(p.incrementalLiftUsd)}</TableCell>
                      <TableCell>{p.underpowered ? "—" : `${Math.round(p.confidence * 100)}%`}</TableCell>
                      <TableCell>
                        {p.underpowered ? <Badge variant="warn">Still measuring</Badge> : <Badge variant="pos">Measured</Badge>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardBody>
        </Card>

        <NetPositionCard summary={summary} />
      </div>

      <ActivityToday items={activity} />
    </div>
  );
}
