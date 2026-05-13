// Renders noise with EQ baked into a WAV buffer and plays it back via a plain
// <audio loop>. iOS Safari suspends AudioContext when the PWA is backgrounded
// but keeps <audio> elements running, so this is the path that survives
// going to the home screen with the app installed. The buffer is 10 minutes
// long, which makes Safari's tiny loop-rewind gap rare enough to ignore.

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

const NUM_CHANNELS = 1

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
  const buf = ctx.createBuffer(NUM_CHANNELS, length, opts.sampleRate)
  for (let ch = 0; ch < NUM_CHANNELS; ch++) {
    const data = buf.getChannelData(ch)
    if (opts.type === 'white') fillWhite(data)
    else if (opts.type === 'pink') fillPink(data)
    else fillBrown(data)
  }
  return buf
}

async function renderWithEq(opts: NoiseOptions, eq: EqState): Promise<AudioBuffer> {
  const length = Math.floor(opts.durationSec * opts.sampleRate)
  const offline = new OfflineAudioContext(NUM_CHANNELS, length, opts.sampleRate)
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
  writeU16(1)
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

const STORAGE_KEY = 'noise-gen:settings'

interface StoredSettings {
  type?: NoiseType
  eq?: { low?: number; mid?: number; high?: number }
  volume?: number
}

function loadStored(): StoredSettings | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredSettings) : null
  } catch {
    return null
  }
}

function writeStored(s: StoredSettings) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* quota / private mode */ }
}

function clampDb(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(-12, Math.min(12, v))
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

  let audioEl: HTMLAudioElement | null = null
  let currentUrl: string | null = null
  let renderToken = 0
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let resumeTimer: ReturnType<typeof setInterval> | null = null

  const SAMPLE_RATE = 44100
  const DURATION = 600 // 10 minutes

  function ensureEl() {
    if (audioEl) return audioEl
    const el = new Audio()
    el.loop = true
    el.preload = 'auto'
    el.setAttribute('playsinline', '')
    el.setAttribute('webkit-playsinline', '')
    el.volume = volume.value
    audioEl = el
    return el
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
      const el = ensureEl()
      const wasPlaying = playing.value
      const prevUrl = currentUrl
      el.src = url
      currentUrl = url
      if (wasPlaying) {
        try { await el.play() } catch { /* gesture issues handled by start() */ }
      }
      if (prevUrl) URL.revokeObjectURL(prevUrl)
    } finally {
      if (token === renderToken) rendering.value = false
    }
  }

  function scheduleRender(delay: number) {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      void renderNow()
    }, delay)
  }

  // Try to resume after an audio session interruption (incoming call, etc.).
  // iOS pauses the <audio> element when a call comes in and doesn't auto-
  // resume when the call ends, even though the page is back in focus.
  function tryResume() {
    if (!audioEl || !playing.value) return
    if (!audioEl.paused) return
    audioEl.play().catch(() => { /* will retry on next trigger */ })
  }

  function startResumeWatchers() {
    if (resumeTimer !== null) return
    // Fast polling for foreground recovery — cheap and stops as soon as
    // playback resumes successfully via tryResume's no-op when not paused.
    resumeTimer = setInterval(tryResume, 1500)
  }

  function stopResumeWatchers() {
    if (resumeTimer !== null) {
      clearInterval(resumeTimer)
      resumeTimer = null
    }
  }

  async function start() {
    const el = ensureEl()
    if (!currentUrl) await renderNow()
    el.volume = volume.value
    try {
      await el.play()
      playing.value = true
      startResumeWatchers()
    } catch (err) {
      console.warn('play() failed', err)
      playing.value = false
    }
  }

  function stop() {
    stopResumeWatchers()
    audioEl?.pause()
    if (audioEl) audioEl.currentTime = 0
    playing.value = false
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
    scheduleRender(800)
  }

  function setVolume(v: number) {
    volume.value = v
    if (audioEl) audioEl.volume = v
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      writeStored({
        type: type.value,
        eq: { low: eq.low.gain, mid: eq.mid.gain, high: eq.high.gain },
        volume: volume.value
      })
    }, 250)
  }

  onMounted(() => {
    const stored = loadStored()
    if (stored) {
      if (stored.type === 'white' || stored.type === 'pink' || stored.type === 'brown') {
        type.value = stored.type
      }
      if (stored.eq) {
        eq.low.gain  = clampDb(stored.eq.low)
        eq.mid.gain  = clampDb(stored.eq.mid)
        eq.high.gain = clampDb(stored.eq.high)
      }
      if (typeof stored.volume === 'number' && stored.volume >= 0 && stored.volume <= 1) {
        volume.value = stored.volume
      }
    }

    watch(
      [type, () => eq.low.gain, () => eq.mid.gain, () => eq.high.gain, volume],
      scheduleSave
    )

    document.addEventListener('visibilitychange', tryResume)
    window.addEventListener('focus', tryResume)
    window.addEventListener('pageshow', tryResume)
  })

  onScopeDispose(() => {
    if (pendingTimer) clearTimeout(pendingTimer)
    if (saveTimer) clearTimeout(saveTimer)
    stopResumeWatchers()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', tryResume)
      window.removeEventListener('focus', tryResume)
      window.removeEventListener('pageshow', tryResume)
    }
    if (audioEl) {
      audioEl.pause()
      audioEl.src = ''
      audioEl = null
    }
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
