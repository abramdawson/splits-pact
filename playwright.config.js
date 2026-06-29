const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.js/,
  use: {
    baseURL: 'http://127.0.0.1:7228',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:7228/healthz',
    reuseExistingServer: false,
    env: {
      PACT_DB_PATH: '.tmp/e2e.sqlite',
      PACT_RESET_DB: '1',
      PORT: '7228',
    },
  },
});
