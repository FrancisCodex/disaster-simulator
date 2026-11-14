import { useMemo, useRef } from 'react'
import { SPEEDS } from '../engine/config.js'
import { clockAt, elapsedText } from './news.js'

/** What the strip charts for this disaster: how bad it was at each recorded moment. */
function hazardOf(f) {
  if (f.typhoon) return f.typhoon.kmh10
  if (f.quake) return (f.totals?.trapped ?? 0) + (f.totals?.burning ?? 0) * 5
  return f.flood?.rain ?? 0
}

const W = 1000
const H = 44

/**
 * The scrubber: the hazard as a filled curve, deaths as a red line, a tick
 * for every warning (amber) and piece of bad news (red), and the playhead.
 * Click or drag to look back.
 */
export function Timeline({ s, replay, className = '' }) {
  const ref = useRef(null)
  const sim = s.sim
  const end = Math.max(sim.time, 1)
  const tl = sim.timeline
  const { area, deaths } = useMemo(() => {
    if (tl.length < 2) return { area: '', deaths: '' }
    const hz = tl.map(hazardOf)
    const hMax = Math.max(1e-6, ...hz)
    const dMax = Math.max(1, ...tl.map((f) => f.totals?.dead ?? 0))
    const x = (f) => ((f.time / end) * W).toFixed(1)
    let a = `M0,${H}`
    let d = ''
    tl.forEach((f, i) => {
      a += ` L${x(f)},${(H - 2 - (hz[i] / hMax) * (H - 8)).toFixed(1)}`
      d += `${i ? ' L' : 'M'}${x(f)},${(H - 2 - ((f.totals?.dead ?? 0) / dMax) * (H - 8)).toFixed(1)}`
    })
    a += ` L${x(tl[tl.length - 1])},${H} Z`
    return { area: a, deaths: dMax > 1 ? d : '' }
  }, [tl, end])

  const at = (e) => {
    const r = ref.current.getBoundingClientRect()
    replay.seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * sim.time)
  }
  const head = Math.min(100, (replay.t / end) * 100)
  const startHour = s.settings.startHour
  return (
    <div className={className}>
      <div
        ref={ref}
        role="slider"
        aria-label="Timeline: drag to look back"
        aria-valuemin={0}
        aria-valuemax={Math.round(sim.time)}
        aria-valuenow={Math.round(replay.t)}
        aria-valuetext={clockAt(startHour, replay.t)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') replay.step(-1)
          if (e.key === 'ArrowRight') replay.step(1)
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          at(e)
        }}
        onPointerMove={(e) => e.buttons & 1 && at(e)}
        className="relative h-11 cursor-ew-resize touch-none overflow-hidden rounded-md bg-slate-900/70 ring-1 ring-slate-700/60 outline-none focus-visible:ring-sky-400"
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <path d={area} fill="rgba(56,189,248,0.22)" stroke="rgba(125,211,252,0.7)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {replay.marks.map((e) => (
            <rect key={e.n} x={(e.t / end) * W - 1} y={e.level === 'bad' ? 0 : H * 0.35} width="2" height={H} fill={e.level === 'bad' ? 'rgba(239,68,68,0.75)' : 'rgba(251,191,36,0.55)'} />
          ))}
          {deaths && <path d={deaths} fill="none" stroke="rgba(248,113,113,0.95)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
        </svg>
        {/* what lies after the moment being looked at */}
        {replay.reviewing && <div className="absolute inset-y-0 right-0 bg-slate-950/65" style={{ left: `${head}%` }} />}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${head}%` }}>
          <div className="absolute -top-0.5 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-white shadow" />
        </div>
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
        <span>{clockAt(startHour, 0)}</span>
        <span className="font-sans">
          <span className="text-sky-300">▬</span> {sim.typhoon ? 'wind' : sim.quake ? 'trapped & burning' : 'rain'} · <span className="text-red-400">▬</span> deaths · <span className="text-amber-300">|</span> warnings{' '}
          <span className="text-red-400">|</span> bad news
        </span>
        <span>{clockAt(startHour, sim.time)}</span>
      </div>
    </div>
  )
}

const btn = 'rounded-md px-2.5 py-1.5 text-sm text-slate-200 hover:bg-slate-700/60'

/** Live / replay badge: red and steady while following the simulation, amber with a way back while looking at the past. */
export function LiveChip({ s, replay, short = false }) {
  if (replay.reviewing)
    return (
      <span className="flex items-center gap-1.5">
        {!short && (
          <span className="flex items-center gap-1.5 px-1 text-xs font-bold tracking-wider whitespace-nowrap text-amber-200 uppercase">
            <span className={`h-2 w-2 rounded-full bg-amber-400 ${replay.playing ? 'animate-pulse' : ''}`} />
            Replay
          </span>
        )}
        <button onClick={replay.live} className="rounded-md bg-amber-500/20 px-2.5 py-1.5 text-xs font-bold whitespace-nowrap text-amber-200 ring-1 ring-amber-400/70 hover:bg-amber-500/30" title="Leave the replay and return to the present">
          {short ? 'Replay ✕' : 'Skip to now ⇥'}
        </button>
      </span>
    )
  const done = s.phase === 'results'
  return (
    <span className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold tracking-wider whitespace-nowrap uppercase ${done ? 'text-slate-400' : 'text-red-300'}`}>
      <span className={`h-2 w-2 rounded-full ${done ? 'bg-slate-500' : s.sim.paused ? 'bg-red-400/50' : 'animate-pulse bg-red-500'}`} />
      {done ? 'Ended' : s.sim.paused ? 'Paused' : 'Live'}
    </span>
  )
}

