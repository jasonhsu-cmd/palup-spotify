import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Note,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@palup/design-system";
import type { ApiClient, LearnedCategory, LearnedInsight } from "../../app/api";
import { TeachPanel } from "./TeachPanel";

// W3 Task 8 — the console's Learned (Agent Memory) screen (spec §10), replacing the `/learned`
// stub. Matches palup-merchant-app.html #learned's layout (header + Export → tabs/table → side
// "Teach your agent" panel) but renders ONLY real API data: the mockup's top stat row (312 facts
// learned / 64 products understood / 20 segments / 96% brand-voice match) and its "Memory health"
// percentage bars are FABRICATED demo numbers with no backing field on `listLearned`'s response —
// this screen omits both rather than inventing a number (CLAUDE.md governance rule, not a style
// choice: "NEVER fabricate numbers/insights").
//
// Two-tier framing (spec §10): this screen is the PRIVATE layer only — the AGGREGATE
// (cross-merchant) layer is OFF (`AGGREGATE_LEARNING_ADR_ACCEPTED = false`, zero live callers,
// task-8-brief.md's deferred-gates section) and stays a honest "coming soon" note here, never a
// second tab with invented aggregate rows.

export interface LearnedViewProps {
  api: Pick<ApiClient, "listLearned" | "teachLearned" | "pinLearned" | "deleteLearned" | "exportLearned">;
}

type LoadState = "loading" | "ready" | "error";
type TabValue = "all" | LearnedCategory;

const TABS: Array<{ value: TabValue; label: string }> = [
  { value: "all", label: "All" },
  { value: "customers", label: "Customers" },
  { value: "products", label: "Products" },
  { value: "voice", label: "Voice" },
  { value: "policies", label: "Policies" },
];

function confidenceBadge(insight: LearnedInsight) {
  if (insight.pinned) {
    return <Badge variant="ever">Pinned</Badge>;
  }
  return (
    <Badge variant={insight.confidence === "high" ? "pos" : "warn"}>
      {insight.confidence === "high" ? "High" : "Medium"}
    </Badge>
  );
}

export function LearnedView({ api }: LearnedViewProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<LearnedInsight[]>([]);
  const [tab, setTab] = useState<TabValue>("all");
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(() => {
    setState("loading");
    api.listLearned({}).then(
      (res) => {
        setItems(res.items);
        setState("ready");
      },
      () => setState("error"),
    );
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const handlePin = useCallback(
    (insight: LearnedInsight) => {
      setActionError(null);
      api.pinLearned(insight.id, !insight.pinned).then(load, () => {
        setActionError(
          `Couldn't ${insight.pinned ? "unpin" : "pin"} "${insight.text}" — try again.`,
        );
      });
    },
    [api, load],
  );

  // Delete is a permanent, destructive act on merchant-owned data — matches the console's other
  // destructive actions (Kill Switch halt, Reject) in requiring an explicit confirm step before
  // the API is ever called. This is an inline row-level confirm (no new Dialog dependency) since
  // it's a single low-stakes toggle, not a governance-boundary action.
  const handleDeleteClick = useCallback((id: string) => {
    setActionError(null);
    setConfirmDeleteId(id);
  }, []);

  const handleDeleteCancel = useCallback(() => {
    setConfirmDeleteId(null);
  }, []);

  const handleDeleteConfirm = useCallback(
    (insight: LearnedInsight) => {
      api.deleteLearned(insight.id).then(
        () => {
          setConfirmDeleteId(null);
          load();
        },
        () => {
          setConfirmDeleteId(null);
          setActionError(`Couldn't delete "${insight.text}" — try again.`);
        },
      );
    },
    [api, load],
  );

  const handleExport = useCallback(() => {
    setExporting(true);
    setExportError(null);
    setExportNote(null);
    api.exportLearned().then(
      (res) => {
        setExporting(false);
        setExportNote(
          `Export ready — ${res.insights.length} insight${res.insights.length === 1 ? "" : "s"} as of ${new Date(res.exportedAt).toLocaleString()}. ${res.portabilityNote}`,
        );
      },
      () => {
        setExporting(false);
        setExportError("Couldn't export your agent's brain right now — try again.");
      },
    );
  }, [api]);

  if (state === "loading") {
    return (
      <div role="status" className="p-6 text-[13px] text-ink-3">
        Loading Agent Memory…
      </div>
    );
  }

  if (state === "error") {
    return (
      <Note variant="dang">
        <div className="flex items-center gap-3">
          <span>Couldn&apos;t load Agent Memory.</span>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      </Note>
    );
  }

  const filtered = tab === "all" ? items : items.filter((i) => i.category === tab);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-lg font-semibold text-ink">Agent Memory</h1>
          <p className="mt-1 text-[13px] text-ink-3">
            Everything your AI Sales Partner has learned about your store and its customers. This is a
            compounding asset that belongs to you.
          </p>
        </div>
        <Button variant="outline" onClick={handleExport} disabled={exporting}>
          {exporting ? "Exporting…" : "Export memory"}
        </Button>
      </div>

      {exportNote && <Note variant="ever">{exportNote}</Note>}
      {exportError && <Note variant="dang">{exportError}</Note>}

      <Note variant="info">
        Network insights (aggregate): coming soon — pending legal/security review. Insights learned across
        the PalUp merchant network are not enabled yet; everything below is learned from your store alone.
      </Note>

      {actionError && (
        <Note variant="dang">
          <div className="flex items-center justify-between gap-3">
            <span>{actionError}</span>
            <Button variant="ghost" size="sm" onClick={() => setActionError(null)}>
              Dismiss
            </Button>
          </div>
        </Note>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
            <CardHeader>
              <CardTitle>What it has learned</CardTitle>
              <TabsList>
                {TABS.map((t) => (
                  <TabsTrigger key={t.value} value={t.value}>
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </CardHeader>
            <CardBody>
              <TabsContent value={tab}>
                {filtered.length === 0 ? (
                  <Note variant="info">
                    Nothing learned yet in this category — still measuring. Insights appear here once your
                    agent has enough real signal, or you teach it one directly.
                  </Note>
                ) : (
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableHeaderCell>Insight</TableHeaderCell>
                        <TableHeaderCell>Source</TableHeaderCell>
                        <TableHeaderCell>Confidence</TableHeaderCell>
                        <TableHeaderCell>Learned</TableHeaderCell>
                        <TableHeaderCell>Actions</TableHeaderCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {filtered.map((insight) => (
                        <TableRow key={insight.id}>
                          <TableCell>
                            <b className="text-ink">{insight.text}</b>
                          </TableCell>
                          <TableCell>{insight.source}</TableCell>
                          <TableCell>{confidenceBadge(insight)}</TableCell>
                          <TableCell className="text-ink-3">
                            {new Date(insight.updatedAt).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Button variant="ghost" size="sm" onClick={() => handlePin(insight)}>
                                {insight.pinned ? "Unpin" : "Pin"}
                              </Button>
                              {confirmDeleteId === insight.id ? (
                                <>
                                  <span className="text-[12.5px] text-ink-3">Delete?</span>
                                  <Button
                                    variant="danger"
                                    size="sm"
                                    onClick={() => handleDeleteConfirm(insight)}
                                  >
                                    Confirm
                                  </Button>
                                  <Button variant="ghost" size="sm" onClick={handleDeleteCancel}>
                                    Cancel
                                  </Button>
                                </>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleDeleteClick(insight.id)}
                                >
                                  Delete
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>
            </CardBody>
          </Tabs>
        </Card>

        <TeachPanel api={api} onTaught={load} />
      </div>
    </div>
  );
}
