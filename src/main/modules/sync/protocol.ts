import type { Snapshot } from '../../core/snapshot'

/**
 * Wire protocol (identical for the HTTP server and the shared-folder transport).
 *
 * A Change is one sync_queue row of the sending terminal. Receivers dedupe by (device, qid), so any batch may be
 * delivered any number of times (crash/retry safe) and in any interleaving between devices.
 */
export interface Change {
  /** sending terminal = pos_terminals.uuid of the sender */
  device: string
  deviceCode: string
  deviceName: string
  /** sync_queue.id on the sender (monotonic per device) */
  qid: number
  entity: string
  entityUuid: string
  op: 'upsert' | 'delete'
  /** sync_queue.created_at on the sender */
  createdAt: number
  payload: SyncPayload
}

/** Snapshot (core/snapshot.ts) + optional enrichment added by the sync module when pushing. */
export type SyncPayload = Snapshot & { meta?: SyncMeta }

export interface SyncMeta {
  /** stock_movements: location name (locations are matched by name across terminals) */
  locationName?: string
  /** stock_movements: portable reference of the document that caused the movement */
  refTable?: string
  refUuid?: string
  /** business_profile_versions / logo_assets: logo bytes travel with the profile version (base64) */
  logo?: LogoPayload
  /** settings / print_templates: shop-wide configuration sent by the Admin system (see shared.ts) */
  shared?: boolean
}

export interface LogoPayload {
  sha256: string
  mime: string
  widthPx: number
  heightPx: number
  sizeBytes: number
  hasTransparency: number
  createdAt: number
  bytesB64: string
  printBytesB64: string | null
  printMime: string | null
}

/** A change as returned by a transport pull (seq only meaningful for the HTTP server). */
export type RemoteChange = Change & {
  seq?: number
  /** stamped by the Admin system's embedded server on the Admin's own changes (a client cannot set it) */
  fromAdmin?: boolean
}

export interface PushResult {
  /** qids the remote has durably stored (including duplicates it already had) */
  accepted: number[]
  /** qids the remote refuses permanently (e.g. payload too large / invalid) */
  rejected: { qid: number; error: string }[]
}

export interface PullResult {
  changes: RemoteChange[]
  /** opaque cursor; store it and pass it to the next pull */
  cursor: string
  more: boolean
}

export interface SyncTransport {
  readonly kind: 'http' | 'folder' | 'hub'
  /** throws on connectivity / auth problems */
  ping(): Promise<{ ok: true; detail?: string }>
  push(device: { uuid: string; code: string; name: string }, changes: Change[]): Promise<PushResult>
  pull(device: { uuid: string }, cursor: string | null, limit: number): Promise<PullResult>
  /**
   * Optional long-poll: resolves 'changed' as soon as another terminal has something new after `cursor`, 'timeout' after
   * `seconds`, 'unsupported' when the remote cannot do this (the caller then falls back to polling on an interval).
   */
  wait?(device: { uuid: string }, cursor: string | null, seconds: number, signal?: AbortSignal): Promise<'changed' | 'timeout' | 'unsupported'>
}
