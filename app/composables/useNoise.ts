// Generates noise with EQ baked into a WAV buffer, then plays it back via two
// alternating <audio> elements. The handoff approach exists because iOS Safari
// inserts a small gap when looping an <audio> element via the `loop` attribute.
// Two elements with `ended`-event handoff plus pre-scheduled start of the
// other element while the current one is still playing gives gapless playback
// — and crucially keeps audio alive while the PWA is backgrounded on iOS,
// since AudioContext gets suspended but plain <audio> playback does not.

export type NoiseType = 'white' | 'pink' | 'brown'

export interface EqBand {
  /** dB, -12 .. +12 */
  gain: number
}

export interface EqState {
  low: EqBand   // lowshelf @ 200 Hz
  mid: EqBand   // peaking @ 1000 Hz, Q 1
  high: EqBand  // highshelf @ 4000 Hz
}

interface NoiseOptions {
  type: NoiseType
  durationSec: number
  sampleRate: number
}

function fillWhite(data: Float32Array) {
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
}

// Paul Kellet's refined pink-noise filter
function fillPink(data: Float32Array) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1
    b0 = 0.99886 * b0 + white * 0.0555179
    b1 = 0.99332 * b1 + white * 0.0750759
    b2 = 0.96900 * b2 + white * 0.1538520
    b3 = 0.86650 * b3 + white * 0.3104856
    b4 = 0.55000 * b4 + white * 0.5329522
    b5 = -0.7616 * b5 - white * 0.0168980
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
    b6 = white * 0.115926
  }
}

// Integrated white noise, gently leaked to avoid DC drift
function fillBrown(data: Float32Array) {
  let last = 0
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1
    last = (last + 0.02 * white) / 1.02
    data[i] = last * 3.5
  }
}

function createRawNoise(ctx: BaseAudioContext, opts: NoiseOptions) {
  const length = Math.floor(opts.durationSec * opts.sampleRate)
  const buf = ctx.createBuffer(2, length, opts.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    if (opts.type === 'white') fillWhite(data)
    else if (opts.type === 'pink') fillPink(data)
    else fillBrown(data)
  }
  return buf
}

async function renderWithEq(opts: NoiseOptions, eq: EqState): Promise<AudioBuffer> {
  const length = Math.floor(opts.durationSec * opts.sampleRate)
  const offline = new OfflineAudioContext(2, length, opts.sampleRate)
  const raw = createRawNoise(offline, opts)

  const src = offline.createBufferSource()
  src.buffer = raw

  const low = offline.createBiquadFilter()
  low.type = 'lowshelf'
  low.frequency.value = 200
  low.gain.value = eq.low.gain

  const mid = offline.createBiquadFilter()
  mid.type = 'peaking'
  mid.frequency.value = 1000
  mid.Q.value = 1
  mid.gain.value = eq.mid.gain

  const high = offline.createBiquadFilter()
  high.type = 'highshelf'
  high.frequency.value = 4000
  high.gain.value = eq.high.gain

  src.connect(low).connect(mid).connect(high).connect(offline.destination)
  src.start(0)
  return await offline.startRendering()
}

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const numFrames = buffer.length
  const bytesPerSample = 2
  const blockAlign = numCh * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = numFrames * blockAlign
  const bufferSize = 44 + dataSize
  const ab = new ArrayBuffer(bufferSize)
  const view = new DataView(ab)

  let p = 0
  const writeStr = (s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)) }
  const writeU32 = (v: number) => { view.setUint32(p, v, true); p += 4 }
  const writeU16 = (v: number) => { view.setUint16(p, v, true); p += 2 }

  writeStr('RIFF')
  writeU32(36 + dataSize)
  writeStr('WAVE')
  writeStr('fmt ')
  writeU32(16)
  writeU16(1)            // PCM
  writeU16(numCh)
  writeU32(sampleRate)
  writeU32(byteRate)
  writeU16(blockAlign)
  writeU16(bytesPerSample * 8)
  writeStr('data')
  writeU32(dataSize)

  const chans: Float32Array[] = []
  for (let ch = 0; ch < numCh; ch++) chans.push(buffer.getChannelData(ch))
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      let s = chans[ch][i]
      if (s > 1) s = 1
      else if (s < -1) s = -1
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      p += 2
    }
  }

  return new Blob([ab], { type: 'audio/wav' })
}

