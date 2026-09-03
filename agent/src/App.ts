import { watchFile } from "fs-extra";
import { Agent } from "./Agent";
import { Config } from "./Config";
import { GitEnvironment } from "./GitEnvironment";
import { OTelInit, OTelLogger, OTelTracer } from "./OTelContext";
import { QoderClient } from "./QoderClient";

const logger = OTelLogger().createModuleLogger("app");

logger.info("====== Starting planner-llm-agent ======");

Promise.resolve().then(async () => {
  //
  const config = new Config();
  try {
    await config.reload();
  } catch (error) {
    logger.error(
      `Failed to load configuration file '${config.CONFIG_FILE}'`,
      error as Error,
    );
    process.exit(1);
  }

  // Check the configuration requirements
  const validationErrors = config.validate();
  if (validationErrors.length > 0) {
    logger.error("Missing or invalid configuration:");
    for (const validationError of validationErrors) {
      logger.error(`  - ${validationError}`);
    }
    process.exit(1);
  }

  watchFile(config.CONFIG_FILE, () => {
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    config.reload().catch((error: Error) => {
      logger.error(
        `Failed to reload configuration file '${config.CONFIG_FILE}'`,
        error,
      );
    });
  });

  // OpenTelemetry
  try {
    OTelInit(config);
  } catch (error) {
    logger.error("Failed to initialize OpenTelemetry", error as Error);
    process.exit(1);
  }

  const span = OTelTracer().startSpan("init");
  span.end();

  // Prepare the Git and GitHub environment (authentication, signing keys)
  const gitEnvironment = new GitEnvironment(config);
  try {
    await gitEnvironment.prepare();
  } catch (error) {
    logger.error("Git environment preparation failed", error as Error);
    process.exit(1);
  }

  // Check Qoder authentication
  if (config.QODER_AUTH_CHECK === "true" || config.QODER_AUTH_CHECK === "1") {
    const qoderClient = new QoderClient(config);
    try {
      await qoderClient.checkAuthentication();
      logger.info("Qoder authentication verified");
    } catch (error) {
      logger.error("Qoder authentication check failed", error as Error);
      logger.error(
        "Ensure QODER_PERSONAL_ACCESS_TOKEN is set to a valid Personal Access Token (https://qoder.com/account/integrations)",
      );
      process.exit(1);
    }
  } else {
    logger.info("Qoder authentication check disabled");
  }

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
