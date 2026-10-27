// Continuous noise via AudioWorklet. Output is routed through a MediaStream into
// a plain <audio> element so iOS keeps playback alive when the PWA is
// backgrounded (Safari suspends a bare AudioContext but not media elements).

export type NoiseType = 'white' | 'pink' | 'brown'

/** 'end' fades over the last SLEEP_FADE_SEC, 'full' over the whole countdown. */
export type SleepFade = 'end' | 'full'

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

/** Length of the sleep-timer fade-out at the end of the countdown. */
const SLEEP_FADE_SEC = 30

interface StoredSettings {
  type?: NoiseType
  eq?: { low?: number; mid?: number; high?: number }
  volume?: number
  sleepMinutes?: number
  sleepFade?: SleepFade
}

interface AudioGraph {
  ctx: AudioContext
  noise: AudioWorkletNode
  low: BiquadFilterNode
  mid: BiquadFilterNode
  high: BiquadFilterNode
  gain: GainNode
  /** Sleep-timer fade, kept separate so volume changes don't clobber its automation. */
  fade: GainNode
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
  /** Chosen sleep-timer length in minutes, 0 = off. */
  const sleepMinutes = ref(0)
  const sleepFade = ref<SleepFade>('end')
  /** Wall-clock deadline (ms) while the countdown runs; null while armed-but-stopped or off. */
  const sleepEndsAt = ref<number | null>(null)
  const now = ref(Date.now())
  const sleepRemaining = computed(() =>
    sleepEndsAt.value === null ? 0 : Math.max(0, sleepEndsAt.value - now.value)
  )

  let audioEl: HTMLAudioElement | null = null
  let graph: AudioGraph | null = null
  let initPromise: Promise<void> | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let resumeTimer: ReturnType<typeof setInterval> | null = null
  let sleepTick: ReturnType<typeof setInterval> | null = null
  // True while another audio session holds an iOS interruption (phone call, a
  // voice message playing in another app). We must stay silent and not grab the
  // audio focus back until iOS reports the interruption has ended.
  let interrupted = false

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
        const fade = ctx.createGain()
        const dest = ctx.createMediaStreamDestination()

        noise.connect(low).connect(mid).connect(high).connect(gain).connect(fade).connect(dest)

        graph = { ctx, noise, low, mid, high, gain, fade, dest }
        syncGraphParams()

        // iOS surfaces interruptions (calls, other apps' audio) as an
        // 'interrupted' AudioContext state. Track it so we yield the audio
        // focus instead of fighting to reclaim it.
        ctx.addEventListener('statechange', onCtxStateChange)

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

  // iOS reports interruptions via the AudioContext state machine: it flips to
  // 'interrupted' while another audio session is active and back to 'suspended'
  // once that session ends. We use this to let foreign audio (e.g. a Telegram
  // voice message) play through to the end, then bring the noise back.
  function onCtxStateChange() {
    if (!graph) return
    const state = graph.ctx.state as AudioContextState | 'interrupted'
    if (state === 'interrupted') {
      interrupted = true
      return
    }
    if (interrupted) {
      interrupted = false
      // The interrupting audio finished — resume the noise where we left off.
      // The audio clock was paused meanwhile, so realign the fade with the
      // wall-clock deadline.
      if (playing.value) {
        scheduleSleepFade()
        tryResume()
      }
    }
  }

