/**
 * tpa-server.ts — läuft als eigener Bun-Prozess, gestartet vom OpenClaw Plugin.
 * Kommuniziert mit dem Parent via HTTP-IPC (POST /dispatch).
 * Empfängt Approval-Anfragen vom Parent via Control-Server (POST /approval).
 */
import { TpaServer } from "@mentra/sdk";
import type { TpaSession } from "@mentra/sdk";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const IPC_URL = `http://127.0.0.1:${process.env.IPC_PORT}`;
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT ?? "0", 10);
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
  APPROVAL: 10_000,
  APPROVAL_INFO_EXTEND: 5_000,
  APPROVAL_RESPONSE_BONUS: 3_000,
} as const;

const MAX_FOLLOW_UPS = 10;

// ── Types ────────────────────────────────────────────────────────────────────

type MainState = "IDLE" | "TRIGGERED" | "LISTENING" | "PROCESSING" | "APPROVING";
type AppState = MainState;

// ── TpaServer ─────────────────────────────────────────────────────────────────

class MentraApp extends TpaServer {
  private state: AppState = "IDLE";
  private session: TpaSession | null = null;
  private promptAccumulator = "";
  private greetingWord = "";
  private followUpCount = 0;
  private activeRequestId: string | null = null;
  private autoApproval = false;

  // Approval
  private approvalResolve: ((decision: "approved" | "denied") => void) | null = null;
  private approvalCommand = "";
  private approvalInfo = "";

  // Pending AI response that arrived while approval was active
  private pendingResponse: { text: string; displayMs: number } | null = null;
  // Track when TRIGGERED started and what text is showing (for remaining time calc)
  private triggeredAt = 0;
  private lastResponseText = "";

  private timers: {
    silence?: ReturnType<typeof setTimeout>;
    trigger?: ReturnType<typeof setTimeout>;
    postResponse?: ReturnType<typeof setTimeout>;
    followUp?: ReturnType<typeof setTimeout>;
    approval?: ReturnType<typeof setTimeout>;
  } = {};
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;

  constructor() {
    super({ packageName: PACKAGE_NAME, apiKey: API_KEY, port: SERVER_PORT });
  }

  protected async onSession(session: TpaSession, _sid: string, _uid: string): Promise<void> {
    this.session = session;
    this.hardReset();

    this.autoApproval = session.settings.get<boolean>("auto_approval", false);
    session.settings.onValueChange("auto_approval", (val: boolean) => {
      this.autoApproval = val;
      console.log(`[mentra] auto_approval -> ${val}`);
    });

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
    this.pendingResponse = null;
    this.lastResponseText = "";
    this.triggeredAt = 0;
    if (this.approvalResolve) { this.approvalResolve("denied"); this.approvalResolve = null; }
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
    this.pendingResponse = null;
    this.lastResponseText = "";
    this.transition("IDLE");
    this.display("");
  }

