import {
  Config,
  DEFAULT_AGENT_CONFIG_SYNC_INTERVAL,
  DEFAULT_AGENT_NOTE_INTERVAL,
  MAX_DELAY_SECONDS,
} from "./Config";

export interface ReloadableIntervalOptions {
  // Label used in the log messages (e.g. "Agent note").
  label: string;
  // Interval applied when the configured value is invalid.
  fallbackSeconds: number;
  run: () => Promise<unknown> | unknown;
  onError: (message: string, error: Error) => void;
  onWarning: (message: string) => void;
  // Run once when the timer becomes enabled (startup or a re-enable).
  runImmediatelyOnEnable?: boolean;
}

/**
 * One scheduled job whose interval and enabled state are re-applied on
 * every configuration reload: a changed interval re-arms the timer without
 * a restart, `0` disables it, and a positive interval enables a previously
 * disabled job. An invalid interval falls back to the built-in default
 * (reported once) instead of silently disabling the job. A tick is skipped
 * while the previous run is still in progress, so a slow run never
 * overlaps itself, and a failed run never throws out of the timer.
 */
export class ReloadableInterval {
  private readonly label: string;
  private readonly fallbackSeconds: number;
  private readonly run: () => Promise<unknown> | unknown;
  private readonly onError: (message: string, error: Error) => void;
  private readonly onWarning: (message: string) => void;
  private readonly runImmediatelyOnEnable: boolean;

  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private intervalSeconds = 0;
  private running = false;
  private warnedInvalid = false;

  constructor(options: ReloadableIntervalOptions) {
    this.label = options.label;
    this.fallbackSeconds = options.fallbackSeconds;
    this.run = options.run;
    this.onError = options.onError;
    this.onWarning = options.onWarning;
    this.runImmediatelyOnEnable = options.runImmediatelyOnEnable === true;
  }

  public configure(enabled: boolean, intervalSeconds: number): void {
    const normalized = this.normalize(enabled, intervalSeconds);
    const effectiveEnabled = enabled && normalized > 0;
    const effectiveInterval = effectiveEnabled ? normalized : 0;
    if (
      this.active === effectiveEnabled &&
      this.intervalSeconds === effectiveInterval
    ) {
      return;
    }
    const wasActive = this.active;
    this.clearTimer();
    this.active = effectiveEnabled;
    this.intervalSeconds = effectiveInterval;
    if (!effectiveEnabled) {
      return;
    }
    this.timer = setInterval(
      () => void this.tick(),
      effectiveInterval * 1000,
    );
    this.timer.unref();
    if (!wasActive && this.runImmediatelyOnEnable) {
      void this.tick();
    }
  }

  public stop(): void {
    this.clearTimer();
    this.active = false;
    this.intervalSeconds = 0;
  }

  // 0 disables the job (documented) and is never reported; an invalid
  // non-zero value falls back to the built-in default and is reported once.
  private normalize(enabled: boolean, value: number): number {
    if (!enabled) {
      return 0;
    }
    if (value === 0) {
      return 0;
    }
    if (Number.isInteger(value) && value > 0 && value <= MAX_DELAY_SECONDS) {
      return value;
    }
    if (!this.warnedInvalid) {
      this.warnedInvalid = true;
      this.onWarning(
        `Invalid ${this.label} interval '${String(value)}': falling back to ${this.fallbackSeconds} seconds`,
      );
    }
    return this.fallbackSeconds;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    // Skip the tick instead of queueing it: the next scheduled run will
    // pick the work up again.
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.run();
    } catch (error) {
      this.onError(`${this.label} run failed`, error as Error);
    } finally {
      this.running = false;
    }
  }
}

export interface HotReloadTimersOptions {
  config: Config;
  noteRun: () => Promise<unknown> | unknown;
  configSyncRun: () => Promise<unknown> | unknown;
  // The config repository is enabled at startup only (its initial clone is
  // startup-only); its interval is hot-applied.
  configSyncEnabled: boolean;
  onError: (message: string, error: Error) => void;
  onWarning: (message: string) => void;
}

/**
 * The timers driven by reloadable settings: the agent note update and the
 * agent config repository refresh. `apply()` reads the live configuration
 * and is called at startup and after every successful config reload.
 */
export class HotReloadTimers {
  private readonly config: Config;
  private readonly note: ReloadableInterval;
  private readonly configSync: ReloadableInterval | null;

  constructor(options: HotReloadTimersOptions) {
    this.config = options.config;
    this.note = new ReloadableInterval({
      label: "Agent note",
      fallbackSeconds: DEFAULT_AGENT_NOTE_INTERVAL,
      run: options.noteRun,
      onError: options.onError,
      onWarning: options.onWarning,
      runImmediatelyOnEnable: true,
    });
    this.configSync = options.configSyncEnabled
      ? new ReloadableInterval({
          label: "Agent config repository refresh",
          fallbackSeconds: DEFAULT_AGENT_CONFIG_SYNC_INTERVAL,
          run: options.configSyncRun,
          onError: options.onError,
          onWarning: options.onWarning,
        })
      : null;
  }

  public apply(): void {
    // The note is enabled by its project: an invalid interval then falls
    // back to the daily default instead of silently disabling the note.
    this.note.configure(
      this.config.AGENT_NOTE_PROJECT.trim().length > 0,
      this.config.AGENT_NOTE_INTERVAL,
    );
    this.configSync?.configure(true, this.config.AGENT_CONFIG_SYNC_INTERVAL);
  }

  public stop(): void {
    this.note.stop();
    this.configSync?.stop();
  }
}
