/**
 * Mentra channel implementation.
 *
 * Inbound flow (POST /mentra/inbound → agent):
 *   resolveAgentRoute → finalizeInboundContext → recordInboundSession
 *   → dispatchReplyWithBufferedBlockDispatcher (deliver callback POSTs to callbackUrl)
 *
 * Outbound flow (OpenClaw-initiated, e.g. /send):
 *   outbound.sendText → POST to callbackUrl
 *
 * Config keys (set via `openclaw config set`):
 *   channels.mentra.port        — HTTP server port (default 4747)
 *   channels.mentra.callbackUrl — where to POST responses (default http://localhost:3000/response)
 */

import http from "node:http";
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { getRuntime } from "./runtime.js";
import type { InboundMessage, CallbackPayload } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const CHANNEL_ID = "mentra";
const DEFAULT_PORT = 4747;
const DEFAULT_CALLBACK_URL = "http://localhost:3000/response";

// ── Channel plugin ────────────────────────────────────────────────────────────

export const mentraChannel: ChannelPlugin = {
  id: CHANNEL_ID,

  meta: {
    id: CHANNEL_ID,
    label: "MentraOS Smart Glasses",
    selectionLabel: "MentraOS G2",
    docsPath: "/channels/mentra",
    blurb: "Voice input from G2 Smart Glasses, text output on G2 display",
  },

  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },

  reload: { configPrefixes: ["channels.mentra"] },

  // ── Config adapter (single always-active "default" account) ──────────────

  config: {
    listAccountIds: (_cfg) => ["default"],
    resolveAccount: (_cfg, _accountId) => ({
      accountId: "default",
      configured: true,
    }),
    isConfigured: () => true,
    describeAccount: () => ({
      accountId: "default",
      name: "Mentra (localhost)",
      enabled: true,
      configured: true,
    }),
  },

  // ── Outbound adapter (OpenClaw-initiated messages / /send) ───────────────

  outbound: {
    deliveryMode: "direct",
    sendText: async ({ cfg: _cfg, to, text, log }) => {
      const callbackUrl = resolveCallbackUrl();
      log?.debug?.(`[mentra] outbound.sendText → ${callbackUrl}`);
      await postCallback(callbackUrl, { text: text ?? "", sessionKey: to });
      return {
        channel: CHANNEL_ID,
        messageId: `mentra-${Date.now()}`,
      };
    },
  },

  // ── Gateway adapter (starts HTTP server, routes inbound messages) ─────────

  gateway: {
    startAccount: async (ctx) => {
      const rt = getRuntime();

      // Destructure the dispatch pipeline — must come from PluginRuntime,
      // NOT ctx.runtime (RuntimeEnv lacks the full channel-reply layer).
      const { loadConfig } = rt.config;
      const { resolveAgentRoute } = rt.channel.routing;
      const { finalizeInboundContext, dispatchReplyWithBufferedBlockDispatcher } =
        rt.channel.reply;
      const { recordInboundSession, resolveStorePath } = rt.channel.session;

      const cfg = loadConfig();
      const port: number = (cfg as any)?.channels?.mentra?.port ?? DEFAULT_PORT;
      const callbackUrl: string =
        (cfg as any)?.channels?.mentra?.callbackUrl ?? DEFAULT_CALLBACK_URL;

      ctx.setStatus?.({ accountId: "default", port, callbackUrl });

      // ── HTTP server ──────────────────────────────────────────────────────

      const server = http.createServer((req, res) => {
        const { method, url } = req;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          void dispatch(method ?? "", url ?? "", body, res);
        });
        req.on("error", (err) => {
          ctx.log?.error("[mentra] Request stream error:", err);
          sendJson(res, 500, { error: "Stream error" });
        });
      });

      async function dispatch(
        method: string,
        url: string,
        body: string,
        res: http.ServerResponse
      ): Promise<void> {
        try {
          if (method === "POST" && url === "/mentra/inbound") {
            await handleInbound(body, res);
          } else if (method === "GET" && url === "/mentra/health") {
            sendJson(res, 200, { status: "ok", channel: CHANNEL_ID });
          } else {
            sendJson(res, 404, { error: "Not found" });
          }
        } catch (err) {
          ctx.log?.error("[mentra] Handler error:", err);
          sendJson(res, 500, { error: "Internal server error" });
        }
      }

      async function handleInbound(
        body: string,
        res: http.ServerResponse
      ): Promise<void> {
        let msg: InboundMessage;
        try {
          msg = JSON.parse(body) as InboundMessage;
        } catch {
          sendJson(res, 400, { error: "Invalid JSON" });
          return;
        }

        if (!msg.text?.trim() || !msg.sessionKey) {
          sendJson(res, 400, { error: "Missing required fields: text, sessionKey" });
          return;
        }

        // Acknowledge immediately before the async dispatch pipeline.
        sendJson(res, 202, { status: "accepted" });

        const freshCfg = loadConfig();

        // 1. Resolve agent route
        const route = resolveAgentRoute({
          cfg: freshCfg,
          channel: CHANNEL_ID,
          accountId: "default",
          peer: { kind: "direct", id: msg.sessionKey },
        });

        ctx.log?.debug?.(
          `[mentra] route: agent=${route.agentId} session=${route.sessionKey}`
        );

        // 2. Finalize inbound context
        const inboundCtx = finalizeInboundContext({
          Body: msg.text.trim(),
          BodyForAgent: msg.text.trim(),
          RawBody: msg.text.trim(),
          CommandBody: msg.text.trim(),
          From: `mentra:${msg.sessionKey}`,
          To: msg.sessionKey,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "direct",
          ConversationLabel: `mentra:${msg.sessionKey}`,
          SenderName: "User",
          SenderId: msg.sessionKey,
          Provider: CHANNEL_ID,
          Surface: CHANNEL_ID,
          WasMentioned: true,
          MessageSid: `mentra-${Date.now()}`,
          Timestamp: Date.now(),
          CommandAuthorized: true,
          OriginatingChannel: CHANNEL_ID,
          OriginatingTo: msg.sessionKey,
        });

        // 3. Record inbound session
        const storePath = resolveStorePath(undefined, { agentId: route.agentId });
        await recordInboundSession({
          storePath,
          sessionKey: route.sessionKey,
          ctx: inboundCtx,
          updateLastRoute: {
            sessionKey: route.sessionKey,
            channel: CHANNEL_ID,
            to: msg.sessionKey,
            accountId: route.accountId,
          },
          onRecordError: (err: unknown) => {
            ctx.log?.warn(`[mentra] Session record error: ${String(err)}`);
          },
        });

        // 4. Dispatch — deliver callback POSTs response to MentraOS App
        try {
          await dispatchReplyWithBufferedBlockDispatcher({
            ctx: inboundCtx,
            cfg: freshCfg,
            dispatcherOptions: {
              deliver: async (payload: any) => {
                const text: string = payload.text ?? payload.body ?? "";
                if (!text) return;
                ctx.log?.debug?.(
                  `[mentra] Delivering reply (${text.length} chars) → ${callbackUrl}`
                );
                await postCallback(callbackUrl, { text, sessionKey: msg.sessionKey });
              },
              onError: (err: unknown) => {
                ctx.log?.error(
                  `[mentra] dispatchReplyWithBufferedBlockDispatcher error: ${String(err)}`
                );
              },
            },
          });
        } catch (err) {
          ctx.log?.error(
            `[mentra] dispatchReplyWithBufferedBlockDispatcher threw: ${String(err)}`
          );
        }
      }

      // ── Start listening ──────────────────────────────────────────────────

      await new Promise<void>((resolve, reject) => {
        server.listen(port, "127.0.0.1", () => {
          ctx.log?.info(
            `[mentra] HTTP server listening on http://127.0.0.1:${port}/mentra/inbound`
          );
          ctx.log?.info(`[mentra] Callback URL: ${callbackUrl}`);
          resolve();
        });
        server.once("error", reject);
      });

      // Block until OpenClaw signals shutdown via abortSignal.
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) { resolve(); return; }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      server.close();
      ctx.log?.info("[mentra] HTTP server stopped");
    },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveCallbackUrl(): string {
  try {
    const rt = getRuntime();
    const cfg = rt.config.loadConfig() as any;
    return cfg?.channels?.mentra?.callbackUrl ?? DEFAULT_CALLBACK_URL;
  } catch {
    return DEFAULT_CALLBACK_URL;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function postCallback(url: string, payload: CallbackPayload): Promise<void> {
  const json = JSON.stringify(payload);
  const parsed = new URL(url);
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : parsed.protocol === "https:" ? 443 : 80;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(json),
        },
      },
      (res) => { res.resume(); res.on("end", resolve); }
    );
    req.setTimeout(5_000, () => req.destroy(new Error("Callback POST timed out")));
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}
