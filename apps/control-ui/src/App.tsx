/**
 * App.tsx — Tessera Control UI root.
 *
 * State machine:
 *  - secret === null → <Login> screen
 *  - secret !== null → three-tab dashboard (Approvals, Sessions, Audit Log)
 *
 * The HMAC secret lives only in React state; never localStorage/sessionStorage.
 */
import { useState, useEffect, useRef } from "react";
import { Login } from "./components/Login.js";
import { useToken } from "./hooks/useToken.js";
import { ApprovalQueue } from "./components/ApprovalQueue.js";
import { SessionList } from "./components/SessionList.js";
import { AuditLog } from "./components/AuditLog.js";
import { CredentialVault } from "./components/CredentialVault.js";
import { ComplianceDashboard } from "./components/ComplianceDashboard.js";
import { CostDashboard } from "./components/CostDashboard.js";
import { Marketplace } from "./components/Marketplace.js";
import { Chat } from "./components/Chat.js";

type Tab = "chat" | "approvals" | "sessions" | "audit" | "credentials" | "compliance" | "costs" | "marketplace";

export function App() {
  const [secret, setSecret] = useState<string | null>(null);
  const [role, setRole] = useState<"admin" | "user">("user");
  const [tab, setTab] = useState<Tab>("chat");
  const [pendingCount, setPendingCount] = useState(0);
  const [sessionStatus, setSessionStatus] = useState<"active" | "checking" | "expired">("active");
  const [expirySeconds, setExpirySeconds] = useState(300);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // useToken is always called (no conditional hooks), but only does work when secret is non-empty
  const { getToken } = useToken(secret ?? "", role);

  // Fetch token config and start heartbeat when user logs in
  useEffect(() => {
    if (!secret) {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
      setSessionStatus("active");
      return;
    }

    // Fetch the configured expiry window
    void fetch("/api/v1/token/config")
      .then((r) => r.json())
      .then((data: unknown) => {
        const d = data as { expiry_seconds?: number };
        if (d.expiry_seconds && d.expiry_seconds > 0) setExpirySeconds(d.expiry_seconds);
      })
      .catch(() => { /* non-fatal — fall back to default 300s */ });

    // Heartbeat: generate a fresh token and ping /health at (expiry - 60)s intervals.
    // If /health fails, the secret is no longer valid → force re-login.
    const intervalMs = Math.max((expirySeconds - 60) * 1000, 30_000);
    heartbeatRef.current = setInterval(() => {
      setSessionStatus("checking");
      void getToken()
        .then((token) =>
          fetch("/health", { headers: { Authorization: `Bearer ${token}` } })
        )
        .then((r) => {
          setSessionStatus(r.ok ? "active" : "expired");
          if (!r.ok) {
            if (heartbeatRef.current) clearInterval(heartbeatRef.current);
            setSecret(null);
          }
        })
        .catch(() => {
          setSessionStatus("expired");
          if (heartbeatRef.current) clearInterval(heartbeatRef.current);
          setSecret(null);
        });
    }, intervalMs);

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret, expirySeconds]);

  if (!secret) {
    return <Login onLogin={(s, r) => { setSecret(s); setRole(r); }} />;
  }

  return (
    <div style={s.root}>
      {/* Top bar */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.brand}>Tessera</span>
          <span style={s.brandSub}>Control UI</span>
        </div>

        <nav style={s.nav}>
          <TabBtn active={tab === "chat"} onClick={() => setTab("chat")}>
            Chat
          </TabBtn>
          <TabBtn
            active={tab === "approvals"}
            onClick={() => setTab("approvals")}
            badge={pendingCount > 0 ? pendingCount : undefined}
          >
            Approvals
          </TabBtn>
          <TabBtn active={tab === "sessions"} onClick={() => setTab("sessions")}>
            Sessions
          </TabBtn>
          <TabBtn active={tab === "audit"} onClick={() => setTab("audit")}>
            Audit Log
          </TabBtn>
          <TabBtn active={tab === "credentials"} onClick={() => setTab("credentials")}>
            Credentials
          </TabBtn>
          <TabBtn active={tab === "compliance"} onClick={() => setTab("compliance")}>
            Compliance
          </TabBtn>
          <TabBtn active={tab === "costs"} onClick={() => setTab("costs")}>
            Costs
          </TabBtn>
          <TabBtn active={tab === "marketplace"} onClick={() => setTab("marketplace")}>
            Marketplace
          </TabBtn>
        </nav>

        <div style={s.headerRight}>
          <SessionDot status={sessionStatus} expirySeconds={expirySeconds} />
          <span style={s.userLabel}>control-ui</span>
          <span style={{ ...s.roleBadge, ...(role === "admin" ? s.roleBadgeAdmin : {}) }}>
            {role}
          </span>
          <button
            style={s.logoutBtn}
            onClick={() => {
              setSecret(null);
              setRole("user");
              setPendingCount(0);
            }}
          >
            Logout
          </button>
        </div>
      </header>

      {/* Content */}
      <main style={s.main}>
        {tab === "chat" && <Chat secret={secret} />}
        {tab === "approvals" && (
          <ApprovalQueue
            secret={secret}
            onCountChange={setPendingCount}
          />
        )}
        {tab === "sessions" && <SessionList secret={secret} />}
        {tab === "audit" && <AuditLog secret={secret} />}
        {tab === "credentials" && <CredentialVault secret={secret} />}
        {tab === "compliance" && <ComplianceDashboard secret={secret} />}
        {tab === "costs" && <CostDashboard secret={secret} />}
        {tab === "marketplace" && <Marketplace secret={secret} />}
      </main>
    </div>
  );
}

