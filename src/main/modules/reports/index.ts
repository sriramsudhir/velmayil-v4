import type { App } from '../../core/app'
import { ReportsService, exposeReports } from './service'
import { DashboardService, exposeDashboard } from './dashboard'

export const order = 70

export function register(app: App): void {
  const reports = app.provide('reports', new ReportsService(app))
  exposeReports(app, reports)
  const dashboard = app.provide('dashboard', new DashboardService(app))
  exposeDashboard(app, dashboard)
}
