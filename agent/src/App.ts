import { watchFile } from "fs-extra";
import { Agent } from "./Agent";
import { AgentConfigRepository } from "./AgentConfigRepository";
import { AgentNote } from "./AgentNote";
import { Config } from "./Config";
import { GitEnvironment } from "./GitEnvironment";
import { OTelInit, OTelLogger, OTelTracer } from "./OTelContext";
import { PlannerClient } from "./PlannerClient";
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

  // Sync the agent config repository (skills, configuration files, resources)
  const agentConfigRepository = new AgentConfigRepository(config);
  if (agentConfigRepository.isEnabled()) {
    // Fail fast when the configured repository cannot be cloned: the agent
    // would otherwise run with missing skills or configuration.
    try {
      await agentConfigRepository.sync();
    } catch (error) {
      logger.error("Agent config repository sync failed", error as Error);
      process.exit(1);
    }
    // Refresh the local copy periodically; a failed refresh keeps the last
    // synced copy and is logged, but never stops the agent.
    const configSyncTimer = setInterval(() => {
      void agentConfigRepository.sync().catch((error: Error) => {
        logger.error(
          "Agent config repository refresh failed (keeping the last synced copy)",
          error,
        );
      });
    }, config.AGENT_CONFIG_SYNC_INTERVAL * 1000);
    configSyncTimer.unref();
  } else {
    logger.info("Agent config repository not configured");
  }

  // Qoder client shared by the authentication check and the agent note
  const qoderClient = new QoderClient(config);

  // Check Qoder authentication
  if (config.QODER_AUTH_CHECK === "true" || config.QODER_AUTH_CHECK === "1") {
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

  // Agent note: a single Planner note named after the agent, regularly
  // refreshed with LLM-generated content. At the end of the startup the
  // note is checked and created when missing; the content is then refreshed
  // on the configured interval.
  const agentNote = new AgentNote(
    config,
    new PlannerClient(config),
    qoderClient,
  );
  if (agentNote.isEnabled()) {
    const updateAgentNote = () => {
      void agentNote.update().catch((error: Error) => {
        logger.error("Agent note update failed (will retry on schedule)", error);
      });
    };
    void agentNote.ensureNote().catch((error: Error) => {
      logger.error(
        "Agent note startup check failed (will retry on schedule)",
        error,
      );
    });
    const agentNoteTimer = setInterval(
      updateAgentNote,
      config.AGENT_NOTE_INTERVAL * 1000,
    );
    agentNoteTimer.unref();
  } else {
    logger.info("Agent note not configured");
  }

  const shutdown = () => {
    logger.info("Shutting down");
    agent.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
});
