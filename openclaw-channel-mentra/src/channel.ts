/**
 * Mentra channel — self-contained plugin.
 *
 * Starts a TpaServer (MentraOS SDK) that connects directly to the glasses.
 * Transcription → state machine → OpenClaw agent dispatch → glasses display.
 * No separate app or HTTP server needed.
 *
 * Required config (set via `openclaw config set`):
 *   channels.mentra.mentraApiKey        — from console.mentra.glass
 *   channels.mentra.mentraPackageName   — from console.mentra.glass
 *
 * Optional config:
 *   channels.mentra.mentraServerPort    — TpaServer port (default 7010)
 */

import { TpaServer } from "@mentra/sdk";
import type { TpaSession } from "@mentra/sdk";
import type { ChannelPlugin, PluginRuntime } from "openclaw/plugin-sdk";
import { randomUUID } from "node:crypto";
import { getRuntime } from "./runtime.js";
import { mentraOnboarding } from "./onboarding.js";

// ── Constants ────────────────────────────────────────────────────────────────

const CHANNEL_ID = "mentra";

const GREETING_WORDS = [
  "guten morgen", "guten abend", "guten tag", "grüß gott",
  "hallo", "servus", "howdy", "aloha", "salut",
  "moin", "ahoi", "ciao", "jojo", "hey", "hi", "na", "yo",
] as const;

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const MS = {
  TRIGGERED_TIMEOUT: 5_000,
  SILENCE: 2_000,
  POST_RESPONSE: 14_000,
  FOLLOW_UP_INITIAL: 6_000,
  APPROVAL_AUTO_DENY: 10_000,
  SPINNER: 120,
} as const;

const MAX_FOLLOW_UPS = 10;

// ── Types ────────────────────────────────────────────────────────────────────

type MainState = "IDLE" | "TRIGGERED" | "LISTENING" | "PROCESSING";
type AppState = MainState | "APPROVAL";

export interface MentraAccount {
  accountId: string;
  mentraApiKey: string;
  mentraPackageName: string;
  mentraServerPort: number;
  configured: boolean;
}

// ── TpaServer + state machine ─────────────────────────────────────────────────

class MentraG2Server extends TpaServer {
  private readonly runtime: PluginRuntime;
  private readonly accountId: string;

  private state: AppState = "IDLE";
  private stateBeforeApproval: MainState = "IDLE";
  private session: TpaSession | null = null;
  private promptAccumulator = "";
  private greetingWord = "";
  private followUpCount = 0;
  private activeRequestId: string | null = null;
  private pendingApproval: { id: string; command: string } | null = null;

  private timers: {
    silence?: ReturnType<typeof setTimeout>;
    trigger?: ReturnType<typeof setTimeout>;
    postResponse?: ReturnType<typeof setTimeout>;
    followUp?: ReturnType<typeof setTimeout>;
    approval?: ReturnType<typeof setTimeout>;
  } = {};
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;

  constructor(
    serverConfig: { packageName: string; apiKey: string; port?: number },
    runtime: PluginRuntime,
    accountId: string
  ) {
    super(serverConfig);
    this.runtime = runtime;
    this.accountId = accountId;
  }

  // ── SDK lifecycle ────────────────────────────────────────────────────────────

  protected async onSession(
    session: TpaSession,
    _sessionId: string,
    _userId: string
  ): Promise<void> {
    this.session = session;
    this.hardReset();

    session.events.onTranscription((data) => {
      const lower = (data.text ?? "").toLowerCase().trim();
      const isFinal = data.isFinal ?? true;

      if (this.state === "APPROVAL") {
        if (isFinal) this.handleApprovalTranscription(lower);
        return;
      }

      this.onTranscription(data.text ?? "", isFinal);
    });

    session.events.onDisconnected(() => {
      this.hardReset();
      this.session = null;
    });

    this.display("Mentra bereit");
  }

  // ── Display ──────────────────────────────────────────────────────────────────

  private display(text: string): void {
    if (!this.session) return;
    try {
      this.session.layouts.showTextWall(text);
    } catch (err) {
      console.error("[mentra] Display error:", err);
    }
  }

