import * as fse from "fs-extra";
import { AgentActionsConfig, parseAgentActions } from "./AgentActions";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("agent-actions");

// Stat polling interval of the watcher, same as the default interval of
// fs.watchFile and the configuration file watch in App.ts.
const WATCH_INTERVAL_MS = 5000;

/**
 * Owns the agent actions configuration and keeps it up to date while the
 * agent runs.
 *
 * The configuration is exposed as one stable object (`config`) whose fields
 * are updated in place: the consumers (Agent, CLI clients, AgentNote) keep
 * the reference passed at startup and observe the new values on their next
 * read, so a running task keeps the model, instruction and timeout resolved
 * when it started and the next task picks use the new configuration.
 *
 * Unlike the startup load, a runtime reload never fails the agent: an
 * invalid content or a missing file is logged and the last valid
 * configuration is kept, so a transient state (e.g. the kubelet swap of a
 * ConfigMap volume) or a typo never disables the agent. Each change is
 * applied in one synchronous step, so a partially updated configuration is
 * never observed.
 */
export class AgentActionsManager {
  public readonly filePath: string;
  public readonly watchIntervalMs: number;
  private readonly fallbackAgent: string;

  /** The live configuration, updated in place by every successful reload. */
  public readonly config: AgentActionsConfig = {
    defaultAgent: "qoder",
    defaultModel: "",
    defaultTimeout: null,
    actions: [],
  };

  private lastContent: string | null = null;
  private missing = false;
  private reloading = false;
  private reloadPending = false;
  private watchListener: (() => void) | null = null;

  constructor(
    filePath: string,
    watchIntervalMs: number = WATCH_INTERVAL_MS,
    fallbackAgent: string = "qoder",
  ) {
    this.filePath = filePath;
    this.watchIntervalMs = watchIntervalMs;
    this.fallbackAgent = fallbackAgent;
    this.config.defaultAgent = fallbackAgent;
  }

  /**
   * Loads the file at startup: throws when the file exists but is invalid,
   * so the caller can fail fast. Returns the current configuration, or null
   * when the file does not exist (the agent then processes no task, and the
   * watcher can still apply a file created later).
   */
  public async load(): Promise<AgentActionsConfig | null> {
    if (!(await fse.pathExists(this.filePath))) {
      this.apply({
        defaultAgent: this.fallbackAgent,
        defaultModel: "",
        defaultTimeout: null,
        actions: [],
      });
      this.lastContent = null;
      this.missing = true;
      return null;
    }
    const content = await fse.readFile(this.filePath, "utf8");
    const parsed = parseAgentActions(content);
    this.apply(parsed);
    this.lastContent = content;
    this.missing = false;
    return this.config;
  }

  /**
   * Watches the file and reloads it on every change. Safe to call when the
   * file does not exist yet: the watcher also detects its creation.
   */
  public start(): void {
    if (this.watchListener !== null) {
      return;
    }
    this.watchListener = () => {
      void this.reload();
    };
    fse.watchFile(
      this.filePath,
      { interval: this.watchIntervalMs },
      this.watchListener,
    );
  }

  /** Stops watching the file. */
  public stop(): void {
    if (this.watchListener === null) {
      return;
    }
    fse.unwatchFile(this.filePath, this.watchListener);
    this.watchListener = null;
  }

  /**
   * Reloads the file and applies the changes in place. A no-op when the
   * content did not change; never throws.
   */
  public async reload(): Promise<void> {
    if (this.reloading) {
      // Serialize overlapping stat events: the pending reload re-reads the
      // latest content, so a slow read never applies a stale content.
      this.reloadPending = true;
      return;
    }
    this.reloading = true;
    try {
      await this.reloadOnce();
    } finally {
      this.reloading = false;
    }
    if (this.reloadPending) {
      this.reloadPending = false;
      await this.reload();
    }
  }

  private async reloadOnce(): Promise<void> {
    let content: string;
    try {
      content = await fse.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // The file disappeared: keep the last valid configuration and wait
        // for it to come back (logged once per disappearance).
        if (!this.missing) {
          this.missing = true;
          logger.warn(
            `Agent actions file not found at '${this.filePath}' (keeping the last valid configuration)`,
          );
        }
      } else {
        logger.error(
          `Failed to read agent actions file '${this.filePath}' (keeping the last valid configuration)`,
          error as Error,
        );
      }
      return;
    }
    this.missing = false;
    if (content === this.lastContent) {
      // Unchanged content (e.g. an unrelated ConfigMap update): no-op.
      return;
    }
    this.lastContent = content;
    let parsed: AgentActionsConfig;
    try {
      parsed = parseAgentActions(content);
    } catch (error) {
      logger.error(
        `Invalid agent actions configuration file '${this.filePath}' (keeping the last valid configuration): ${(error as Error).message}`,
        error as Error,
      );
      return;
    }
    this.apply(parsed);
    logger.info(
      `Agent actions reloaded from '${this.filePath}' (${parsed.actions.length} action(s))`,
    );
  }

  // Updates the stable configuration object in place (one synchronous step).
  private apply(parsed: AgentActionsConfig): void {
    const defaultAgent = (parsed.defaultAgent || this.fallbackAgent)
      .trim()
      .toLowerCase();
    this.config.defaultAgent = defaultAgent;
    this.config.defaultModel = parsed.defaultModel;
    this.config.defaultTimeout = parsed.defaultTimeout;
    this.config.actions = parsed.actions.map((action) => ({
      ...action,
      agent: (action.agent || defaultAgent).trim().toLowerCase(),
    }));
  }
}
