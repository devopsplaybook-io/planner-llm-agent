import {
  StandardLogger,
  StandardMeter,
  StandardTracer,
} from "@devopsplaybook.io/otel-utils";
import { Config } from "./Config";

const otelLogger = new StandardLogger();
let otelTracer: StandardTracer;
let otelMeter: StandardMeter;

export function OTelInit(config: Config): void {
  otelLogger.initOTel(config);
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
