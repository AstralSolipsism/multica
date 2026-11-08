import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['server/internal/daemon/ysk/tests/*.test.ts'] },
})