interface SessionDotProps {
  status: "active" | "checking" | "expired";
  expirySeconds: number;
}

function SessionDot({ status, expirySeconds }: SessionDotProps) {
  const color = status === "active" ? "#4caf50" : status === "checking" ? "#ff9800" : "#f44";
  const label =
    status === "active"
      ? `Session active — tokens valid for ${expirySeconds}s`
      : status === "checking"
      ? "Verifying session…"
      : "Session expired";
  return (
    <span
      title={label}
      style={{
        width: "8px", height: "8px", borderRadius: "50%",
        background: color, display: "inline-block", flexShrink: 0,
      }}
    />
  );
}

interface TabBtnProps {
  active: boolean;
  onClick: () => void;
  badge?: number;
  children: React.ReactNode;
}

function TabBtn({ active, onClick, badge, children }: TabBtnProps) {
  return (
    <button
      style={{ ...s.tabBtn, ...(active ? s.tabBtnActive : {}) }}
      onClick={onClick}
    >
      {children}
      {badge !== undefined && (
        <span style={s.badge}>{badge > 99 ? "99+" : badge}</span>
      )}
    </button>
  );
}

const s = {
  root: {
    fontFamily: "system-ui, -apple-system, sans-serif",
    background: "#0f0f0f",
    color: "#e0e0e0",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    padding: "0 20px",
    background: "#141414",
    borderBottom: "1px solid #2a2a2a",
    display: "flex",
    alignItems: "center",
    gap: "20px",
    height: "48px",
    flexShrink: 0,
  },
  headerLeft: { display: "flex", alignItems: "baseline", gap: "8px" },
  brand: { fontSize: "16px", fontWeight: 700, color: "#fff" },
  brandSub: { fontSize: "11px", color: "#666" },
  nav: { display: "flex", gap: "2px", flex: 1, flexWrap: "nowrap" as const, overflowX: "auto" as const },
  headerRight: { display: "flex", alignItems: "center", gap: "12px" },
  userLabel: { fontSize: "12px", color: "#555", fontFamily: "monospace" },
  roleBadge: {
    fontSize: "10px",
    fontFamily: "monospace",
    padding: "2px 6px",
    borderRadius: "3px",
    background: "#1a1a2a",
    border: "1px solid #444",
    color: "#888",
  },
  roleBadgeAdmin: {
    background: "#2a1a1a",
    border: "1px solid #8a4a4a",
    color: "#fcc",
  },
  logoutBtn: {
    fontSize: "11px", padding: "4px 10px", cursor: "pointer",
    background: "transparent", border: "1px solid #333", borderRadius: "4px",
    color: "#888",
  },
  tabBtn: {
    background: "transparent", border: "none", cursor: "pointer",
    color: "#888", fontSize: "12px", padding: "0 9px",
    height: "48px", borderBottom: "2px solid transparent",
    display: "flex", alignItems: "center", gap: "6px",
    transition: "color 0.1s", whiteSpace: "nowrap" as const,
  },
  tabBtnActive: {
    color: "#fff",
    borderBottom: "2px solid #4caf50",
  },
  badge: {
    fontSize: "10px", fontWeight: 700,
    background: "#c0392b", color: "#fff",
    borderRadius: "10px", padding: "1px 5px",
    lineHeight: "1.4",
  },
  main: { flex: 1, overflowY: "auto" as const },
} as const;
