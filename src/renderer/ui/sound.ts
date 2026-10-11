// Counter feedback sounds (WebAudio, no asset files, works offline). Toggle: localStorage 'velmayil.sound' = '0' to mute.
let ctx: AudioContext | null = null

const enabled = (): boolean => {
  try {
    return localStorage.getItem('velmayil.sound') !== '0'
  } catch {
    return true
  }
}

export const setSoundEnabled = (on: boolean): void => {
  try {
    localStorage.setItem('velmayil.sound', on ? '1' : '0')
  } catch {
    /* ignore */
  }
}
export const isSoundEnabled = enabled

function tone(freq: number, startMs: number, durMs: number, type: OscillatorType = 'square', gain = 0.15): void {
  if (!ctx) return
  const t0 = ctx.currentTime + startMs / 1000
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000)
  osc.connect(g).connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + durMs / 1000 + 0.02)
}

function ready(): boolean {
  if (!enabled()) return false
  try {
    ctx ??= new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    if (ctx.state === 'suspended') void ctx.resume()
    return true
  } catch {
    return false
  }
}

/** Short scanner-style beep: an item was added / a product was saved. */
export function beepOk(): void {
  if (ready()) tone(1800, 0, 90)
}

/** Low double buzz: item not found / action rejected. */
export function beepError(): void {
  if (!ready()) return
  tone(300, 0, 140, 'sawtooth', 0.18)
  tone(220, 170, 200, 'sawtooth', 0.18)
}
