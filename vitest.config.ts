import { defineConfig } from 'vitest/config';

// The integration tests open real loopback sockets and use real timers (publish loop, heartbeat, pause):
// run files one at a time so a busy machine or CI runner can't starve them into flaky timeouts.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], fileParallelism: false } });
