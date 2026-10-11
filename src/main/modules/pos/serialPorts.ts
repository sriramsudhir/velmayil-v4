/** Kept for compatibility: serial AND HID reader access now live together in deviceAccess.ts (one permission handler). */
export { installDevicePermissionHandlers as installSerialPortHandlers } from './deviceAccess'
