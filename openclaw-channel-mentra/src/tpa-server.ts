/**
 * tpa-server.ts — läuft als eigener Bun-Prozess, gestartet vom OpenClaw Plugin.
 * Kommuniziert mit dem Parent via HTTP-IPC (POST /dispatch).
 */
import { TpaServer } from "@mentra/sdk";
import type { TpaSession } from "@mentra/sdk";
import { randomUUID } from "node:crypto";

const IPC_URL = `http://127.0.0.1:${process.env.IPC_PORT}`;
const PACKAGE_NAME = process.env.MENTRA_PACKAGE_NAME!;
const API_KEY = process.env.MENTRA_API_KEY!;
const SERVER_PORT = parseInt(process.env.MENTRA_SERVER_PORT ?? "7010", 10);
const ACCOUNT_ID = process.env.MENTRA_ACCOUNT_ID ?? "default";

// ── Constants ────────────────────────────────────────────────────────────────

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
  SPINNER: 120,
} as const;

const MAX_FOLLOW_UPS = 10;

// ── Types ────────────────────────────────────────────────────────────────────

type MainState = "IDLE" | "TRIGGERED" | "LISTENING" | "PROCESSING";
type AppState = MainState;

// ── TpaServer ─────────────────────────────────────────────────────────────────

class MentraApp extends TpaServer {
  private state: AppState = "IDLE";
  private session: TpaSession | null = null;
  private promptAccumulator = "";
  private greetingWord = "";
  private followUpCount = 0;
  private activeRequestId: string | null = null;

  private timers: {
    silence?: ReturnType<typeof setTimeout>;
    trigger?: ReturnType<typeof setTimeout>;
    postResponse?: ReturnType<typeof setTimeout>;
    followUp?: ReturnType<typeof setTimeout>;
  } = {};
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;

  constructor() {
    super({ packageName: PACKAGE_NAME, apiKey: API_KEY, port: SERVER_PORT });
  }

  protected async onSession(session: TpaSession, _sid: string, _uid: string): Promise<void> {
    this.session = session;
    this.hardReset();

    session.events.onTranscription((data) => {
      this.onTranscription(data.text ?? "", data.isFinal ?? true);
    });

    session.events.onDisconnected(() => {
      this.hardReset();
      this.session = null;
    });

    this.display("");
  }

  // ── Display ──────────────────────────────────────────────────────────────────

  private display(text: string): void {
    if (!this.session) return;
    try { this.session.layouts.showTextWall(text); } catch (_) {}
  }

