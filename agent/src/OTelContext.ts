import {
  StandardLogger,
  StandardMeter,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import { Config } from "./Config";

const otelLogger = new StandardLogger();
let otelTracer: StandardTracer;
let otelMeter: StandardMeter;

export async function OTelInit(config: Config): Promise<void> {
  // otel-utils 1.9 made initOTel asynchronous: awaiting it is what makes the
  // log provider ready before the first record is emitted.
  await otelLogger.initOTel(config);
  otelTracer = new StandardTracer(config);
  otelMeter = new StandardMeter(config);
}

export function OTelLogger(): StandardLogger {
  return otelLogger;
}

export function OTelTracer(): StandardTracer {
  return otelTracer;
}

export function OTelMeter(): StandardMeter {
  return otelMeter;
}
