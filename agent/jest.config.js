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
};
