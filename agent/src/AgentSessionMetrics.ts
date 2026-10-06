import type { StandardMeter } from "@devopsplaybook.io/otel-utils";
import { OTelMeter } from "./OTelContext";

// One agent session = one task execution (one CLI process).
export interface AgentSessionRecord {
  agent: string;
  model: string;
  durationMs: number;
  status: "success" | "error";
}

// Instrument types derived from the meter factory: the agent has no direct
// @opentelemetry/api dependency (same trick as Agent.ts).
type Histogram = ReturnType<ReturnType<typeof OTelMeter>["createHistogram"]>;

// OpenTelemetry metrics of the agent sessions (one data point per task
// execution). The metrics are silently disabled when OpenTelemetry is not
// initialized (e.g. in tests) and recording never fails a task.
export class AgentSessionMetrics {
  private sessionDuration: Histogram | null = null;

  constructor(meterProvider?: StandardMeter) {
    try {
      const meter = meterProvider ?? OTelMeter();
      this.sessionDuration = meter.createHistogram("session.duration", {
        unprefixed: true,
      });
    } catch {
      // OpenTelemetry not initialized: the metrics stay disabled.
    }
  }

  // Best-effort: a metrics failure must never fail a task.
  public record(session: AgentSessionRecord): void {
    try {
      this.sessionDuration?.record(session.durationMs / 1000, {
        agent: session.agent,
        model: session.model,
        status: session.status,
      });
    } catch {
      // Best-effort: metrics are diagnostics only.
    }
  }
}
