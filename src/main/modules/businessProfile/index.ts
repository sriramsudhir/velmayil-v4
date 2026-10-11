import { z } from 'zod'
import type { App } from '../../core/app'
import { BusinessProfileService, validationError, type LogoFileInput } from './service'

export const order = 20

export { BusinessProfileService } from './service'

const id = z.object({ id: z.number().int() })

export function register(app: App): void {
  const svc = app.provide('businessProfile', new BusinessProfileService(app))
  const logoView = (assetId: number | null | undefined) => {
    const a = svc.getLogo(assetId)
    return a ? { id: a.id, sha256: a.sha256, mime: a.mime, widthPx: a.widthPx, heightPx: a.heightPx, sizeBytes: a.sizeBytes, hasTransparency: a.hasTransparency, dataUri: a.dataUri(true) } : null
  }
  const parse = <T extends z.ZodType>(schema: T, args: unknown): z.output<T> => {
    const r = schema.safeParse(args)
    if (!r.success) throw validationError(r.error)
    return r.data
  }

  app.expose('businessProfile', {
    getActive: (_a, a) => (a.requirePermission('profile.view'), svc.getActive()),
    findActive: (_a, a) => (a.requirePermission('profile.view'), svc.findActive()),
    getById: (args, a) => (a.requirePermission('profile.view'), svc.getById(parse(id, args).id)),
    getForDocument: (args, a) => {
      a.requirePermission('profile.view')
      const p = parse(z.object({ profileVersionId: z.number().int().nullable().optional(), policy: z.enum(['original', 'current']).optional() }), args)
      return svc.getForDocument(p.profileVersionId, p.policy)
    },
    listVersions: (_a, a) => (a.requirePermission('profile.view'), svc.listVersions()),
    getLogo: (args, a) => (a.requirePermission('profile.view'), logoView(parse(z.object({ assetId: z.number().int().nullable() }), args).assetId)),
    getActiveLogo: (_a, a) => (a.requirePermission('profile.view'), logoView(svc.findActive()?.logoAssetId)),
    checkLogoQuality: (args, a) => {
      a.requirePermission('profile.view')
      const p = parse(z.object({ assetId: z.number().int(), widthMm: z.number().min(0).optional(), heightMm: z.number().min(0).optional() }), args)
      return svc.checkLogoQuality(p.assetId, { widthMm: p.widthMm, heightMm: p.heightMm })
    },
    save: (args, a) => (a.requirePermission('profile.edit'), svc.save((args ?? {}) as Record<string, unknown>)),
    setLogo: (args, a) => {
      a.requirePermission('profile.edit')
      const r = svc.setLogo(args as LogoFileInput)
      return { ...r, logo: logoView(r.profile.logoAssetId) }
    },
    removeLogo: (_a, a) => (a.requirePermission('profile.edit'), svc.removeLogo()),
    getReprintPolicy: (_a, a) => (a.requirePermission('profile.view'), svc.getReprintPolicy()),
    setReprintPolicy: (args, a) => {
      a.requirePermission('profile.edit')
      svc.setReprintPolicy(parse(z.object({ policy: z.enum(['original', 'current']) }), args).policy)
      return { policy: svc.getReprintPolicy() }
    }
  })
}
