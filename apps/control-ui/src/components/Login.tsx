/**
 * Login.tsx — HMAC secret entry screen.
 *
 * The user pastes their GATEWAY_HMAC_SECRET here. The secret is stored only
 * in React state (never localStorage / sessionStorage). On submit we verify
 * it works by generating a fresh token and hitting GET /health.
 */
import { useState, type FormEvent } from "react";
import { useToken } from "../hooks/useToken.js";

interface LoginProps {
  onLogin: (secret: string, role: "admin" | "user") => void;
}

export function Login({ onLogin }: LoginProps) {
  const [secret, setSecret] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { getToken } = useToken(secret, role);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!secret.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const token = await getToken();
      const res = await fetch("/health", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError(`Gateway returned ${res.status} — check the secret.`);
        return;
      }
      onLogin(secret.trim(), role);
    } catch {
      setError("Cannot reach the gateway. Is it running on port 18789?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.overlay}>
      <form style={s.card} onSubmit={(e) => void handleSubmit(e)}>
        <h1 style={s.title}>Tessera</h1>
        <p style={s.subtitle}>Control UI — enter your gateway secret to continue</p>

        <label style={s.label} htmlFor="secret">
          GATEWAY_HMAC_SECRET
        </label>
        <input
          id="secret"
          style={s.input}
          type="password"
          autoComplete="off"
          autoFocus
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value);
            setError(null);
          }}
          placeholder="Paste secret here…"
          disabled={loading}
        />

        <div style={s.roleRow}>
          <span style={s.label}>Role</span>
          <div style={s.roleToggle}>
            <button
              type="button"
              style={{ ...s.roleBtn, ...(role === "user" ? s.roleBtnActive : {}) }}
              onClick={() => setRole("user")}
              disabled={loading}
            >
              user
            </button>
            <button
              type="button"
              style={{ ...s.roleBtn, ...(role === "admin" ? s.roleBtnActiveAdmin : {}) }}
              onClick={() => setRole("admin")}
              disabled={loading}
            >
              admin
            </button>
          </div>
        </div>

        {error && <p style={s.error}>{error}</p>}

        <button style={{ ...s.btn, ...(loading ? s.btnDisabled : {}) }} type="submit" disabled={loading}>
          {loading ? "Verifying…" : "Connect"}
        </button>
      </form>
    </div>
  );
}

const s = {
  overlay: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    background: "#0f0f0f",
  },
  card: {
    background: "#1a1a1a",
    border: "1px solid #333",
    borderRadius: "10px",
    padding: "32px 36px",
    width: "340px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "12px",
  },
  title: {
    fontSize: "22px",
    fontWeight: 700,
    color: "#fff",
    margin: 0,
    textAlign: "center" as const,
  },
  subtitle: {
    fontSize: "12px",
    color: "#888",
    margin: "0 0 4px",
    textAlign: "center" as const,
  },
  label: {
    fontSize: "11px",
    color: "#aaa",
    letterSpacing: "0.05em",
    fontFamily: "monospace",
  },
  input: {
    background: "#111",
    border: "1px solid #444",
    borderRadius: "6px",
    color: "#e0e0e0",
    fontSize: "14px",
    padding: "9px 12px",
    outline: "none",
    fontFamily: "monospace",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  error: {
    fontSize: "12px",
    color: "#f44",
    margin: 0,
    background: "#2a1111",
    border: "1px solid #5a2222",
    borderRadius: "4px",
    padding: "6px 10px",
  },
  btn: {
    background: "#2a5a2a",
    border: "1px solid #4a8a4a",
    borderRadius: "6px",
    color: "#cfc",
    fontSize: "14px",
    padding: "10px",
    cursor: "pointer",
    fontWeight: 600,
    marginTop: "4px",
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: "not-allowed" as const,
  },
  roleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  roleToggle: {
    display: "flex",
    gap: "4px",
  },
  roleBtn: {
    background: "#111",
    border: "1px solid #444",
    borderRadius: "4px",
    color: "#888",
    fontSize: "11px",
    padding: "4px 12px",
    cursor: "pointer",
    fontFamily: "monospace",
  },
  roleBtnActive: {
    background: "#1a2a1a",
    border: "1px solid #4a8a4a",
    color: "#cfc",
  },
  roleBtnActiveAdmin: {
    background: "#2a1a1a",
    border: "1px solid #8a4a4a",
    color: "#fcc",
  },
} as const;
