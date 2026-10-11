import { describe, it } from 'vitest'
import { seedDatabase } from './seed'

/** Not a real test: a CLI wrapper. Runs only when PERF_SEED_DIR is set (see tests/perf/seed.ts). */
describe('perf seed CLI', () => {
  it.skipIf(!process.env.PERF_SEED_DIR)('seeds PERF_SEED_DIR', async () => {
    await seedDatabase({
      dir: process.env.PERF_SEED_DIR!,
      products: Number(process.env.PERF_PRODUCTS ?? 20000),
      sales: Number(process.env.PERF_SALES ?? 50000),
      customers: Number(process.env.PERF_CUSTOMERS ?? 5000)
    })
  }, 900_000)
})
