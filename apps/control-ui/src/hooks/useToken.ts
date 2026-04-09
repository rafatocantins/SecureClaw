/**
 * useToken.ts — Browser-side HMAC token generator.
 *
 * Matches auth.plugin.ts generateGatewayToken:
 *   token = {userId}.{role}.{timestamp_ms}.{hmac_sha256_hex(secret, userId:role:timestamp)}
 *
 * The CryptoKey is imported once and cached to avoid repeated importKey calls.
 */
import { useRef, useEffect } from "react";

const USER_ID = "control-ui";

function hexEncode(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface UseTokenResult {
  getToken: () => Promise<string>;
}

export function useToken(secret: string, role: "admin" | "user" = "user"): UseTokenResult {
  const keyRef = useRef<CryptoKey | null>(null);
  const secretRef = useRef<string>("");

  useEffect(() => {
    // Re-import key when secret changes
    if (secret === secretRef.current) return;
    secretRef.current = secret;
    keyRef.current = null;

    if (!secret) return;

    const enc = new TextEncoder();
    void window.crypto.subtle
      .importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
      .then((k) => {
        keyRef.current = k;
      });
  }, [secret]);

  const getToken = async (): Promise<string> => {
    if (!keyRef.current) {
      // Key not yet imported — import inline
      const enc = new TextEncoder();
      keyRef.current = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
    }

    const ts = Date.now().toString();
    const enc = new TextEncoder();
    const payload = `${USER_ID}:${role}:${ts}`;
    const sig = await window.crypto.subtle.sign("HMAC", keyRef.current, enc.encode(payload));
    return `${USER_ID}.${role}.${ts}.${hexEncode(sig)}`;
  };

  return { getToken };
}
