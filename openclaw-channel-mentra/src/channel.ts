/**
 * channel.ts — OpenClaw ChannelPlugin für MentraOS G2 Smart Glasses.
 *
 * Spawnt tpa-server.ts als eigenen Bun-Kindprozess.
 * Dispatch läuft über lokalen IPC-HTTP-Server im Gateway-Prozess.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { getRuntime } from "./runtime.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mentraOnboarding } from "./onboarding.js";

const CHANNEL_ID = "mentra";
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MentraAccount {
  accountId: string;
  mentraApiKey: string;
  mentraPackageName: string;
  mentraServerPort: number;
  mentraServerUrl: string;
  configured: boolean;
}

// ── IPC dispatch ──────────────────────────────────────────────────────────────

async function dispatchToOpenClaw(
  cr: any,
  cfg: any,
  accountId: string,
  prompt: string,
  sessionKey: string
): Promise<string> {
  if (!cr) return "";

  try {
    const route = cr.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId,
      peer: { kind: "direct", id: sessionKey },
    });

    const inboundCtx = cr.reply.finalizeInboundContext({
      Body: prompt,
      BodyForAgent: prompt,
      RawBody: prompt,
      CommandBody: prompt,
      From: `mentra:${sessionKey}`,
      To: sessionKey,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct",
      ConversationLabel: `mentra:${sessionKey}`,
      SenderName: "User",
      SenderId: sessionKey,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      WasMentioned: true,
      MessageSid: `mentra-${Date.now()}`,
      Timestamp: Date.now(),
      CommandAuthorized: true,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: sessionKey,
    });

    const storePath = cr.session.resolveStorePath(undefined, { agentId: route.agentId });
    await cr.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx: inboundCtx,
      updateLastRoute: {
        sessionKey: route.sessionKey,
        channel: CHANNEL_ID,
        to: sessionKey,
        accountId: route.accountId,
      },
      onRecordError: (err: unknown) => {
        console.warn(`[mentra] session record error: ${String(err)}`);
      },
    });

    // Wait for the dispatcher to fully complete — don't resolve on first block
    // (first blocks are often intermediate tool narration, not the final answer)
    let lastText = "";
    return await new Promise<string>((resolve) => {
      cr.reply
        .dispatchReplyWithBufferedBlockDispatcher({
          ctx: inboundCtx,
          cfg,
          dispatcherOptions: {
            deliver: async (payload: any) => {
              const text: string = payload.text ?? payload.body ?? "";
              if (text) lastText = text;
            },
            onError: (err: unknown) => {
              console.error(`[mentra] dispatch error: ${String(err)}`);
              resolve(lastText);
            },
          },
        })
        .then(() => resolve(lastText))
        .catch((err: unknown) => {
          console.error(`[mentra] dispatch threw: ${String(err)}`);
          resolve(lastText);
        });
    });
  } catch (err) {
    console.error(`[mentra] dispatch setup error: ${String(err)}`);
    return "";
  }
}

// ── Exec Approval WebSocket subscription ──────────────────────────────────────

async function subscribeExecApprovals(
  controlPort: number,
  cfg: any,
  abortSignal: AbortSignal,
  log: any
): Promise<void> {
  // Token: try multiple config paths, then env var
  const token: string =
    cfg?.gateway?.auth?.token ??
    cfg?.gateway?.operatorToken ??
    process.env.OPENCLAW_OPERATOR_TOKEN ??
    "";

  const wsPort: number = cfg?.gateway?.wsPort ?? 18789;

  if (!token) {
    log?.warn?.("[mentra] no operator token found — exec approval WS skipped. Set OPENCLAW_OPERATOR_TOKEN or openclaw config gateway.operatorToken");
    return;
  }

  function connect(): void {
    if (abortSignal.aborted) return;

    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`);

    ws.addEventListener("open", () => {
      log?.info?.("[mentra] approval WS connected");
      ws.send(JSON.stringify({
        type: "req", id: "auth", method: "connect",
        params: {
          token,
          role: "operator",
          scopes: ["operator.read", "operator.write", "operator.approvals"],
          minProtocol: 3, maxProtocol: 3,
        },
      }));
    });

    ws.addEventListener("message", async (event: MessageEvent) => {
      try {
        const frame = JSON.parse(event.data as string);
        if (frame.type !== "event" || frame.event !== "exec.approval.requested") return;

        const { id, command, cwd, description } = frame.payload as {
          id: string; command?: string; cwd?: string; description?: string;
        };
        const info = description ?? (cwd ? `${command ?? ""} (in ${cwd})` : (command ?? ""));

        const res = await fetch(`http://127.0.0.1:${controlPort}/approval`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: command ?? "", info }),
          signal: AbortSignal.timeout(15_000),
        });
        const { decision } = await res.json() as { decision: string };

        ws.send(JSON.stringify({
          type: "req", id: `resolve-${id}`, method: "exec.approval.resolve",
          params: { id, decision },
        }));
      } catch (err) {
        log?.error?.(`[mentra] approval WS message error: ${String(err)}`);
      }
    });

    ws.addEventListener("close", () => {
      if (!abortSignal.aborted) {
        log?.warn?.("[mentra] approval WS closed — reconnecting in 5s");
        setTimeout(connect, 5_000);
      }
    });

    ws.addEventListener("error", () => {
      // close event will handle reconnect
    });

    abortSignal.addEventListener("abort", () => ws.close(), { once: true });
  }

  connect();
}

// ── ChannelPlugin ─────────────────────────────────────────────────────────────

export const mentraChannel: ChannelPlugin<MentraAccount> = {
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

  onboarding: mentraOnboarding,

  config: {
    listAccountIds: (_cfg) => ["default"],
    resolveAccount: (cfg: any, _accountId) => ({
      accountId: "default",
      mentraApiKey: cfg?.channels?.mentra?.mentraApiKey ?? "",
      mentraPackageName: cfg?.channels?.mentra?.mentraPackageName ?? "",
      mentraServerPort: cfg?.channels?.mentra?.mentraServerPort ?? 7010,
      mentraServerUrl: cfg?.channels?.mentra?.mentraServerUrl ?? "",
      configured: !!(
        cfg?.channels?.mentra?.mentraApiKey &&
        cfg?.channels?.mentra?.mentraPackageName &&
        cfg?.channels?.mentra?.mentraServerUrl
      ),
    }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: "default",
      name: `Mentra (${account.mentraPackageName || "not configured"})`,
      enabled: account.configured,
      configured: account.configured,
    }),
  },

  outbound: {
    deliveryMode: "direct",
    sendText: async ({ log }) => {
      log?.warn?.("[mentra] outbound.sendText: no active session reference");
      return { channel: CHANNEL_ID, messageId: `mentra-${Date.now()}` };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account as MentraAccount;

      if (!account.configured) {
        ctx.log?.warn?.("[mentra] not configured — skipping");
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) { resolve(); return; }
          ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }

      const cr = (ctx as any).channelRuntime ?? (() => {
        try { const rt = getRuntime(); return rt.channel ?? null; } catch (_) { return null; }
      })();
      if (!cr) ctx.log?.warn?.("[mentra] channelRuntime unavailable — dispatch disabled");

      // ── IPC HTTP server (loopback only) ───────────────────────────────────────

      const ipcServer = createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/dispatch") {
          res.writeHead(404);
          res.end();
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString());

        const text = await dispatchToOpenClaw(
          cr,
          ctx.cfg,
          account.accountId,
          body.prompt,
          body.sessionKey ?? randomUUID()
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text }));
      });

      const ipcPort = await new Promise<number>((resolve, reject) => {
        ipcServer.listen(0, "127.0.0.1", () => {
          const addr = ipcServer.address();
          if (addr && typeof addr === "object") resolve(addr.port);
          else reject(new Error("IPC server address unavailable"));
        });
      });

      ctx.log?.info?.(`[mentra] IPC server on port ${ipcPort}`);

      // ── Allocate control port (channel → child IPC for approvals) ────────────

      const controlPort = await new Promise<number>((resolve, reject) => {
        const tmp = createServer();
        tmp.listen(0, "127.0.0.1", () => {
          const addr = tmp.address();
          tmp.close(() => {
            if (addr && typeof addr === "object") resolve(addr.port);
            else reject(new Error("control port alloc failed"));
          });
        });
      });

      ctx.log?.info?.(`[mentra] control port allocated: ${controlPort}`);

      // ── Subscribe to exec approval events via gateway WebSocket ─────────────
      // Protocol: JSON-RPC over ws://localhost:18789/ws (operator role)

      void subscribeExecApprovals(controlPort, ctx.cfg, ctx.abortSignal, ctx.log);

      // ── Free port before spawning ─────────────────────────────────────────────

      try {
        const { execSync } = await import("node:child_process");
        execSync(`fuser -k ${account.mentraServerPort}/tcp 2>/dev/null || true`, { stdio: "ignore" });
        await new Promise((r) => setTimeout(r, 800));
      } catch (_) {}

      // ── Spawn TpaServer child process ─────────────────────────────────────────

      const tpaScriptPath = join(__dirname, "tpa-server.ts");
      const child = spawn("bun", ["run", tpaScriptPath], {
        env: {
          ...process.env,
          IPC_PORT: String(ipcPort),
          CONTROL_PORT: String(controlPort),
          MENTRA_PACKAGE_NAME: account.mentraPackageName,
          MENTRA_API_KEY: account.mentraApiKey,
          MENTRA_SERVER_PORT: String(account.mentraServerPort),
          MENTRA_ACCOUNT_ID: account.accountId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
      child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
      child.on("exit", (code) => {
        ctx.log?.info?.(`[mentra] child exited with code ${code}`);
      });

      ctx.log?.info?.(`[mentra] spawned TpaServer child (pid ${child.pid})`);

      // ── Wait for abort ────────────────────────────────────────────────────────

      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) { resolve(); return; }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      child.kill("SIGTERM");
      ipcServer.close();

      ctx.log?.info?.("[mentra] shutdown complete");
    },
  },
};
