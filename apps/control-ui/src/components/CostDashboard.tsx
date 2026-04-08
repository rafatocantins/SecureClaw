/**
 * CostDashboard.tsx — Team cost showback/chargeback dashboard.
 *
 * Auto-refreshes every 30 s.
 * Shows CSS-only bar chart for team costs.
 * Supports date range presets: today / this week / this month / custom.
 */
import { useState, useEffect, useCallback } from "react";
import { useToken } from "../hooks/useToken.js";

interface TeamCostEntry {
  team_id: string;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  session_count: number;
  cost_by_model: Record<string, number>;
}

interface TeamCostSummary {
  teams: TeamCostEntry[];
  grand_total_usd: number;
}

interface QuotaResponse {
  team_id: string;
  quota_usd: number;
  spent_this_period_usd: number;
  days_until_reset: number;
  at_capacity: boolean;
}

interface CostDashboardProps {
  secret: string;
}

type DatePreset = "today" | "week" | "month" | "custom";

function getPresetRange(preset: DatePreset): { from: number; to: number } {
  const now = Date.now();
  const todayStart = now - (now % 86_400_000);
  switch (preset) {
    case "today":
      return { from: todayStart, to: now };
    case "week":
      return { from: now - 7 * 86_400_000, to: now };
    case "month":
      return { from: now - 30 * 86_400_000, to: now };
    default:
      return { from: now - 30 * 86_400_000, to: now };
  }
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function getQuotaColor(spentPct: number): string {
  if (spentPct >= 0.8) return "#f44336"; // red (warning + exceeded)
  if (spentPct >= 0.5) return "#ff9800"; // amber (caution)
  return "#4caf50"; // green (on budget)
}

function getQuotaLabel(spentPct: number, daysRemaining: number): string {
  const spent = Math.ceil(spentPct * 100);
  const dayWord = daysRemaining === 1 ? "day" : "days";

  if (spentPct >= 1.0) {
    return `EXCEEDED — quota hit`;
  }
  if (spentPct >= 0.8) {
    return `Warning — ${spent}% spent, ${daysRemaining} ${dayWord} left`;
  }
  if (spentPct >= 0.5) {
    return `Caution — ${spent}% spent, ${daysRemaining} ${dayWord} left`;
  }
  return `On budget — ${spent}% spent, ${daysRemaining} ${dayWord} left`;
}

export function CostDashboard({ secret }: CostDashboardProps) {
  const { getToken } = useToken(secret);

  const [summary, setSummary] = useState<TeamCostSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<DatePreset>("month");
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(Date.now() - 30 * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [teamQuotas, setTeamQuotas] = useState<Record<string, QuotaResponse | null>>({});

  const getRange = useCallback((): { from: number; to: number } => {
    if (preset === "custom") {
      return {
        from: new Date(customFrom).getTime(),
        to: new Date(customTo).getTime() + 86_400_000,
      };
    }
    return getPresetRange(preset);
  }, [preset, customFrom, customTo]);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const { from, to } = getRange();
      const res = await fetch(
        `/api/v1/costs/teams?from=${from}&to=${to}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSummary(await res.json() as TeamCostSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [getToken, getRange]);

  const fetchTeamQuota = useCallback(
    async (teamId: string) => {
      try {
        const token = await getToken();
        const res = await fetch(`/api/v1/costs/teams/${teamId}/quota`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const quota = (await res.json()) as QuotaResponse;
        setTeamQuotas((prev) => ({ ...prev, [teamId]: quota }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[quota] fetch failed for team ${teamId}: ${msg}`);
      }
    },
    [getToken]
  );

  // Auto-refresh every 30s
  useEffect(() => {
    void loadSummary();
    const id = setInterval(() => void loadSummary(), 30_000);
    return () => clearInterval(id);
  }, [loadSummary]);

  // Fetch quota for each team when cost summary is loaded
  useEffect(() => {
    if (summary?.teams) {
      summary.teams.forEach((team) => {
        if (!teamQuotas[team.team_id]) {
          void fetchTeamQuota(team.team_id);
        }
      });
    }
  }, [summary, teamQuotas, fetchTeamQuota]);

  const exportCsv = useCallback(async () => {
    try {
      const token = await getToken();
      const { from, to } = getRange();
      const res = await fetch(
        `/api/v1/costs/export?from=${from}&to=${to}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "tessera-costs.csv";
      a.click();
    } catch { /* ignore */ }
  }, [getToken, getRange]);

  const maxCost = Math.max(1, ...(summary?.teams.map((t) => t.total_cost_usd) ?? [1]));

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <div style={s.title}>Cost Showback</div>
          <div style={s.subtitle}>Team-based cost attribution</div>
        </div>
        {summary && (
          <div style={s.grandTotal}>
            Total: <strong>{fmtCost(summary.grand_total_usd)}</strong>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={s.controls}>
        <div style={s.presetBtns}>
          {(["today", "week", "month"] as DatePreset[]).map((p) => (
            <button
              key={p}
              style={preset === p ? s.presetBtnActive : s.presetBtn}
              onClick={() => setPreset(p)}
            >
              {p === "today" ? "Today" : p === "week" ? "This Week" : "This Month"}
            </button>
          ))}
          <button
            style={preset === "custom" ? s.presetBtnActive : s.presetBtn}
            onClick={() => setPreset("custom")}
          >
            Custom
          </button>
        </div>

        {preset === "custom" && (
          <div style={s.customRange}>
            <label style={s.label}>
              From
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                style={s.dateInput}
              />
            </label>
            <label style={s.label}>
              To
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                style={s.dateInput}
              />
            </label>
            <button style={s.btn} onClick={() => void loadSummary()}>Apply</button>
          </div>
        )}

        <button style={s.btnSecondary} onClick={() => void exportCsv()}>
          Export CSV
        </button>
        {loading && <span style={s.loadingLabel}>Refreshing…</span>}
      </div>

      {error && <div style={s.error}>{error}</div>}

      {summary && summary.teams.length === 0 && (
        <div style={s.empty}>No cost data for this period.</div>
      )}

      {summary && summary.teams.length > 0 && (
        <div style={s.teamList}>
          {summary.teams
            .sort((a, b) => b.total_cost_usd - a.total_cost_usd)
            .map((team) => {
              const quota = teamQuotas[team.team_id];
              const spentPct = quota ? quota.spent_this_period_usd / quota.quota_usd : 0;
              const quotaColor = quota ? getQuotaColor(spentPct) : "#4caf50";
              const quotaLabel = quota
                ? getQuotaLabel(spentPct, quota.days_until_reset)
                : null;

              return (
                <div key={team.team_id} style={s.teamRow}>
                  <div style={s.teamName}>{team.team_id}</div>

                  {/* Cost bar with quota overlay */}
                  {quota ? (
                    <div style={s.quotaBarContainer}>
                      <div
                        style={s.quotaBarBackground}
                        aria-label={`Team quota: ${fmtCost(quota.spent_this_period_usd)} of ${fmtCost(quota.quota_usd)} USD, ${quota.at_capacity ? "at capacity" : "below quota"}`}
                      >
                        {/* Filled portion (actual spend) */}
                        <div
                          style={{
                            ...s.quotaBarFilled,
                            width: `${Math.min(spentPct * 100, 100)}%`,
                            background: quotaColor,
                          }}
                        />
                        {/* Diamond marker at quota boundary */}
                        <div
                          style={{
                            ...s.quotaDiamond,
                            left: `${Math.min(spentPct * 100, 100)}%`,
                            borderTopColor: quotaColor,
                            borderBottomColor: quotaColor,
                          }}
                        />
                      </div>
                    </div>
                  ) : (
                    // Fallback: existing cost bar when no quota data
                    <div style={s.barContainer}>
                      <div style={{ ...s.bar, width: `${(team.total_cost_usd / maxCost) * 100}%` }} />
                    </div>
                  )}

                  {/* Stats line */}
                  <div style={s.teamStats}>
                    {quota ? (
                      <span
                        style={s.quotaCostLabel}
                        aria-label={`Quota: ${fmtCost(quota.spent_this_period_usd)} spent of ${fmtCost(quota.quota_usd)}`}
                      >
                        {fmtCost(quota.spent_this_period_usd)} / {fmtCost(quota.quota_usd)}
                      </span>
                    ) : (
                      <span style={s.costLabel}>{fmtCost(team.total_cost_usd)}</span>
                    )}
                    <span style={s.stat}>{fmtTokens(team.input_tokens + team.output_tokens)} tok</span>
                    <span style={s.stat}>{team.session_count} sessions</span>
                  </div>

                  {/* Quota status label */}
                  {quotaLabel && (
                    <div style={s.quotaStatusLabel} aria-live="polite">
                      {quotaLabel}
                    </div>
                  )}

                  {/* Model breakdown */}
                  {Object.keys(team.cost_by_model).length > 0 && (
                    <div style={s.modelBreakdown}>
                      {Object.entries(team.cost_by_model)
                        .sort(([, a], [, b]) => b - a)
                        .map(([model, cost]) => (
                          <span key={model} style={s.modelChip}>
                            {model.split("/").pop() ?? model}: {fmtCost(cost)}
                          </span>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

const s = {
  root: { padding: "20px", maxWidth: "900px" },
  header: {
    display: "flex", alignItems: "flex-start",
    justifyContent: "space-between", marginBottom: "20px",
  },
  title: { fontSize: "18px", fontWeight: 600, color: "#fff" },
  subtitle: { fontSize: "12px", color: "#666", marginTop: "2px" },
  grandTotal: { fontSize: "14px", color: "#aaa" },
  controls: {
    display: "flex", gap: "12px", alignItems: "center",
    marginBottom: "20px", flexWrap: "wrap" as const,
  },
  presetBtns: { display: "flex", gap: "4px" },
  presetBtn: {
    padding: "6px 12px", background: "transparent", border: "1px solid #333",
    borderRadius: "4px", color: "#888", cursor: "pointer", fontSize: "12px",
  },
  presetBtnActive: {
    padding: "6px 12px", background: "#1e2e1e", border: "1px solid #4caf50",
    borderRadius: "4px", color: "#4caf50", cursor: "pointer", fontSize: "12px",
  },
  customRange: { display: "flex", gap: "8px", alignItems: "flex-end" },
  label: {
    display: "flex", flexDirection: "column" as const,
    gap: "4px", fontSize: "11px", color: "#888",
  },
  dateInput: {
    background: "#1e1e1e", border: "1px solid #333", borderRadius: "4px",
    color: "#e0e0e0", padding: "6px 8px", fontSize: "12px",
  },
  btn: {
    padding: "6px 12px", background: "#4caf50", border: "none",
    borderRadius: "4px", color: "#fff", cursor: "pointer", fontSize: "12px",
  },
  btnSecondary: {
    padding: "6px 12px", background: "transparent", border: "1px solid #444",
    borderRadius: "4px", color: "#ccc", cursor: "pointer", fontSize: "12px",
  },
  loadingLabel: { fontSize: "11px", color: "#555" },
  error: {
    color: "#f44336", padding: "10px", background: "#1a0000",
    borderRadius: "4px", marginBottom: "12px", fontSize: "13px",
  },
  empty: { color: "#555", textAlign: "center" as const, padding: "40px 0", fontSize: "14px" },
  teamList: { display: "flex", flexDirection: "column" as const, gap: "12px" },
  teamRow: {
    background: "#141414", border: "1px solid #222",
    borderRadius: "8px", padding: "14px 16px",
  },
  teamName: { fontSize: "14px", fontWeight: 600, color: "#ccc", marginBottom: "8px" },
  barContainer: {
    background: "#1a1a1a", borderRadius: "3px", height: "8px",
    marginBottom: "8px", overflow: "hidden",
  },
  bar: {
    height: "100%", background: "#4caf50",
    borderRadius: "3px", transition: "width 0.3s",
  },
  teamStats: { display: "flex", gap: "16px", alignItems: "center" },
  costLabel: { fontSize: "14px", fontWeight: 700, color: "#4caf50" },
  stat: { fontSize: "11px", color: "#555" },
  quotaBarContainer: {
    marginBottom: "8px",
  },
  quotaBarBackground: {
    position: "relative" as const,
    background: "#1a1a1a",
    borderRadius: "3px",
    height: "8px",
    overflow: "hidden" as const,
  },
  quotaBarFilled: {
    height: "100%",
    borderRadius: "3px",
    transition: "width 0.3s, background-color 0.3s",
  },
  quotaDiamond: {
    position: "absolute" as const,
    top: "50%",
    transform: "translateY(-50%)",
    width: 0,
    height: 0,
    borderLeft: "5px solid transparent",
    borderRight: "5px solid transparent",
    borderTop: "5px solid #4caf50",
    borderBottom: "5px solid #4caf50",
  },
  quotaCostLabel: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#e0e0e0",
  },
  quotaStatusLabel: {
    fontSize: "11px",
    color: "#888",
    marginTop: "4px",
    fontStyle: "italic" as const,
  },
  modelBreakdown: {
    display: "flex", flexWrap: "wrap" as const,
    gap: "6px", marginTop: "8px",
  },
  modelChip: {
    fontSize: "10px", padding: "2px 8px", background: "#1a1a2e",
    borderRadius: "10px", color: "#6688cc", border: "1px solid #2a2a4e",
  },
} as const;
