import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests share one PostgreSQL test database, so files run one after another.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://gamebot:gamebot@localhost:54340/gamebot_test",
    },
  },
});
