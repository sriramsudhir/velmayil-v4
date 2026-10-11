import type { App } from '../../core/app'
import { UnitsService } from './service'

export const order = 20
export { UnitsService }

/**
 * Unit codes / label numbers (one per physical unit: 10-digit label numbers, older PREFIX-NNNN codes stay valid). Provided as app.get<UnitsService>('units') for sibling services and exposed to the
 * renderer as service 'units'. Every method checks its own permission and validates input.
 */
export function register(app: App): void {
  const svc = app.provide('units', new UnitsService(app))
  app.expose('units', {
    setTracking: (a) => svc.setTracking(a),
    suggestPrefix: (a) => svc.suggestPrefix(a),
    generate: (a) => svc.generate(a),
    labelPlan: (a) => svc.labelPlan(a),
    issueLabels: (a) => svc.issueLabels(a),
    reprintLabels: (a) => svc.reprintLabels(a),
    resolve: (a) => svc.resolve(a),
    list: (a) => svc.list(a),
    counts: (a) => svc.counts(a),
    markVoid: (a) => svc.markVoid(a),
    countReport: (a) => svc.countReport(a)
  })
}
