import { Config } from "./Config";
import {
  HotReloadTimers,
  ReloadableInterval,
  ReloadableIntervalOptions,
} from "./HotReloadTimers";

describe("ReloadableInterval", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const create = (options: Partial<ReloadableIntervalOptions> = {}) => {
    const run = jest.fn().mockResolvedValue(undefined);
    const onError = jest.fn();
    const onWarning = jest.fn();
    const scheduler = new ReloadableInterval({
      label: "Test job",
      fallbackSeconds: 60,
      run,
      onError,
      onWarning,
      ...options,
    });
    return { scheduler, run, onError, onWarning };
  };

  it("should run at the configured interval", async () => {
    const { scheduler, run } = create();
    scheduler.configure(true, 10);

    await jest.advanceTimersByTimeAsync(9_999);
    expect(run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("should re-arm the timer when the interval changes without a restart", async () => {
    const { scheduler, run } = create();
    scheduler.configure(true, 10);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.configure(true, 20);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("should disable the timer with 0 and re-enable it with a positive interval", async () => {
    const { scheduler, run } = create();
    scheduler.configure(true, 10);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.configure(true, 0);
    await jest.advanceTimersByTimeAsync(100_000);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.configure(true, 10);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("should run immediately when enabled with runImmediatelyOnEnable", async () => {
    const { scheduler, run } = create({ runImmediatelyOnEnable: true });
    scheduler.configure(true, 0);
    expect(run).not.toHaveBeenCalled();

    scheduler.configure(true, 10);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("should not run immediately when the option is not set", async () => {
    const { scheduler, run } = create();
    scheduler.configure(true, 10);
    expect(run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("should fall back to the default interval and warn once for an invalid value", async () => {
    const { scheduler, run, onWarning } = create();
    scheduler.configure(true, -5);

    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(
      "Invalid Test job interval '-5': falling back to 60 seconds",
    );
    expect(run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.configure(true, 1.5);
    expect(onWarning).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("should not warn about an invalid interval while the job is disabled", async () => {
    const { scheduler, run, onWarning } = create();
    scheduler.configure(false, Number.NaN);
    expect(onWarning).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(100_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("should skip a tick while the previous run is still in progress", async () => {
    const resolvers: (() => void)[] = [];
    const run = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { scheduler } = create({ run });
    scheduler.configure(true, 10);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(1);

    resolvers[0]();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("should report a failed run without throwing", async () => {
    const failure = new Error("boom");
    const { scheduler, run, onError } = create();
    run.mockRejectedValue(failure);
    scheduler.configure(true, 10);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(onError).toHaveBeenCalledWith("Test job run failed", failure);
  });

  it("should stop the timer", async () => {
    const { scheduler, run } = create();
    scheduler.configure(true, 10);
    scheduler.stop();
    await jest.advanceTimersByTimeAsync(100_000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("HotReloadTimers", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const create = (
    configure: (config: Config) => void = () => undefined,
    configSyncEnabled = true,
  ) => {
    const config = new Config();
    config.AGENT_NOTE_PROJECT = "Agent";
    config.AGENT_NOTE_INTERVAL = 3600;
    config.AGENT_CONFIG_SYNC_INTERVAL = 300;
    configure(config);
    const noteRun = jest.fn().mockResolvedValue(undefined);
    const configSyncRun = jest.fn().mockResolvedValue(undefined);
    const onError = jest.fn();
    const onWarning = jest.fn();
    const timers = new HotReloadTimers({
      config,
      noteRun,
      configSyncRun,
      configSyncEnabled,
      onError,
      onWarning,
    });
    return { config, timers, noteRun, configSyncRun, onError, onWarning };
  };

  it("should run the note immediately and schedule both jobs", async () => {
    const { timers, noteRun, configSyncRun } = create();
    timers.apply();
    expect(noteRun).toHaveBeenCalledTimes(1);
    expect(configSyncRun).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(300_000);
    expect(configSyncRun).toHaveBeenCalledTimes(1);
    expect(noteRun).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3_300_000);
    expect(noteRun).toHaveBeenCalledTimes(2);
    timers.stop();
  });

  it("should not create the config-sync job when the repository is disabled", async () => {
    const { timers, configSyncRun } = create(() => undefined, false);
    timers.apply();
    await jest.advanceTimersByTimeAsync(1_000_000);
    expect(configSyncRun).not.toHaveBeenCalled();
    timers.stop();
  });

  it("should re-arm the note and config-sync intervals without a restart", async () => {
    const { config, timers, noteRun, configSyncRun } = create(
      (value) => {
        value.AGENT_NOTE_INTERVAL = 10;
        value.AGENT_CONFIG_SYNC_INTERVAL = 10;
      },
    );
    timers.apply();
    expect(noteRun).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(noteRun).toHaveBeenCalledTimes(2);
    expect(configSyncRun).toHaveBeenCalledTimes(1);

    config.AGENT_NOTE_INTERVAL = 20;
    config.AGENT_CONFIG_SYNC_INTERVAL = 20;
    timers.apply();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(noteRun).toHaveBeenCalledTimes(2);
    expect(configSyncRun).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(noteRun).toHaveBeenCalledTimes(3);
    expect(configSyncRun).toHaveBeenCalledTimes(2);
    timers.stop();
  });

  it("should disable and re-enable the note and config-sync jobs with 0", async () => {
    const { config, timers, noteRun, configSyncRun } = create(
      (value) => {
        value.AGENT_NOTE_INTERVAL = 10;
        value.AGENT_CONFIG_SYNC_INTERVAL = 10;
      },
    );
    timers.apply();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(noteRun).toHaveBeenCalledTimes(2);
    expect(configSyncRun).toHaveBeenCalledTimes(1);

    config.AGENT_NOTE_INTERVAL = 0;
    config.AGENT_CONFIG_SYNC_INTERVAL = 0;
    timers.apply();
    await jest.advanceTimersByTimeAsync(100_000);
    expect(noteRun).toHaveBeenCalledTimes(2);
    expect(configSyncRun).toHaveBeenCalledTimes(1);

    config.AGENT_NOTE_INTERVAL = 10;
    config.AGENT_CONFIG_SYNC_INTERVAL = 10;
    timers.apply();
    // Re-enabling the note updates it immediately, then on schedule.
    expect(noteRun).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(noteRun).toHaveBeenCalledTimes(4);
    expect(configSyncRun).toHaveBeenCalledTimes(2);
    timers.stop();
  });

  it("should enable the note from a disabled project on a reload", async () => {
    const { config, timers, noteRun } = create((value) => {
      value.AGENT_NOTE_PROJECT = "";
      value.AGENT_NOTE_INTERVAL = 10;
    });
    timers.apply();
    expect(noteRun).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(100_000);
    expect(noteRun).not.toHaveBeenCalled();

    config.AGENT_NOTE_PROJECT = "Agent";
    timers.apply();
    expect(noteRun).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(noteRun).toHaveBeenCalledTimes(2);
    timers.stop();
  });

  it("should fall back to the default intervals for invalid values", async () => {
    const { timers, noteRun, configSyncRun, onWarning } = create((value) => {
      value.AGENT_NOTE_INTERVAL = -1;
      value.AGENT_CONFIG_SYNC_INTERVAL = -1;
    });
    timers.apply();
    expect(noteRun).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(300_000);
    expect(configSyncRun).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(86_400_000);
    expect(noteRun).toHaveBeenCalledTimes(2);
    timers.stop();
  });

  it("should report failed runs through onError", async () => {
    const { timers, configSyncRun, onError } = create((value) => {
      value.AGENT_CONFIG_SYNC_INTERVAL = 5;
    });
    const failure = new Error("sync failed");
    configSyncRun.mockRejectedValue(failure);
    timers.apply();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(onError).toHaveBeenCalledWith(
      "Agent config repository refresh run failed",
      failure,
    );
    timers.stop();
  });

  it("should clear both jobs on stop", async () => {
    const { timers, noteRun, configSyncRun } = create((value) => {
      value.AGENT_NOTE_INTERVAL = 10;
      value.AGENT_CONFIG_SYNC_INTERVAL = 10;
    });
    timers.apply();
    timers.stop();
    await jest.advanceTimersByTimeAsync(100_000);
    expect(noteRun).toHaveBeenCalledTimes(1);
    expect(configSyncRun).not.toHaveBeenCalled();
  });
});
