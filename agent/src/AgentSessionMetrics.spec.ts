import type { StandardMeter } from "@devopsplaybook.io/otel-utils";
import { AgentSessionMetrics, AgentSessionRecord } from "./AgentSessionMetrics";

// Fake meter provider recording the created instruments.
function createMeterMock() {
  const histograms: Record<string, { record: jest.Mock }> = {};
  const meterProvider = {
    createHistogram: jest.fn((key: string) => {
      histograms[key] = { record: jest.fn() };
      return histograms[key];
    }),
  };
  return { meterProvider, histograms };
}

const buildSession = (
  overrides: Partial<AgentSessionRecord> = {},
): AgentSessionRecord => ({
  agent: "qoder",
  model: "claude-opus-4-1",
  durationMs: 12345,
  status: "success",
  ...overrides,
});

describe("AgentSessionMetrics", () => {
  it("creates the session duration instrument on the meter provider", () => {
    const { meterProvider } = createMeterMock();
    new AgentSessionMetrics(meterProvider as unknown as StandardMeter);

    expect(meterProvider.createHistogram).toHaveBeenCalledWith(
      "session.duration",
    );
  });

  it("records the duration in seconds with the agent, model and status", () => {
    const { meterProvider, histograms } = createMeterMock();
    const metrics = new AgentSessionMetrics(
      meterProvider as unknown as StandardMeter,
    );

    metrics.record(buildSession());

    expect(histograms["session.duration"].record).toHaveBeenCalledWith(12.345, {
      agent: "qoder",
      model: "claude-opus-4-1",
      status: "success",
    });
  });

  it("records error sessions with the error status", () => {
    const { meterProvider, histograms } = createMeterMock();
    const metrics = new AgentSessionMetrics(
      meterProvider as unknown as StandardMeter,
    );

    metrics.record(buildSession({ model: "auto", status: "error" }));

    expect(histograms["session.duration"].record).toHaveBeenCalledWith(12.345, {
      agent: "qoder",
      model: "auto",
      status: "error",
    });
  });

  it("stays disabled when the meter provider fails", () => {
    const meterProvider = {
      createHistogram: jest.fn(() => {
        throw new Error("no meter");
      }),
    };
    const metrics = new AgentSessionMetrics(
      meterProvider as unknown as StandardMeter,
    );

    expect(() => metrics.record(buildSession())).not.toThrow();
  });

  it("does not throw when recording fails after a successful creation", () => {
    const { meterProvider, histograms } = createMeterMock();
    const metrics = new AgentSessionMetrics(
      meterProvider as unknown as StandardMeter,
    );
    histograms["session.duration"].record.mockImplementation(() => {
      throw new Error("export failed");
    });

    expect(() => metrics.record(buildSession())).not.toThrow();
  });

  it("stays disabled when OpenTelemetry is not initialized", () => {
    // Without an injected provider the helper falls back to the module
    // meter, which is uninitialized here.
    const metrics = new AgentSessionMetrics();

    expect(() => metrics.record(buildSession())).not.toThrow();
  });
});