  // Try to resume after an audio session interruption (incoming call, etc.).
  function tryResume() {
    checkSleepTimer()
    if (!playing.value || !audioEl || !graph) return

    // Another audio session is currently playing — stay out of the way so it
    // can finish instead of being cut short by us reclaiming the focus.
    if (interrupted || (graph.ctx.state as string) === 'interrupted') return

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

  // The fade is scheduled on the audio clock rather than driven from JS: iOS
  // throttles timers in a backgrounded PWA, but AudioParam automation keeps
  // running, so the noise reliably reaches silence at the deadline.
  function scheduleSleepFade() {
    if (!graph || sleepEndsAt.value === null) return
    const { ctx, fade } = graph
    const t = ctx.currentTime
    const remaining = Math.max(0, (sleepEndsAt.value - Date.now()) / 1000)
    const end = t + remaining
    const fadeLen = sleepFade.value === 'full' ? sleepMinutes.value * 60 : SLEEP_FADE_SEC
    const fadeStart = Math.max(t, end - fadeLen)
    // Pick up at the level the ramp should be at now, in case we're already mid-fade.
    const level = fadeLen > 0 ? Math.min(1, remaining / fadeLen) : 0
    fade.gain.cancelScheduledValues(t)
    fade.gain.setValueAtTime(level, t)
    fade.gain.setValueAtTime(level, fadeStart)
    fade.gain.linearRampToValueAtTime(0, end)
  }

  function resetSleepFade() {
    if (!graph) return
    const { ctx, fade } = graph
    fade.gain.cancelScheduledValues(ctx.currentTime)
    fade.gain.setValueAtTime(1, ctx.currentTime)
  }

  function checkSleepTimer() {
    now.value = Date.now()
    if (sleepEndsAt.value !== null && now.value >= sleepEndsAt.value) stop()
  }

  function startSleepCountdown() {
    if (sleepMinutes.value <= 0) return
    sleepEndsAt.value = Date.now() + sleepMinutes.value * 60_000
    now.value = Date.now()
    scheduleSleepFade()
    if (sleepTick === null) sleepTick = setInterval(checkSleepTimer, 1000)
  }

  function stopSleepCountdown() {
    if (sleepTick !== null) {
      clearInterval(sleepTick)
      sleepTick = null
    }
    sleepEndsAt.value = null
    resetSleepFade()
  }

  /** Arm the sleep timer (0 = off). Counts down right away if playing, otherwise from the next play. */
  function setSleepTimer(minutes: number) {
    stopSleepCountdown()
    sleepMinutes.value = minutes
    if (playing.value) startSleepCountdown()
  }

  function setSleepFade(f: SleepFade) {
    sleepFade.value = f
    if (playing.value) scheduleSleepFade()
  }

  function setPlaybackState(state: MediaSessionPlaybackState) {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state
    }
  }

  // Synchronous play — must not await before play() (iOS user-gesture rules).
  function playLoaded(): boolean {
    if (!audioEl || !graph) return false

    // Explicit user intent to play overrides any stale interruption state.
    interrupted = false
    syncGraphParams()
    setNoiseActive(true)
    void graph.ctx.resume()

    const p = audioEl.play()
    playing.value = true
    setPlaybackState('playing')
    startResumeWatchers()
    if (sleepEndsAt.value === null) startSleepCountdown()

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
    // Only silence the worklet (active=0 outputs zeros) — deliberately keep the
    // <audio> element playing. On iOS, pausing a media element whose srcObject is
    // a MediaStream makes it impossible to resume: a later play() produces no
    // sound until the app is fully restarted. Leaving the stream running means
    // play just flips `active` back on.
    setNoiseActive(false)
    playing.value = false
    setPlaybackState('paused')
    // The chosen timer stays armed and counts down afresh on the next play.
    stopSleepCountdown()
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
        volume: volume.value,
        sleepMinutes: sleepMinutes.value,
        sleepFade: sleepFade.value
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
      if (typeof stored.sleepMinutes === 'number' && stored.sleepMinutes >= 0 && stored.sleepMinutes <= 24 * 60) {
        sleepMinutes.value = stored.sleepMinutes
      }
      if (stored.sleepFade === 'end' || stored.sleepFade === 'full') {
        sleepFade.value = stored.sleepFade
      }
    }

    void ensureGraph()

    watch(
      [type, () => eq.low.gain, () => eq.mid.gain, () => eq.high.gain, volume, sleepMinutes, sleepFade],
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
    if (sleepTick !== null) clearInterval(sleepTick)
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
    sleepMinutes,
    sleepFade,
    sleepRemaining,
    start,
    stop,
    toggle,
    setType,
    setEq,
    setVolume,
    setSleepTimer,
    setSleepFade
  }
}
