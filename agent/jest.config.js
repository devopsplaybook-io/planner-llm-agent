module.exports = {
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2020",
        },
      },
    ],
  },
  testMatch: ["/**/src/**/*.spec.(ts|js)"],
  testEnvironment: "node",
  coverageProvider: "v8",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  // One worker: the suites use real timers (polling intervals of 1s) and
  // the agent runtime runs them on a CPU-throttled container (os.cpus()
  // reports more cores than the cgroup gives), where parallel workers
  // starve the timers and flake the timing-sensitive tests.
  maxWorkers: 1,
  // Generous per-test budget for the same reason: under CPU throttling the
  // real-timer waits need wall clock, not just CPU.
  testTimeout: 30000,
};
