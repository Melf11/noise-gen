// Continuous noise via AudioWorklet. Output is routed through a MediaStream into
// a plain <audio> element so iOS keeps playback alive when the PWA is
// backgrounded (Safari suspends a bare AudioContext but not media elements).

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

const STORAGE_KEY = 'noise-gen:settings'

interface StoredSettings {
  type?: NoiseType
  eq?: { low?: number; mid?: number; high?: number }
  volume?: number
}

interface AudioGraph {
  ctx: AudioContext
  noise: AudioWorkletNode
  low: BiquadFilterNode
  mid: BiquadFilterNode
  high: BiquadFilterNode
  gain: GainNode
  dest: MediaStreamAudioDestinationNode
}

function workletModuleUrl(): string {
  // Resolve relative to the current page URL so it works for both
  // local dev (often served at /) and GitHub Pages (served at /noise-gen/).
  if (typeof window !== 'undefined') {
    return new URL('noise-processor.worklet.js', window.location.href).toString()
  }
  return '/noise-processor.worklet.js'
}

function typeToParam(t: NoiseType): number {
  if (t === 'white') return 0
  if (t === 'pink') return 1
  return 2
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
  let graph: AudioGraph | null = null
  let initPromise: Promise<void> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let resumeTimer: ReturnType<typeof setInterval> | null = null

  function ensureEl() {
    if (audioEl) return audioEl
    const el = new Audio()
    el.preload = 'auto'
    el.setAttribute('playsinline', '')
    el.setAttribute('webkit-playsinline', '')
    el.volume = 1
    audioEl = el
    return el
  }

  function syncGraphParams() {
    if (!graph) return
    const { noise, low, mid, high, gain } = graph
    noise.parameters.get('type')!.value = typeToParam(type.value)
    low.gain.value = eq.low.gain
    mid.gain.value = eq.mid.gain
    high.gain.value = eq.high.gain
    gain.gain.value = volume.value
  }

  async function ensureGraph() {
    if (graph) return
    if (initPromise) return initPromise

    initPromise = (async () => {
      rendering.value = true
      try {
        const ctx = new AudioContext()
        await ctx.audioWorklet.addModule(workletModuleUrl())

        const noise = new AudioWorkletNode(ctx, 'noise-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        })

        const low = ctx.createBiquadFilter()
        low.type = 'lowshelf'
        low.frequency.value = 200

        const mid = ctx.createBiquadFilter()
        mid.type = 'peaking'
        mid.frequency.value = 1000
        mid.Q.value = 1

        const high = ctx.createBiquadFilter()
        high.type = 'highshelf'
        high.frequency.value = 4000

        const gain = ctx.createGain()
        const dest = ctx.createMediaStreamDestination()

        noise.connect(low).connect(mid).connect(high).connect(gain).connect(dest)

        graph = { ctx, noise, low, mid, high, gain, dest }
        syncGraphParams()

        const el = ensureEl()
        el.srcObject = dest.stream
      } finally {
        rendering.value = false
      }
    })()

    return initPromise
  }

  function setNoiseActive(active: boolean) {
    if (!graph) return
    graph.noise.parameters.get('active')!.value = active ? 1 : 0
  }

  // Try to resume after an audio session interruption (incoming call, etc.).
  function tryResume() {
    if (!playing.value || !audioEl || !graph) return

    if (graph.ctx.state === 'suspended') {
      void graph.ctx.resume()
    }

    setNoiseActive(true)
    syncGraphParams()

    if (!audioEl.paused) return
    audioEl.play().catch(() => { /* will retry on next trigger */ })
  }

  function startResumeWatchers() {
    if (resumeTimer !== null) return
    resumeTimer = setInterval(tryResume, 1500)
  }

  function stopResumeWatchers() {
    if (resumeTimer !== null) {
      clearInterval(resumeTimer)
      resumeTimer = null
    }
  }

  function setPlaybackState(state: MediaSessionPlaybackState) {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state
    }
  }

  // Synchronous play — must not await before play() (iOS user-gesture rules).
  function playLoaded(): boolean {
    if (!audioEl || !graph) return false

    syncGraphParams()
    setNoiseActive(true)
    void graph.ctx.resume()

    const p = audioEl.play()
    playing.value = true
    setPlaybackState('playing')
    startResumeWatchers()

    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        console.warn('play() failed', err)
        playing.value = false
        setNoiseActive(false)
        setPlaybackState('paused')
      })
    }
    return true
  }

  async function start() {
    await ensureGraph()
    playLoaded()
  }

  function stop() {
    stopResumeWatchers()
    setNoiseActive(false)
    audioEl?.pause()
    // Intentionally don't reset currentTime: doing so seems to deactivate the
    // iOS audio session, after which lock-screen play can't reactivate it.
    playing.value = false
    setPlaybackState('paused')
  }

  async function toggle() {
    if (playing.value) stop()
    else await start()
  }

  function setType(t: NoiseType) {
    if (type.value === t) return
    type.value = t
    syncGraphParams()
  }

  function setEq(band: keyof EqState, gain: number) {
    eq[band].gain = gain
    syncGraphParams()
  }

  function setVolume(v: number) {
    volume.value = v
    if (graph) graph.gain.gain.value = v
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

    void ensureGraph()

    watch(
      [type, () => eq.low.gain, () => eq.mid.gain, () => eq.high.gain, volume],
      scheduleSave
    )

    document.addEventListener('visibilitychange', tryResume)
    window.addEventListener('focus', tryResume)
    window.addEventListener('pageshow', tryResume)

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'Noise',
          artist: 'Noise Generator'
        })
      } catch { /* MediaMetadata may not be available */ }
      navigator.mediaSession.setActionHandler('play', () => {
        if (!playLoaded()) void start()
      })
      navigator.mediaSession.setActionHandler('pause', () => { stop() })
    }
  })

  onScopeDispose(() => {
    if (saveTimer) clearTimeout(saveTimer)
    stopResumeWatchers()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', tryResume)
      window.removeEventListener('focus', tryResume)
      window.removeEventListener('pageshow', tryResume)
    }
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', null)
        navigator.mediaSession.setActionHandler('pause', null)
      } catch { /* ignore */ }
    }
    if (audioEl) {
      audioEl.pause()
      audioEl.srcObject = null
      audioEl = null
    }
    if (graph) {
      void graph.ctx.close()
      graph = null
    }
    initPromise = null
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
