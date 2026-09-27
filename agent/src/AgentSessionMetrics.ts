import type { StandardMeter } from "@devopsplaybook.io/otel-utils";
import { OTelMeter } from "./OTelContext";

// Token usage of one agent session; every type is optional because the
// CLIs report different subsets (Copilot CLI and Codex report none).
export interface AgentSessionTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// One agent session = one task execution (one CLI process).
export interface AgentSessionRecord {
  agent: string;
  model: string;
  durationMs: number;
  status: "success" | "error";
  tokens: AgentSessionTokens | null;
}

// Instrument types derived from the meter factory: the agent has no direct
// @opentelemetry/api dependency (same trick as Agent.ts).
type Counter = ReturnType<ReturnType<typeof OTelMeter>["createCounter"]>;
type Histogram = ReturnType<ReturnType<typeof OTelMeter>["createHistogram"]>;

// OpenTelemetry metrics of the agent sessions (one data point set per task
// execution). The metrics are silently disabled when OpenTelemetry is not
// initialized (e.g. in tests) and recording never fails a task.
export class AgentSessionMetrics {
  private sessionCount: Counter | null = null;
  private sessionDuration: Histogram | null = null;
  private sessionTokens: Counter | null = null;

  constructor(meterProvider?: StandardMeter) {
    try {
      const meter = meterProvider ?? OTelMeter();
      this.sessionCount = meter.createCounter("agent.session.count");
      this.sessionDuration = meter.createHistogram("agent.session.duration");
      this.sessionTokens = meter.createCounter("agent.session.tokens");
    } catch {
      // OpenTelemetry not initialized: the metrics stay disabled.
    }
  }

  // Best-effort: a metrics failure must never fail a task.
  public record(session: AgentSessionRecord): void {
    try {
      const attributes = {
        agent: session.agent,
        model: session.model,
        status: session.status,
      };
      this.sessionCount?.add(1, attributes);
      this.sessionDuration?.record(session.durationMs / 1000, attributes);
      if (session.tokens !== null) {
        this.addToken(session, "input", session.tokens.input);
        this.addToken(session, "output", session.tokens.output);
        this.addToken(session, "cache_read", session.tokens.cacheRead);
        this.addToken(session, "cache_write", session.tokens.cacheWrite);
      }
    } catch {
      // Best-effort: metrics are diagnostics only.
    }
  }

  private addToken(
    session: AgentSessionRecord,
    type: string,
    value?: number,
  ): void {
    if (typeof value === "number" && Number.isFinite(value)) {
      this.sessionTokens?.add(value, {
        agent: session.agent,
        model: session.model,
        type,
      });
    }
  }
}
