import * as fse from "fs-extra";
import * as path from "path";
import { watchFile } from "fs-extra";
import { Agent } from "./Agent";
import { AgentActionsManager } from "./AgentActionsManager";
import { AgentConfigRepository } from "./AgentConfigRepository";
import { AgentNote } from "./AgentNote";
import { Config, parseBooleanFlag } from "./Config";
import { FinalizationStore } from "./FinalizationStore";
import { GitEnvironment } from "./GitEnvironment";
import { HotReloadTimers } from "./HotReloadTimers";
import { terminateLiveProcessGroups } from "./CliUtils";
import { OTelInit, OTelLogger, OTelTracer } from "./OTelContext";
import { PlannerClient } from "./PlannerClient";
import { createCliAgent } from "./clients/CliAgentRegistry";
import { prepareCliAgent, type CliAgentClient } from "./clients/CliAgent";

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

  const plainHttpWarning = config.plainHttpWarning();
  if (plainHttpWarning !== null) {
    logger.warn(plainHttpWarning);
  }

  // Touch the heartbeat file early: the Kubernetes probes check its
  // freshness (the polling loop refreshes it every 30 seconds once
  // started, see Agent.startHeartbeat).
  try {
    await fse.ensureDir(config.DATA_DIR);
    await fse.writeFile(
      path.join(config.DATA_DIR, "heartbeat"),
      new Date().toISOString(),
    );
  } catch (error) {
    logger.error("Failed to write the heartbeat file", error as Error);
  }

  // The reloadable timers (agent note, config repository refresh) are
  // created later, once their dependencies exist; the config watcher
  // re-applies them after every successful reload.
  let hotReloadTimers: HotReloadTimers | null = null;
  watchFile(config.CONFIG_FILE, () => {
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    config
      .reload()
      .then(() => hotReloadTimers?.apply())
      .catch((error: Error) => {
        logger.error(
          `Failed to reload configuration file '${config.CONFIG_FILE}'`,
          error,
        );
      });
  });

  // Agent actions: the YAML file binds projects and start statuses to a
  // CLI agent, model, instruction and end status. The format is checked strictly
  // at startup so a misconfiguration fails fast; when the file is missing
  // the agent starts with no action and processes no task. The file is
  // watched at runtime: a change is applied without a restart, keeping the
  // last valid configuration when the new content is invalid.
  const agentActionsManager = new AgentActionsManager(
    config.AGENT_ACTIONS_FILE,
    undefined,
    config.AGENT_CLI,
  );
  let actionsFileFound: boolean;
  try {
    actionsFileFound = (await agentActionsManager.load()) !== null;
  } catch (error) {
    logger.error(
      `Invalid agent actions configuration file '${config.AGENT_ACTIONS_FILE}': ${(error as Error).message}`,
      error as Error,
    );
    process.exit(1);
  }
  if (!actionsFileFound) {
    logger.warn(
      `Agent actions file not found at '${config.AGENT_ACTIONS_FILE}': no task will be processed`,
    );
  } else {
    logger.info(
      `Agent actions loaded from '${config.AGENT_ACTIONS_FILE}' (${agentActionsManager.config.actions.length} action(s))`,
    );
  }
  agentActionsManager.start();

  // OpenTelemetry
  try {
    await OTelInit(config);
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
    // would otherwise run with missing skills or configuration. Enabling
    // the repository from empty stays a startup-only change (it needs the
    // initial clone); the periodic refresh interval is hot-applied below.
    try {
      await agentConfigRepository.sync();
    } catch (error) {
      logger.error("Agent config repository sync failed", error as Error);
      process.exit(1);
    }
  } else {
    logger.info("Agent config repository not configured");
  }

  // Create and validate every CLI agent selected by the default or an
  // action, the fallback agents included: a fallback introduced by a task
  // failure would otherwise be prepared and authenticated for the first
  // time in the middle of that failure.
  const configuredAgents = new Set(
    [
      agentActionsManager.config.defaultAgent || config.AGENT_CLI,
      agentActionsManager.config.defaultFallbackAgent,
      ...agentActionsManager.config.actions.map(
        (action) =>
          action.agent ||
          agentActionsManager.config.defaultAgent ||
          config.AGENT_CLI,
      ),
      ...agentActionsManager.config.actions.map(
        (action) => action.fallbackAgent,
      ),
    ].filter((agentName): agentName is string => Boolean(agentName)),
  );
  const cliAgents = new Map<string, CliAgentClient>();
  try {
    for (const agentName of configuredAgents) {
      cliAgents.set(
        agentName,
        createCliAgent(config, agentActionsManager.config, agentName),
      );
    }
  } catch (error) {
    logger.error((error as Error).message, error as Error);
    process.exit(1);
  }

  // CLI-specific startup preparation, before the authentication checks.
  // Best-effort: a failure must not stop the agent.
  for (const cliAgent of cliAgents.values()) {
    await prepareCliAgent(cliAgent);
  }

  // Check authentication for every CLI agent used by the actions. The
  // documented values are 'true'/'false' ('1'/'0' tolerated).
  if (parseBooleanFlag(config.AGENT_AUTH_CHECK, true)) {
    for (const cliAgent of cliAgents.values()) {
      try {
        await cliAgent.checkAuthentication();
        logger.info(
          `${cliAgent.displayName} authentication verified (CLI: ${cliAgent.name})`,
        );
      } catch (error) {
        logger.error(
          `${cliAgent.displayName} authentication check failed`,
          error as Error,
        );
        logger.error(cliAgent.authHint);
        process.exit(1);
      }
    }
  } else {
    for (const cliAgent of cliAgents.values()) {
      logger.info(`${cliAgent.displayName} authentication check disabled`);
    }
  }

  // Agent
  // Pending finalizations are persisted under DATA_DIR so a crash or rolling
  // restart between the CLI completion and the Planner updates resumes the
  // delivery instead of re-running the CLI. A load failure is logged and the
  // agent starts with an empty store: state I/O must never crash-loop it.
  const finalizationStore = new FinalizationStore({
    dir: path.join(config.DATA_DIR, "finalization"),
  });
  try {
    const { loaded, skipped } = await finalizationStore.load();
    if (loaded > 0) {
      logger.info(
        `Loaded ${loaded} pending finalization record(s) from '${path.join(config.DATA_DIR, "finalization")}'`,
      );
    }
    if (skipped.length > 0) {
      logger.warn(
        `Removed ${skipped.length} invalid pending finalization file(s): ${skipped.join(", ")}`,
      );
    }
  } catch (error) {
    logger.error(
      "Failed to load the pending finalization records (continuing with an empty store)",
      error as Error,
    );
  }
  const agent = new Agent(
    config,
    agentActionsManager.config,
    cliAgents,
    finalizationStore,
  );
  agent.start();

  // Agent note: a single Planner note named after the agent, regularly
  // refreshed with LLM-generated content. The job is created disabled when
  // the note is not configured and the schedule is re-applied on every
  // config reload (see HotReloadTimers).
  const agentNote = new AgentNote(
    config,
    new PlannerClient(config),
    cliAgents.get(agentActionsManager.config.defaultAgent || config.AGENT_CLI)!,
    agentActionsManager.config,
    // Live scheduling state for the note facts: the tasks being processed
    // and the queue behind the capacity budget, read at generation time.
    () => agent.getSchedulingState(),
  );
  if (agentNote.isEnabled()) {
    logger.info("Agent note updates enabled");
  } else {
    logger.info("Agent note not configured");
  }
  hotReloadTimers = new HotReloadTimers({
    config,
    noteRun: () => agentNote.update(),
    configSyncRun: () => agentConfigRepository.sync(),
    configSyncEnabled: agentConfigRepository.isEnabled(),
    onError: (message, error) =>
      logger.error(`${message} (will retry on the next interval)`, error),
    onWarning: (message) => logger.warn(message),
  });
  hotReloadTimers.apply();

  const shutdown = () => {
    logger.info("Shutting down");
    hotReloadTimers?.stop();
    agent.stop();
    // Terminate the CLI process groups spawned by the running tasks so a
    // container stop does not leave coding-agent processes behind; then
    // exit. The hard exit below only guards against a hung termination.
    terminateLiveProcessGroups(10000)
      .catch((error: Error) => {
        logger.error("Failed to terminate the CLI process groups", error);
      })
      .finally(() => {
        process.exit(0);
      });
    setTimeout(() => process.exit(0), 15000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
});
