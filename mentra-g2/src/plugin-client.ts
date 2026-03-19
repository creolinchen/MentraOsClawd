/**
 * HTTP client for communicating with the openclaw-channel-mentra plugin.
 *
 * Manages a sessionKey that identifies the current glasses session.
 * A new key is generated on every call to resetSession() (called when the
 * glasses reconnect) so stale responses from previous sessions are discarded.
 */

import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";

export interface ApprovalDecision {
  id: string;
  decision: "allow-once" | "deny";
  sessionKey: string;
}

export class PluginClient {
  private readonly baseUrl: string;
  private _sessionKey: string;

  constructor(pluginUrl: string) {
    this.baseUrl = pluginUrl.replace(/\/$/, "");
    this._sessionKey = randomUUID();
  }

  get sessionKey(): string {
    return this._sessionKey;
  }

  /** Call when the glasses session starts / reconnects. */
  resetSession(): void {
    this._sessionKey = randomUUID();
  }

  /** Send a user prompt to the plugin. */
  async sendMessage(text: string): Promise<void> {
    await this.post("/mentra/inbound", {
      text,
      sessionKey: this._sessionKey,
    });
  }

  /** Forward an approval decision back to the plugin. */
  async sendApprovalDecision(decision: ApprovalDecision): Promise<void> {
    await this.post("/mentra/approval", decision);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private post(path: string, body: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const url = new URL(this.baseUrl + path);
      const isHttps = url.protocol === "https:";
      const port = url.port
        ? parseInt(url.port, 10)
        : isHttps
        ? 443
        : 80;
      const transport = isHttps ? https : http;

      const req = transport.request(
        {
          hostname: url.hostname,
          port,
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(json),
          },
        },
        (res) => {
          res.resume(); // drain
          res.on("end", resolve);
        }
      );

      req.setTimeout(8_000, () =>
        req.destroy(new Error(`POST ${path} timed out`))
      );
      req.on("error", reject);
      req.write(json);
      req.end();
    });
  }
}
