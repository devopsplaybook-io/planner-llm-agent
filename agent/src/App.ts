import { watchFile } from "fs-extra";
import { Agent } from "./Agent";
import { Config } from "./Config";
import { OTelInit, OTelLogger, OTelTracer } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("app");

logger.info("====== Starting planner-llm-agent ======");

Promise.resolve().then(async () => {
  //
  const config = new Config();
  await config.reload();
  watchFile(config.CONFIG_FILE, () => {
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    config.reload();
  });

  // OpenTelemetry
  OTelInit(config);

  const span = OTelTracer().startSpan("init");
  span.end();

  // Agent
  const agent = new Agent(config);
  agent.start();

  const shutdown = () => {
    logger.info("Shutting down");
    agent.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
});
