/**
 * http.ts — Minimal fetch helpers for CLI→gateway communication.
 */

export interface ApiError {
  status: number;
  body: unknown;
}

export async function apiGet(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body: unknown = await res.json();
  if (!res.ok) throw { status: res.status, body } satisfies ApiError;
  return body;
}

export async function apiPost(url: string, token: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body: unknown = await res.json();
  if (!res.ok) throw { status: res.status, body } satisfies ApiError;
  return { status: res.status, body };
}

export async function apiDelete(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body: unknown = await res.json();
  if (!res.ok) throw { status: res.status, body } satisfies ApiError;
  return body;
}

export async function apiGetBinary(url: string, token: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    throw { status: res.status, body } satisfies ApiError;
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export async function apiPostBinary(url: string, token: string, data: Buffer): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: data,
  });
  const body: unknown = await res.json();
  if (!res.ok && res.status !== 207) throw { status: res.status, body } satisfies ApiError;
  return { status: res.status, body };
}

export function printApiError(err: unknown): void {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as ApiError;
    process.stderr.write(`error: HTTP ${e.status} — ${JSON.stringify(e.body)}\n`);
  } else {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