  private startSpinner(): void {
    this.spinnerFrame = 0;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_FRAMES.length;
      this.display(BRAILLE_FRAMES[this.spinnerFrame]);
    }, MS.SPINNER);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer !== null) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
  }

  // ── Timers ────────────────────────────────────────────────────────────────────

  private clearTimer(name: keyof typeof this.timers): void {
    if (this.timers[name] !== undefined) { clearTimeout(this.timers[name]!); delete this.timers[name]; }
  }

  private clearAllTimers(): void {
    for (const k of Object.keys(this.timers) as (keyof typeof this.timers)[]) this.clearTimer(k);
  }

  private hardReset(): void {
    this.clearAllTimers();
    this.stopSpinner();
    this.state = "IDLE";
    this.promptAccumulator = "";
    this.greetingWord = "";
    this.followUpCount = 0;
    this.activeRequestId = null;
  }

  // ── States ────────────────────────────────────────────────────────────────────

  private transition(next: AppState): void {
    console.log(`[mentra] ${this.state} -> ${next}`);
    this.state = next;
  }

  private gotoIdle(): void {
    this.clearAllTimers();
    this.stopSpinner();
    this.promptAccumulator = "";
    this.greetingWord = "";
    this.followUpCount = 0;
    this.transition("IDLE");
    this.display("");
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
    this.timers.trigger = setTimeout(() => { if (this.state === "TRIGGERED") this.gotoIdle(); }, MS.TRIGGERED_TIMEOUT);
  }

  private gotoListening(initialPrompt = "", headerText = "", followUpTimeout = 0): void {
    this.clearTimer("trigger");
    this.clearTimer("postResponse");
    this.clearTimer("followUp");
    this.stopSpinner();
    this.promptAccumulator = initialPrompt;
    this.transition("LISTENING");
    this.display(initialPrompt ? `"${initialPrompt}" ...` : (headerText || "..."));
    if (followUpTimeout > 0) {
      this.timers.followUp = setTimeout(() => {
        if (this.state === "LISTENING" && this.promptAccumulator === "") this.gotoIdle();
      }, followUpTimeout);
    }
    this.resetSilenceTimer();
  }

  private gotoProcessing(): void {
    this.clearTimer("silence");
    this.clearTimer("followUp");
    this.transition("PROCESSING");
    const prompt = this.promptAccumulator.trim();
    this.promptAccumulator = "";
    this.display(`"${prompt}"`);
    this.startSpinner();
    if (!prompt) { this.gotoIdle(); return; }
    const requestId = randomUUID();
    this.activeRequestId = requestId;
    void this.dispatchPrompt(prompt, requestId);
  }

  private resetSilenceTimer(): void {
    this.clearTimer("silence");
    this.timers.silence = setTimeout(() => { if (this.state === "LISTENING") this.gotoProcessing(); }, MS.SILENCE);
  }

  // ── Transcription ─────────────────────────────────────────────────────────────

  private onTranscription(text: string, isFinal: boolean): void {
    const lower = text.toLowerCase().trim();
    if (!lower) return;

    switch (this.state) {
      case "IDLE":
        if (isFinal) this.handleIdle(lower, text.trim());
        break;
      case "TRIGGERED":
        if (isFinal) this.handleTriggered(lower);
        break;
      case "LISTENING":
        this.resetSilenceTimer();
        this.clearTimer("followUp");
        if (isFinal) {
          this.promptAccumulator += (this.promptAccumulator ? " " : "") + text.trim();
          this.display(`"${this.promptAccumulator}" ...`);
        } else {
          const preview = this.promptAccumulator ? `${this.promptAccumulator} ${text.trim()}` : text.trim();
          this.display(`"${preview}"`);
        }
        break;
      case "PROCESSING":
        if (isFinal && lower.includes("mentra") && this.hasGreeting(lower)) {
          this.activeRequestId = null;
          this.gotoTriggered(this.extractGreeting(lower));
        }
        break;
    }
  }

  private handleIdle(lower: string, original: string): void {
    const greeting = this.extractGreeting(lower);
    if (!greeting) return;
    if (lower.includes("mentra")) {
      const after = original.slice(original.toLowerCase().indexOf("mentra") + 6).replace(/^[,.:!?\s]+/, "").trim();
      this.gotoListening(after);
    } else {
      this.gotoTriggered(greeting);
    }
  }

  private handleTriggered(lower: string): void {
    if (lower.includes("mentra")) { this.gotoListening("", `${this.greetingWord} mentra`); return; }
    const greeting = this.extractGreeting(lower);
    if (greeting) { this.gotoTriggered(greeting); return; }
    this.gotoIdle();
  }

  // ── Dispatch via IPC ──────────────────────────────────────────────────────────

  private async dispatchPrompt(prompt: string, requestId: string): Promise<void> {
    try {
      const res = await fetch(`${IPC_URL}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, sessionKey: randomUUID(), accountId: ACCOUNT_ID }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) throw new Error(`IPC error ${res.status}`);
      const { text } = await res.json() as { text: string };

      if (this.activeRequestId !== requestId) return;
      this.handleAgentResponse(text || "");
    } catch (err) {
      console.error("[mentra] dispatch error:", err);
      if (this.activeRequestId === requestId) this.gotoIdle();
    }
  }

  private handleAgentResponse(text: string): void {
    this.activeRequestId = null;
    this.stopSpinner();
    if (text) this.display(text);

    if (text.trimEnd().endsWith("?") && this.followUpCount < MAX_FOLLOW_UPS) {
      this.followUpCount++;
      this.gotoListening("", "...", MS.FOLLOW_UP_INITIAL);
    } else {
      this.followUpCount = 0;
      this.transition("TRIGGERED");
      this.timers.postResponse = setTimeout(() => { if (this.state === "TRIGGERED") this.gotoIdle(); }, MS.POST_RESPONSE);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private hasGreeting(lower: string): boolean {
    return GREETING_WORDS.some((g) => lower.includes(g));
  }

  private extractGreeting(lower: string): string {
    for (const g of GREETING_WORDS) { if (lower.includes(g)) return g; }
    return "";
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

const app = new MentraApp();
await app.start();
console.log(`[mentra-child] TpaServer started on port ${SERVER_PORT}`);
