import type { StandardMeter } from "@devopsplaybook.io/otel-utils";
import { AgentSessionMetrics, AgentSessionRecord } from "./AgentSessionMetrics";

// Fake meter provider recording the created instruments.
function createMeterMock() {
  const counters: Record<string, { add: jest.Mock }> = {};
  const histograms: Record<string, { record: jest.Mock }> = {};
  const meterProvider = {
    createCounter: jest.fn((key: string) => {
      counters[key] = { add: jest.fn() };
      return counters[key];
    }),
    createHistogram: jest.fn((key: string) => {
      histograms[key] = { record: jest.fn() };
      return histograms[key];
    }),
  };
  return { meterProvider, counters, histograms };
}

const buildSession = (
  overrides: Partial<AgentSessionRecord> = {},
): AgentSessionRecord => ({
  agent: "qoder",
  model: "claude-opus-4-1",
  durationMs: 12345,
  status: "success",
  tokens: null,
  ...overrides,
});

describe("AgentSessionMetrics", () => {
  it("creates the session instruments on the meter provider", () => {
    const { meterProvider } = createMeterMock();
    new AgentSessionMetrics(meterProvider as unknown as StandardMeter);

    expect(meterProvider.createCounter).toHaveBeenCalledWith(
      "agent.session.count",
    );
    expect(meterProvider.createCounter).toHaveBeenCalledWith(
      "agent.session.tokens",
    );
    expect(meterProvider.createHistogram).toHaveBeenCalledWith(
      "agent.session.duration",
    );
  });

  it("records the count, the duration in seconds and the token types", () => {
    const { meterProvider, counters, histograms } = createMeterMock();
    const metrics = new AgentSessionMetrics(
      meterProvider as unknown as StandardMeter,
    );

    metrics.record(
      buildSession({
        tokens: { input: 100, output: 40, cacheRead: 900, cacheWrite: 30 },
      }),
    );

    const attributes = {
      agent: "qoder",
      model: "claude-opus-4-1",
      status: "success",
    };
    expect(counters["agent.session.count"].add).toHaveBeenCalledWith(
      1,
      attributes,
    );
    expect(histograms["agent.session.duration"].record).toHaveBeenCalledWith(
      12.345,
      attributes,
    );
    expect(counters["agent.session.tokens"].add.mock.calls).toEqual([
      [100, { agent: "qoder", model: "claude-opus-4-1", type: "input" }],
      [40, { agent: "qoder", model: "claude-opus-4-1", type: "output" }],
      [900, { agent: "qoder", model: "claude-opus-4-1", type: "cache_read" }],
      [30, { agent: "qoder", model: "claude-opus-4-1", type: "cache_write" }],
    ]);
  });

  it("only records the token types reported by the CLI", () => {
    const { meterProvider, counters } = createMeterMock();
    const metrics = new AgentSessionMetrics(
      meterProvider as unknown as StandardMeter,
    );

    metrics.record(buildSession({ tokens: { input: 100 } }));

    expect(counters["agent.session.tokens"].add.mock.calls).toEqual([
      [100, { agent: "qoder", model: "claude-opus-4-1", type: "input" }],
    ]);
  });

  it("records error sessions without token data", () => {
    const { meterProvider, counters, histograms } = createMeterMock();
    const metrics = new AgentSessionMetrics(
      meterProvider as unknown as StandardMeter,
    );

    metrics.record(buildSession({ status: "error" }));

    expect(counters["agent.session.count"].add).toHaveBeenCalledWith(1, {
      agent: "qoder",
      model: "claude-opus-4-1",
      status: "error",
    });
    expect(histograms["agent.session.duration"].record).toHaveBeenCalledWith(
      12.345,
      { agent: "qoder", model: "claude-opus-4-1", status: "error" },
    );
    expect(counters["agent.session.tokens"].add).not.toHaveBeenCalled();
  });

  it("stays disabled when the meter provider fails", () => {
    const meterProvider = {
      createCounter: jest.fn(() => {
        throw new Error("no meter");
      }),
    };
    const metrics = new AgentSessionMetrics(
      meterProvider as unknown as StandardMeter,
    );

    expect(() => metrics.record(buildSession())).not.toThrow();
  });

  it("stays disabled when OpenTelemetry is not initialized", () => {
    // Without an injected provider the helper falls back to the module
    // meter, which is uninitialized here.
    const metrics = new AgentSessionMetrics();

    expect(() => metrics.record(buildSession())).not.toThrow();
  });
});
