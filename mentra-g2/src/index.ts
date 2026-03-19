/**
 * mentra-g2 — MentraOS App for G2 Smart Glasses
 *
 * Turns the G2 into a voice interface for the OpenClaw AI agent.
 *
 * State machine:
 *   IDLE → TRIGGERED → LISTENING → PROCESSING → TRIGGERED
 *   Any main state can be interrupted by APPROVAL (state machine frozen).
 *
 * Run: bun run src/index.ts
 */

import "dotenv/config";
import express from "express";
import { AppServer } from "@mentra/sdk";
import type { AppAppSession } from "@mentra/sdk";
import { PluginClient } from "./plugin-client.js";
import type { ApprovalDecision } from "./plugin-client.js";
import { randomUUID } from "node:crypto";

// ── Constants ────────────────────────────────────────────────────────────────

const GREETING_WORDS = [
  "guten morgen",
  "guten abend",
  "guten tag",
  "grüß gott",
  "hallo",
  "servus",
  "howdy",
  "aloha",
  "salut",
  "moin",
  "ahoi",
  "ciao",
  "jojo",
  "hey",
  "hi",
  "na",
  "yo",
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

interface ApprovalPayload {
  type: "approval";
  id: string;
  command: string;
  sessionKey: string;
}

interface ResponsePayload {
  text: string;
  sessionKey: string;
}

// ── App ──────────────────────────────────────────────────────────────────────

class MentraG2 extends AppServer {
  // --- State machine ----------------------------------------------------------
  private state: AppState = "IDLE";
  private stateBeforeApproval: MainState = "IDLE";

  // --- AppSession context --------------------------------------------------------
  private session: AppSession | null = null;

  // --- Listening context ------------------------------------------------------
  private promptAccumulator = "";
  private greetingWord = "";
  private followUpCount = 0;

  // --- Processing context -----------------------------------------------------
  /** Invalidated when a request is cancelled to ignore stale responses. */
  private activeRequestId: string | null = null;

  // --- Approval context -------------------------------------------------------
  private pendingApproval: { id: string; command: string } | null = null;

  // --- Timers -----------------------------------------------------------------
  private timers: {
    silence?: ReturnType<typeof setTimeout>;
    trigger?: ReturnType<typeof setTimeout>;
    postResponse?: ReturnType<typeof setTimeout>;
    followUp?: ReturnType<typeof setTimeout>;
    approval?: ReturnType<typeof setTimeout>;
  } = {};
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;

  // --- Deps -------------------------------------------------------------------
  private readonly client: PluginClient;

  // ── Constructor ─────────────────────────────────────────────────────────────

  constructor() {
    if (!process.env.PACKAGE_NAME) throw new Error("PACKAGE_NAME env var is required");
    if (!process.env.MENTRA_API_KEY) throw new Error("MENTRA_API_KEY env var is required");

    super({
      packageName: process.env.PACKAGE_NAME,
      apiKey: process.env.MENTRA_API_KEY,
    });

    this.client = new PluginClient(
      process.env.PLUGIN_URL ?? "http://localhost:4747"
    );

    this.startCallbackServer();
  }

  // ── Callback HTTP server (receives responses from plugin) ────────────────────

  private startCallbackServer(): void {
    const app = express();
    app.use(express.json());

    app.post("/response", (req, res) => {
      // Acknowledge before processing to avoid plugin timeouts.
      res.json({ status: "ok" });

      const payload = req.body as ApprovalPayload | ResponsePayload;

      if ("type" in payload && payload.type === "approval") {
        this.handleApprovalRequest(payload);
      } else {
        const rp = payload as ResponsePayload;
        if (rp.sessionKey === this.client.sessionKey) {
          this.handleAgentResponse(rp.text);
        }
      }
    });

    const port = parseInt(process.env.PORT ?? "3000", 10);
    app.listen(port, "127.0.0.1", () => {
      console.log(`[mentra-g2] Callback server on http://127.0.0.1:${port}`);
    });
  }

  // ── Display ──────────────────────────────────────────────────────────────────

  private display(text: string): void {
    if (!this.session) return;
    try {
      this.session.layouts.showTextWall(text);
    } catch (err) {
      console.error("[mentra-g2] Display error:", err);
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
    if (this.state !== next) {
      console.log(`[mentra-g2] ${this.state} -> ${next}`);
      this.state = next;
    }
  }

  private async gotoIdle(): Promise<void> {
    this.clearAllTimers();
    this.stopSpinner();
    this.promptAccumulator = "";
    this.greetingWord = "";
    this.followUpCount = 0;
    this.transition("IDLE");
    this.display("Mentra bereit");
  }

  private async gotoTriggered(greeting: string): Promise<void> {
    this.clearTimer("postResponse");
    this.clearTimer("silence");
    this.clearTimer("followUp");
    this.stopSpinner();
    this.promptAccumulator = "";
    this.greetingWord = greeting;
    this.transition("TRIGGERED");
    this.display(greeting);

    // Restart 5s TRIGGERED → IDLE watchdog.
    this.clearTimer("trigger");
    this.timers.trigger = setTimeout(() => {
      if (this.state === "TRIGGERED") void this.gotoIdle();
    }, MS.TRIGGERED_TIMEOUT);
  }

  /**
   * Enter LISTENING state.
   * @param initialPrompt  Pre-filled prompt (e.g. from one-shot utterance).
   * @param followUpTimeout  If > 0, start an "initial speech" watchdog that
   *                         fires if the user doesn't speak at all within this
   *                         window.
   */
  private async gotoListening(
    initialPrompt = "",
    followUpTimeout = 0
  ): Promise<void> {
    this.clearTimer("trigger");
    this.clearTimer("postResponse");
    this.clearTimer("followUp");
    this.stopSpinner();
    this.promptAccumulator = initialPrompt;
    this.transition("LISTENING");
    this.display("Hey Mentra");

    if (followUpTimeout > 0) {
      // Fire if user never speaks in the follow-up window.
      this.timers.followUp = setTimeout(() => {
        if (this.state === "LISTENING" && this.promptAccumulator === "") {
          void this.gotoIdle();
        }
      }, followUpTimeout);
    }

    this.resetSilenceTimer();
  }

  private async gotoProcessing(): Promise<void> {
    this.clearTimer("silence");
    this.clearTimer("followUp");
    this.transition("PROCESSING");
    this.startSpinner();

    const prompt = this.promptAccumulator.trim();
    this.promptAccumulator = "";

    if (!prompt) {
      await this.gotoIdle();
      return;
    }

    const requestId = randomUUID();
    this.activeRequestId = requestId;

    try {
      await this.client.sendMessage(prompt);
    } catch (err) {
      console.error("[mentra-g2] Failed to send message:", err);
      if (this.activeRequestId === requestId) {
        await this.gotoIdle();
      }
    }
  }

  private resetSilenceTimer(): void {
    this.clearTimer("silence");
    this.timers.silence = setTimeout(() => {
      if (this.state === "LISTENING") void this.gotoProcessing();
    }, MS.SILENCE);
  }

  // ── Transcription handler ────────────────────────────────────────────────────

  private onTranscription(text: string, isFinal: boolean): void {
    if (this.state === "APPROVAL") return; // state machine frozen

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
        // Any transcription event (partial or final) resets silence detection.
        this.resetSilenceTimer();
        // Cancel the follow-up initial timeout as soon as speech arrives.
        this.clearTimer("followUp");
        // Accumulate only final segments.
        if (isFinal) {
          this.promptAccumulator +=
            (this.promptAccumulator ? " " : "") + text.trim();
        }
        break;

      case "PROCESSING":
        // "Hey Mentra" detected → cancel current request and return to TRIGGERED.
        if (isFinal && this.containsMentra(lower) && this.hasGreeting(lower)) {
          this.activeRequestId = null; // invalidate pending response
          const greeting = this.extractGreeting(lower);
          void this.gotoTriggered(greeting);
        }
        break;
    }
  }

  private handleIdleTranscription(lower: string, original: string): void {
    const greeting = this.extractGreeting(lower);
    if (!greeting) return;

    if (this.containsMentra(lower)) {
      const afterMentra = this.extractAfterMentra(lower, original);
      if (afterMentra) {
        // Full command in one utterance: greeting + "Mentra" + prompt.
        void this.gotoListening(afterMentra);
      } else {
        // Greeting + "Mentra" but no prompt yet.
        void this.gotoListening();
      }
      return;
    }

    void this.gotoTriggered(greeting);
  }

  private handleTriggeredTranscription(lower: string): void {
    if (this.containsMentra(lower)) {
      void this.gotoListening();
      return;
    }

    // Another greeting resets the trigger window.
    const greeting = this.extractGreeting(lower);
    if (greeting) {
      void this.gotoTriggered(greeting);
      return;
    }

    // Any non-greeting, non-Mentra word → back to IDLE.
    void this.gotoIdle();
  }

  // ── Agent response ────────────────────────────────────────────────────────────

  private handleAgentResponse(text: string): void {
    if (this.state !== "PROCESSING") return;
    if (this.activeRequestId === null) return; // cancelled

    this.activeRequestId = null;
    this.stopSpinner();

    const endsWithQuestion = text.trimEnd().endsWith("?");

    void (async () => {
      this.display(text);

      if (endsWithQuestion && this.followUpCount < MAX_FOLLOW_UPS) {
        this.followUpCount++;
        // Go directly to LISTENING so the user can reply without re-triggering.
        // Start 6s watchdog; if they never speak it falls back to IDLE.
        await this.gotoListening("", MS.FOLLOW_UP_INITIAL);
      } else {
        this.followUpCount = 0;
        this.transition("TRIGGERED");
        // 14s post-response window: user can say "Mentra" again for follow-up.
        this.timers.postResponse = setTimeout(() => {
          if (this.state === "TRIGGERED") void this.gotoIdle();
        }, MS.POST_RESPONSE);
      }
    })();
  }

  // ── Approval handler ──────────────────────────────────────────────────────────

  private handleApprovalRequest(payload: ApprovalPayload): void {
    if (payload.sessionKey !== this.client.sessionKey) return;

    // Freeze the current state.
    this.stateBeforeApproval =
      this.state === "APPROVAL" ? this.stateBeforeApproval : (this.state as MainState);

    this.pendingApproval = { id: payload.id, command: payload.command };
    this.transition("APPROVAL");
    void this.display("[A]");

    // 10s auto-deny timeout.
    this.clearTimer("approval");
    this.timers.approval = setTimeout(() => {
      if (this.state === "APPROVAL") {
        console.log("[mentra-g2] Approval timed out, auto-denying");
        void this.resolveApproval("deny");
      }
    }, MS.APPROVAL_AUTO_DENY);
  }

  /**
   * Called during APPROVAL state from transcription or a timer.
   * "Info" → show command (handled inline in transcription routing below).
   * "Ja"   → allow-once
   * "Nein" → deny
   */
  private async resolveApproval(decision: "allow-once" | "deny"): Promise<void> {
    if (!this.pendingApproval) return;
    this.clearTimer("approval");

    const approval = this.pendingApproval;
    this.pendingApproval = null;

    try {
      await this.client.sendApprovalDecision({
        id: approval.id,
        decision,
        sessionKey: this.client.sessionKey,
      });
    } catch (err) {
      console.error("[mentra-g2] Failed to send approval decision:", err);
    }

    const restored = this.stateBeforeApproval;
    this.stateBeforeApproval = "IDLE";

    // Restore to the state that was frozen.
    if (restored === "PROCESSING") {
      this.transition("PROCESSING");
      this.startSpinner();
    } else if (restored === "LISTENING") {
      await this.gotoListening();
    } else {
      await this.gotoIdle();
    }
  }

  // ── Transcription routing during APPROVAL ─────────────────────────────────────

  // We override onTranscription to add APPROVAL handling on top of the
  // main switch. This is done by monkey-patching the call site instead of
  // duplicating the whole switch.
  // NOTE: onTranscription already returns early for APPROVAL.
  // We handle APPROVAL keywords here via a separate path registered in
  // onAppSession to keep the state machine clean.
  private handleApprovalTranscription(lower: string): void {
    if (this.state !== "APPROVAL" || !this.pendingApproval) return;

    if (lower.includes("info")) {
      void this.display(`[A] ${this.pendingApproval.command}?`);
      // Revert to [A] display after 6s.
      setTimeout(() => {
        if (this.state === "APPROVAL") void this.display("[A]");
      }, 6_000);
      return;
    }

    if (lower.includes("ja") && !lower.includes("nein")) {
      void this.resolveApproval("allow-once");
      return;
    }

    if (lower.includes("nein")) {
      void this.resolveApproval("deny");
      return;
    }
  }

  // ── SDK lifecycle override — wire up APPROVAL transcription routing ───────────

  protected override async onAppSession(
    session: AppSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    console.log(`[mentra-g2] AppSession started: ${sessionId}`);
    this.session = session;
    this.client.resetAppSession();
    this.hardReset();

    session.events.onTranscription((data) => {
      const lower = (data.text ?? "").toLowerCase().trim();
      const isFinal = data.isFinal ?? true;

      // APPROVAL keywords are handled exclusively here.
      if (this.state === "APPROVAL") {
        if (isFinal) this.handleApprovalTranscription(lower);
        return;
      }

      this.onTranscription(data.text ?? "", isFinal);
    });

    this.display("Mentra bereit");
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private hasGreeting(lower: string): boolean {
    return GREETING_WORDS.some((g) => lower.includes(g));
  }

  private containsMentra(lower: string): boolean {
    return lower.includes("mentra");
  }

  /** Returns the longest matching greeting word, or "" if none found. */
  private extractGreeting(lower: string): string {
    for (const g of GREETING_WORDS) {
      if (lower.includes(g)) return g;
    }
    return "";
  }

  /**
   * Given "hey mentra was ist 2+2", returns "was ist 2+2".
   * Strips leading punctuation/whitespace.
   */
  private extractAfterMentra(lower: string, original: string): string {
    const idx = lower.indexOf("mentra");
    if (idx === -1) return "";
    const raw = original.slice(idx + "mentra".length);
    return raw.replace(/^[,.:!?\s]+/, "").trim();
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const app = new MentraG2();
app.start();