  private capitalize(s: string): string {
    return s.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  private gotoTriggered(greeting: string): void {
    this.clearTimer("postResponse");
    this.clearTimer("silence");
    this.clearTimer("followUp");
    this.stopSpinner();
    this.promptAccumulator = "";
    this.greetingWord = greeting;
    this.transition("TRIGGERED");
    this.display(this.capitalize(greeting));
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
    this.display(initialPrompt ? `"${initialPrompt}"` : (headerText || "..."));
    if (followUpTimeout > 0) {
      this.timers.followUp = setTimeout(() => {
        if (this.state === "LISTENING" && this.promptAccumulator === "") this.gotoIdle();
      }, followUpTimeout);
    }
    // Only start silence timer if we already have content — otherwise wait for first speech
    if (initialPrompt) this.resetSilenceTimer();
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

  private gotoApproving(command: string, info: string): void {
    // If we're currently showing an AI response, save it with remaining time + bonus
    if (this.state === "TRIGGERED" && this.lastResponseText) {
      const elapsed = Date.now() - this.triggeredAt;
      const remaining = Math.max(0, MS.POST_RESPONSE - elapsed);
      this.pendingResponse = { text: this.lastResponseText, displayMs: remaining + MS.APPROVAL_RESPONSE_BONUS };
    }

    this.clearTimer("silence");
    this.clearTimer("followUp");
    this.clearTimer("trigger");
    this.clearTimer("postResponse");
    this.stopSpinner();
    this.approvalCommand = command;
    this.approvalInfo = info;
    this.transition("APPROVING");
    this.display("[A] Freigabe? Ja / Nein / Info");
    this.clearTimer("approval");
    this.timers.approval = setTimeout(() => {
      if (this.state === "APPROVING") {
        console.log("[mentra] approval timeout -> denied");
        this.resolveCurrentApproval("denied");
      }
    }, MS.APPROVAL);
  }

  private resolveCurrentApproval(decision: "approved" | "denied"): void {
    this.clearTimer("approval");
    const resolve = this.approvalResolve;
    this.approvalResolve = null;

    // If an AI response arrived while we were approving, show it now
    if (this.pendingResponse) {
      const { text, displayMs } = this.pendingResponse;
      this.pendingResponse = null;
      this.activeRequestId = null;
      this.stopSpinner();
      this.lastResponseText = text;
      this.triggeredAt = Date.now();
      this.display(text);
      this.transition("TRIGGERED");
      this.timers.postResponse = setTimeout(() => {
        if (this.state === "TRIGGERED") this.gotoIdle();
      }, displayMs);
    } else if (this.activeRequestId) {
      // Still waiting for AI response — go back to spinner
      this.transition("PROCESSING");
      this.startSpinner();
    } else {
      this.gotoIdle();
    }

    resolve?.(decision);
  }

  private resetSilenceTimer(): void {
    this.clearTimer("silence");
    this.timers.silence = setTimeout(() => { if (this.state === "LISTENING") this.gotoProcessing(); }, MS.SILENCE);
  }

  // ── Approval entry point (called from control server) ─────────────────────────

  public async handleApprovalRequest(command: string, info: string): Promise<"approved" | "denied"> {
    if (this.autoApproval) {
      console.log(`[mentra] auto-approve: ${command}`);
      return "approved";
    }
    return new Promise<"approved" | "denied">((resolve) => {
      if (this.approvalResolve) { this.approvalResolve("denied"); }
      this.approvalResolve = resolve;
      this.gotoApproving(command, info);
    });
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
          this.display(`"${this.promptAccumulator}"`);
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
      case "APPROVING":
        // No live text display — only act on final keywords
        if (isFinal) this.handleApproving(lower);
        break;
    }
  }

  private handleApproving(lower: string): void {
    const isJa = lower.includes("ja") || lower.includes("yup") || lower.includes("yes") || lower.includes("jap");
    const isNein = /\bnein\b|\bnö\b|\bne\b|\bno\b/.test(lower) || lower.includes("ablehnen");
    const isInfo = lower.includes("info") || lower.includes("details") || lower.includes("was ist");

    if (isJa) {
      this.resolveCurrentApproval("approved");
    } else if (isNein) {
      this.resolveCurrentApproval("denied");
    } else if (isInfo) {
      this.clearTimer("approval");
      const detail = this.approvalInfo || this.approvalCommand || "Keine Details";
      this.display(`[A] ${detail}`);
      this.timers.approval = setTimeout(() => {
        if (this.state === "APPROVING") this.resolveCurrentApproval("denied");
      }, MS.APPROVAL_INFO_EXTEND);
    }
    // All other speech silently ignored
  }

  private handleIdle(lower: string, original: string): void {
    const greeting = this.extractGreeting(lower);
    if (!greeting) return;
    if (lower.includes("mentra")) {
      const after = original.slice(original.toLowerCase().indexOf("mentra") + 6).replace(/^[,.:!?\s]+/, "").trim();
      this.gotoListening(after, `${this.capitalize(greeting)}, Mentra`);
    } else {
      this.gotoTriggered(greeting);
    }
  }

  private handleTriggered(lower: string): void {
    if (lower.includes("mentra")) { this.gotoListening("", `${this.capitalize(this.greetingWord)}, Mentra`); return; }
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
        signal: AbortSignal.timeout(120_000),
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
    // If approval is active, queue the response for after resolution
    if (this.state === "APPROVING") {
      this.pendingResponse = { text, displayMs: MS.POST_RESPONSE + MS.APPROVAL_RESPONSE_BONUS };
      return;
    }

    this.activeRequestId = null;
    this.stopSpinner();

    // Empty response — go to idle, don't leave display in stale state
    if (!text) { this.gotoIdle(); return; }

    this.display(text);

    if (text.trimEnd().endsWith("?") && this.followUpCount < MAX_FOLLOW_UPS) {
      this.followUpCount++;
      this.gotoListening("", "...", MS.FOLLOW_UP_INITIAL);
    } else {
      this.followUpCount = 0;
      this.lastResponseText = text;
      this.triggeredAt = Date.now();
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

// Control server: receives approval requests from parent process (channel.ts)
if (CONTROL_PORT > 0) {
  const controlServer = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/approval") {
      res.writeHead(404); res.end(); return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const { command, info } = JSON.parse(Buffer.concat(chunks).toString()) as { command: string; info: string };
      const decision = await app.handleApprovalRequest(command, info);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision }));
    } catch (err) {
      console.error("[mentra] control error:", err);
      res.writeHead(500); res.end();
    }
  });
  controlServer.listen(CONTROL_PORT, "127.0.0.1", () => {
    console.log(`[mentra-child] Control server on port ${CONTROL_PORT}`);
  });
}

await app.start();
console.log(`[mentra-child] TpaServer started on port ${SERVER_PORT}`);