  private startSpinner(): void {
    this.spinnerFrame = 0;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_FRAMES.length;
      this.display(BRAILLE_FRAMES[this.spinnerFrame]);
    }, MS.SPINNER);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  // ── Timer helpers ─────────────────────────────────────────────────────────────

  private clearTimer(name: keyof typeof this.timers): void {
    if (this.timers[name] !== undefined) {
      clearTimeout(this.timers[name]!);
      delete this.timers[name];
    }
  }

  private clearAllTimers(): void {
    for (const k of Object.keys(this.timers) as (keyof typeof this.timers)[]) {
      this.clearTimer(k);
    }
  }

  private hardReset(): void {
    this.clearAllTimers();
    this.stopSpinner();
    this.state = "IDLE";
    this.promptAccumulator = "";
    this.greetingWord = "";
    this.followUpCount = 0;
    this.activeRequestId = null;
    this.pendingApproval = null;
  }

  // ── State transitions ─────────────────────────────────────────────────────────

  private transition(next: AppState): void {
    console.log(`[mentra] ${this.state} → ${next}`);
    this.state = next;
  }

  private gotoIdle(): void {
    this.clearAllTimers();
    this.stopSpinner();
    this.promptAccumulator = "";
    this.greetingWord = "";
    this.followUpCount = 0;
    this.transition("IDLE");
    this.display("Mentra bereit");
  }

  private gotoTriggered(greeting: string): void {
    this.clearTimer("postResponse");
    this.clearTimer("silence");
    this.clearTimer("followUp");
    this.stopSpinner();
    this.promptAccumulator = "";
    this.greetingWord = greeting;
    this.transition("TRIGGERED");
    this.display(greeting);

    this.clearTimer("trigger");
    this.timers.trigger = setTimeout(() => {
      if (this.state === "TRIGGERED") this.gotoIdle();
    }, MS.TRIGGERED_TIMEOUT);
  }

  private gotoListening(initialPrompt = "", followUpTimeout = 0): void {
    this.clearTimer("trigger");
    this.clearTimer("postResponse");
    this.clearTimer("followUp");
    this.stopSpinner();
    this.promptAccumulator = initialPrompt;
    this.transition("LISTENING");
    this.display("Hey Mentra");

    if (followUpTimeout > 0) {
      this.timers.followUp = setTimeout(() => {
        if (this.state === "LISTENING" && this.promptAccumulator === "") {
          this.gotoIdle();
        }
      }, followUpTimeout);
    }

    this.resetSilenceTimer();
  }

  private gotoProcessing(): void {
    this.clearTimer("silence");
    this.clearTimer("followUp");
    this.transition("PROCESSING");
    this.startSpinner();

    const prompt = this.promptAccumulator.trim();
    this.promptAccumulator = "";

    if (!prompt) {
      this.gotoIdle();
      return;
    }

    const requestId = randomUUID();
    this.activeRequestId = requestId;

    void this.dispatchPrompt(prompt, requestId);
  }

  private resetSilenceTimer(): void {
    this.clearTimer("silence");
    this.timers.silence = setTimeout(() => {
      if (this.state === "LISTENING") this.gotoProcessing();
    }, MS.SILENCE);
  }

  // ── Transcription handler ─────────────────────────────────────────────────────

  private onTranscription(text: string, isFinal: boolean): void {
    const lower = text.toLowerCase().trim();
    if (!lower) return;

    switch (this.state) {
      case "IDLE":
        if (isFinal) this.handleIdleTranscription(lower, text.trim());
        break;

      case "TRIGGERED":
        if (isFinal) this.handleTriggeredTranscription(lower);
        break;

      case "LISTENING":
        this.resetSilenceTimer();
        this.clearTimer("followUp");
        if (isFinal) {
          this.promptAccumulator +=
            (this.promptAccumulator ? " " : "") + text.trim();
        }
        break;

      case "PROCESSING":
        if (isFinal && this.containsMentra(lower) && this.hasGreeting(lower)) {
          this.activeRequestId = null;
          this.gotoTriggered(this.extractGreeting(lower));
        }
        break;
    }
  }

  private handleIdleTranscription(lower: string, original: string): void {
    const greeting = this.extractGreeting(lower);
    if (!greeting) return;

    if (this.containsMentra(lower)) {
      const afterMentra = this.extractAfterMentra(lower, original);
      this.gotoListening(afterMentra);
      return;
    }

    this.gotoTriggered(greeting);
  }

  private handleTriggeredTranscription(lower: string): void {
    if (this.containsMentra(lower)) {
      this.gotoListening();
      return;
    }
    const greeting = this.extractGreeting(lower);
    if (greeting) {
      this.gotoTriggered(greeting);
      return;
    }
    this.gotoIdle();
  }

  // ── OpenClaw dispatch ─────────────────────────────────────────────────────────

  private async dispatchPrompt(prompt: string, requestId: string): Promise<void> {
    const rt = this.runtime;
    const { loadConfig } = rt.config;
    const { resolveAgentRoute } = rt.channel.routing;
    const { finalizeInboundContext, dispatchReplyWithBufferedBlockDispatcher } =
      rt.channel.reply;
    const { recordInboundSession, resolveStorePath } = rt.channel.session;

    const cfg = loadConfig();
    const sessionKey = randomUUID();

    const route = resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId: this.accountId,
      peer: { kind: "direct", id: sessionKey },
    });

    const inboundCtx = finalizeInboundContext({
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

    const storePath = resolveStorePath(undefined, { agentId: route.agentId });
    await recordInboundSession({
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
        console.warn(`[mentra] Session record error: ${String(err)}`);
      },
    });

    try {
      await dispatchReplyWithBufferedBlockDispatcher({
        ctx: inboundCtx,
        cfg,
        dispatcherOptions: {
          deliver: async (payload: any) => {
            if (this.activeRequestId !== requestId) return;
            const text: string = payload.text ?? payload.body ?? "";
            if (text) this.handleAgentResponse(text);
          },
          onError: (err: unknown) => {
            console.error(`[mentra] Dispatch error: ${String(err)}`);
            if (this.activeRequestId === requestId) this.gotoIdle();
          },
        },
      });
    } catch (err) {
      console.error(`[mentra] Dispatch threw: ${String(err)}`);
      if (this.activeRequestId === requestId) this.gotoIdle();
    }
  }

  private handleAgentResponse(text: string): void {
    this.activeRequestId = null;
    this.stopSpinner();
    this.display(text);

    const endsWithQuestion = text.trimEnd().endsWith("?");

    if (endsWithQuestion && this.followUpCount < MAX_FOLLOW_UPS) {
      this.followUpCount++;
      this.gotoListening("", MS.FOLLOW_UP_INITIAL);
    } else {
      this.followUpCount = 0;
      this.transition("TRIGGERED");
      this.timers.postResponse = setTimeout(() => {
        if (this.state === "TRIGGERED") this.gotoIdle();
      }, MS.POST_RESPONSE);
    }
  }

  // ── Approval ──────────────────────────────────────────────────────────────────

  private handleApprovalTranscription(lower: string): void {
    if (!this.pendingApproval) return;

    if (lower.includes("info")) {
      this.display(`[A] ${this.pendingApproval.command}?`);
      setTimeout(() => {
        if (this.state === "APPROVAL") this.display("[A]");
      }, 6_000);
      return;
    }

    if (lower.includes("ja") && !lower.includes("nein")) {
      this.resolveApproval("allow-once");
    } else if (lower.includes("nein")) {
      this.resolveApproval("deny");
    }
  }

  private resolveApproval(decision: "allow-once" | "deny"): void {
    if (!this.pendingApproval) return;
    this.clearTimer("approval");
    this.pendingApproval = null;

    const restored = this.stateBeforeApproval;
    this.stateBeforeApproval = "IDLE";

    if (restored === "PROCESSING") {
      this.transition("PROCESSING");
      this.startSpinner();
    } else if (restored === "LISTENING") {
      this.gotoListening();
    } else {
      this.gotoIdle();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private hasGreeting(lower: string): boolean {
    return GREETING_WORDS.some((g) => lower.includes(g));
  }

  private containsMentra(lower: string): boolean {
    return lower.includes("mentra");
  }

  private extractGreeting(lower: string): string {
    for (const g of GREETING_WORDS) {
      if (lower.includes(g)) return g;
    }
    return "";
  }

  private extractAfterMentra(lower: string, original: string): string {
    const idx = lower.indexOf("mentra");
    if (idx === -1) return "";
    return original.slice(idx + "mentra".length).replace(/^[,.:!?\s]+/, "").trim();
  }
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
      configured: !!(
        cfg?.channels?.mentra?.mentraApiKey &&
        cfg?.channels?.mentra?.mentraPackageName
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
        throw new Error(
          "[mentra] Not configured. Run:\n" +
            "  openclaw config set channels.mentra.mentraApiKey YOUR_KEY\n" +
            "  openclaw config set channels.mentra.mentraPackageName YOUR_PACKAGE_NAME\n" +
            "Then restart the gateway."
        );
      }

      ctx.log?.info(
        `[mentra] Starting TpaServer (port ${account.mentraServerPort}) for ${account.mentraPackageName}`
      );

      const server = new MentraG2Server(
        {
          packageName: account.mentraPackageName,
          apiKey: account.mentraApiKey,
          port: account.mentraServerPort,
        },
        getRuntime(),
        account.accountId
      );

      await server.start();
      ctx.log?.info("[mentra] TpaServer running — waiting for glasses to connect");

      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) { resolve(); return; }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      await server.stop();
      ctx.log?.info("[mentra] TpaServer stopped");
    },
  },
};