export function useNoise() {
  const type = ref<NoiseType>('pink')
  const eq = reactive<EqState>({
    low:  { gain: 0 },
    mid:  { gain: 0 },
    high: { gain: 0 }
  })
  const volume = ref(0.7)
  const playing = ref(false)
  const rendering = ref(false)

  // Two audio elements, handed off via `ended` to mask the iOS Safari loop gap.
  let elA: HTMLAudioElement | null = null
  let elB: HTMLAudioElement | null = null
  let current: HTMLAudioElement | null = null
  let currentUrl: string | null = null
  let renderToken = 0
  let pendingTimer: ReturnType<typeof setTimeout> | null = null

  const SAMPLE_RATE = 44100
  const DURATION = 20 // seconds per buffer; longer = fewer handoffs

  function makeEl(): HTMLAudioElement {
    const el = new Audio()
    el.preload = 'auto'
    el.setAttribute('playsinline', '')
    el.setAttribute('webkit-playsinline', '')
    el.volume = volume.value
    return el
  }

  function ensureElements() {
    if (elA && elB) return
    elA = makeEl()
    elB = makeEl()
    const onEndedFrom = (ended: HTMLAudioElement) => {
      if (!playing.value) return
      const next = ended === elA ? elB! : elA!
      next.currentTime = 0
      next.play().catch(() => { /* gesture/state issues handled by start() */ })
      current = next
    }
    elA.addEventListener('ended', () => onEndedFrom(elA!))
    elB.addEventListener('ended', () => onEndedFrom(elB!))
  }

  function applySrc(url: string) {
    ensureElements()
    elA!.src = url
    elB!.src = url
  }

  async function renderNow() {
    rendering.value = true
    const token = ++renderToken
    try {
      const buf = await renderWithEq(
        { type: type.value, durationSec: DURATION, sampleRate: SAMPLE_RATE },
        { low: { ...eq.low }, mid: { ...eq.mid }, high: { ...eq.high } }
      )
      if (token !== renderToken) return
      const blob = audioBufferToWav(buf)
      const url = URL.createObjectURL(blob)
      const prevUrl = currentUrl
      const wasPlaying = playing.value
      applySrc(url)
      currentUrl = url
      if (wasPlaying) {
        const el = current ?? elA!
        try { await el.play() } catch { /* will be retried by start() */ }
      }
      if (prevUrl) URL.revokeObjectURL(prevUrl)
    } finally {
      if (token === renderToken) rendering.value = false
    }
  }

  function scheduleRender(delay = 250) {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      void renderNow()
    }, delay)
  }

  async function start() {
    ensureElements()
    if (!currentUrl) await renderNow()
    elA!.volume = volume.value
    elB!.volume = volume.value
    current = elA
    elA!.currentTime = 0
    try {
      await elA!.play()
      playing.value = true
    } catch (err) {
      console.warn('play() failed', err)
      playing.value = false
    }
  }

  function stop() {
    playing.value = false
    elA?.pause()
    elB?.pause()
    if (elA) elA.currentTime = 0
    if (elB) elB.currentTime = 0
    current = null
  }

  async function toggle() {
    if (playing.value) stop()
    else await start()
  }

  function setType(t: NoiseType) {
    if (type.value === t) return
    type.value = t
    scheduleRender(0)
  }

  function setEq(band: keyof EqState, gain: number) {
    eq[band].gain = gain
    scheduleRender(300)
  }

  function setVolume(v: number) {
    volume.value = v
    if (elA) elA.volume = v
    if (elB) elB.volume = v
  }

  onScopeDispose(() => {
    if (pendingTimer) clearTimeout(pendingTimer)
    for (const el of [elA, elB]) {
      if (!el) continue
      el.pause()
      el.src = ''
    }
    elA = null
    elB = null
    current = null
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl)
      currentUrl = null
    }
  })

  return {
    type,
    eq,
    volume,
    playing,
    rendering,
    start,
    stop,
    toggle,
    setType,
    setEq,
    setVolume
  }
}
