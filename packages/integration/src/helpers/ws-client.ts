/**
 * ws-client.ts — Promise-based WebSocket test client for the gateway chat endpoint.
 *
 * Usage:
 *   const client = new WsTestClient();
 *   await client.connect(sessionId, "ws://127.0.0.1:18789", token);
 *   client.send({ type: "message", content: "hello" });
 *   const pending = await client.waitForType("tool_pending");
 *   const msgs    = await client.collectUntil("complete");
 *   client.close();
 */
import WebSocket from "ws";

export interface ServerMsg {
  type: string;
  [key: string]: unknown;
}

export class WsTestClient {
  private ws!: WebSocket;
  private received: ServerMsg[] = [];
  private waiters: Array<{
    type: string;
    resolve: (msg: ServerMsg) => void;
    reject: (err: Error) => void;
  }> = [];

  async connect(
    sessionId: string,
    gatewayUrl: string,
    token: string
  ): Promise<void> {
    const wsUrl = gatewayUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${wsUrl}/api/v1/chat/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
      this.ws.on("message", (data) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(String(data)) as ServerMsg;
        } catch {
          return;
        }
        this.received.push(msg);
        // Notify any waiters whose type matches
        const idx = this.waiters.findIndex((w) => w.type === msg.type);
        if (idx !== -1) {
          const waiter = this.waiters.splice(idx, 1)[0];
          if (waiter) waiter.resolve(msg);
        }
      });
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Return first already-received message of the given type, or wait for one. */
  waitForType(type: string, timeoutMs = 30_000): Promise<ServerMsg> {
    const existing = this.received.find((m) => m.type === type);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for WS message type "${type}" after ${timeoutMs}ms`));
      }, timeoutMs);

      this.waiters.push({
        type,
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  /** Collect all messages up to and including the first message of endType. */
  async collectUntil(endType: string, timeoutMs = 60_000): Promise<ServerMsg[]> {
    await this.waitForType(endType, timeoutMs);
    // Return a snapshot of everything received so far
    return [...this.received];
  }

  /** All messages received so far. */
  all(): ServerMsg[] {
    return [...this.received];
  }

  close(): void {
    this.ws?.close();
  }
}