/**
 * Desktop transport: pause, the clock, speed, step between events, and
 * whatever the caller adds at the end (lenses, end disaster), over the scrubber.
 */
export function ReplayBar({ s, game, replay, children }) {
  const sim = s.sim
  const done = s.phase === 'results'
  const startHour = s.settings.startHour
  const nth = sim.log.filter((e) => e.t <= replay.t).length
  return (
    <div className="panel pointer-events-auto px-3 pt-2.5 pb-2">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        {replay.reviewing ? (
          <button onClick={() => (replay.playing ? replay.pause() : replay.play())} className="w-[8.5rem] rounded-md bg-amber-500/25 px-3 py-1.5 text-sm font-semibold text-amber-100 ring-1 ring-amber-400/60 hover:bg-amber-500/35">
            {replay.playing ? '⏸ Pause replay' : '▶ Play replay'}
          </button>
        ) : done ? (
          <button onClick={() => replay.play(0)} className="w-[8.5rem] rounded-md bg-slate-700/70 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-600" title="Play the whole event again from the start">
            ⟲ Watch replay
          </button>
        ) : (
          <button onClick={() => game.togglePause()} className="w-[8.5rem] rounded-md bg-slate-700/70 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-600" title="Space">
            {sim.paused ? '▶ Resume' : '⏸ Pause'}
          </button>
        )}
        <div className="leading-tight">
          <div className={`font-mono text-lg font-bold tabular-nums ${replay.reviewing ? 'text-amber-200' : 'text-white'}`}>{clockAt(startHour, replay.t)}</div>
          <div className="text-[11px] text-slate-400">
            {elapsedText(replay.t)} · #{nth}
          </div>
        </div>
        {replay.reviewing ? (
          // the replay has its own speed: the simulation's is left alone
          <div className="flex overflow-hidden rounded-md ring-1 ring-amber-400/40" title="Replay speed">
            {SPEEDS.map((sp, i) => (
              <button key={sp.label} onClick={() => replay.setRate(i)} className={`px-2.5 py-1.5 text-xs ${replay.rate === i ? 'bg-amber-500/30 text-white' : 'text-slate-300 hover:bg-slate-700/60'}`}>
                {sp.label}
              </button>
            ))}
          </div>
        ) : (
          !done && (
            <div className="flex overflow-hidden rounded-md ring-1 ring-slate-700">
              {SPEEDS.map((sp, i) => (
                <button key={sp.label} onClick={() => game.setSpeed(i)} className={`px-2.5 py-1.5 text-xs ${sim.speedIdx === i && !sim.paused ? 'bg-sky-500/30 text-white' : 'text-slate-300 hover:bg-slate-700/60'}`}>
                  {sp.label}
                </button>
              ))}
            </div>
          )
        )}
        {sim.physicsLimited && !done && (
          <span className="text-[11px] text-amber-300" title="Flood physics is running as fast as your CPU allows">
            CPU-limited
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <LiveChip s={s} replay={replay} />
          {!replay.reviewing && !done && sim.time > 0 && (
            <button onClick={() => replay.play(0)} className={btn} title="Pause the simulation and play back what has happened so far, from the start">
              ⟲ Replay
            </button>
          )}
          <button onClick={() => replay.step(-1)} className={btn} title="Back to the previous warning or bad news" aria-label="Previous event">
            ⏮
          </button>
          <button onClick={() => replay.step(1)} disabled={!replay.reviewing} className={`${btn} disabled:opacity-35 disabled:hover:bg-transparent`} title="Forward to the next warning or bad news" aria-label="Next event">
            ⏭
          </button>
          {children}
        </div>
      </div>
      <Timeline s={s} replay={replay} />
    </div>
  )
}
