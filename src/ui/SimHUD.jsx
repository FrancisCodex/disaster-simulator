import { SPEEDS } from '../engine/config.js'
import { useMemo, useState } from 'react'
import { Stat, BuildingPanel, Sheet } from './common.jsx'
import { useIsMobile } from './useIsMobile.js'
import { fmtInt, fmtMoney } from '../engine/math.js'
import { SignalChip } from './TyphoonScenario.jsx'
import LensPanel from './LensPanel.jsx'
import { buildFeed } from './news.js'
import { NewsFeed, Ticker } from './NewsFeed.jsx'
import { ReplayBar, Timeline, LiveChip } from './ReplayBar.jsx'
import { useReplay } from './useReplay.js'

/** How the people outside are reacting: calm → frightened → fleeing → panicking. */
function PanicBar({ p }) {
  if (!p || !p.outside) return null
  const parts = [
    ['calm', p.calm, 'bg-emerald-500'],
    ['frightened', p.alarmed, 'bg-amber-400'],
    ['fleeing', p.fleeing, 'bg-orange-500'],
    ['panicking', p.panicking, 'bg-red-500'],
  ]
  return (
    <div className="mt-2">
      <div className="text-[11px] tracking-wider text-slate-400 uppercase">People outside</div>
      <div className="mt-1 flex h-2 overflow-hidden rounded bg-slate-700">
        {parts.map(([k, n, c]) => (
          <div key={k} className={`${c} h-full transition-all`} style={{ width: `${(n / p.outside) * 100}%` }} title={`${k}: ${n}`} />
        ))}
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        {parts
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${Math.round((n / p.outside) * 100)}% ${k}`)
          .join(' · ')}
        {(p.carsStopped > 0 || p.carsAbandoned > 0) && (
          <div>
            {p.carsStopped > 0 && `${p.carsStopped} cars pulled over`}
            {p.carsStopped > 0 && p.carsAbandoned > 0 && ' · '}
            {p.carsAbandoned > 0 && <span className="text-orange-300">{p.carsAbandoned} abandoned</span>}
          </div>
        )}
      </div>
    </div>
  )
}

const LENS_NAME = { flood: 'Flood depth', damage: 'Damage', power: 'Power' }

const hrs = (tau) => {
  const a = Math.abs(tau)
  const t = a < 1 ? `${Math.round(a * 60)} min` : `${a.toFixed(a < 10 ? 1 : 0)} h`
  return tau < 0 ? `closest in ${t}` : `${t} since closest`
}

/** The typhoon at the city right now: signal, wind, pressure and where the centre is. */
function StormNow({ ty }) {
  const kmh = Math.round(ty.kmh10)
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] tracking-wider text-slate-400 uppercase">Wind signal</span>
        <SignalChip n={ty.signal} />
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-[11px] tracking-wider text-slate-400 uppercase">Wind</span>
        <span className={`font-mono ${kmh >= 118 ? 'text-red-400' : kmh >= 62 ? 'text-amber-300' : 'text-slate-200'}`}>
          {kmh} km/h <span className="text-slate-400">gusts {Math.round(ty.gust * 3.6)}</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-700">
        <div className={`h-full transition-all ${kmh >= 118 ? 'bg-red-500' : kmh >= 62 ? 'bg-amber-400' : 'bg-slate-400'}`} style={{ width: `${Math.min(100, (kmh / 250) * 100)}%` }} />
      </div>
      <div className="mt-1 text-xs text-slate-400">
        {ty.eye ? <span className="text-amber-200">In the eye — calm, for now</span> : `From the ${ty.from}`} · {Math.round(ty.p)} hPa
      </div>
      <div className="text-xs text-slate-400">
        {ty.category.name} centre {Math.round(ty.dist)} km {ty.bearing} · {hrs(ty.tau)}
        {ty.overLand && ' · over land'}
      </div>
      <div className="text-[11px] text-slate-500">
        10-min sustained (PAGASA); peak so far {Math.round(ty.peak.kmh10)} km/h{ty.peak.signal ? `, Signal No. ${ty.peak.signal}` : ''}
      </div>
    </div>
  )
}

/** What the wind has done so far: roofs, glass, flattened buildings, trees and power. */
function WindToll({ w }) {
  const any = w.glass + w.cover + w.roof + w.collapsed + w.trees + w.poles > 0 || w.power < 1
  if (!any) return null
  const out = Math.round((1 - w.power) * 100)
  return (
    <div className="mb-3">
      <div className="text-[11px] tracking-wider text-slate-400 uppercase">Wind damage</div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 text-xs">
        <span className="text-slate-400">
          Roofs lost <span className={w.roof ? 'text-orange-300' : 'text-slate-200'}>{fmtInt(w.roof)}</span>
        </span>
        <span className="text-slate-400">
          Sheets / tiles <span className="text-slate-200">{fmtInt(w.cover)}</span>
        </span>
        <span className="text-slate-400">
          Flattened <span className={w.collapsed ? 'text-red-300' : 'text-slate-200'}>{fmtInt(w.collapsed)}</span>
        </span>
        <span className="text-slate-400">
          Windows <span className="text-slate-200">{fmtInt(w.glass)}</span>
        </span>
        <span className="text-slate-400">
          Trees down <span className="text-slate-200">{fmtInt(w.trees)}</span>
        </span>
        <span className="text-slate-400">
          Roads blocked <span className={w.roads ? 'text-amber-300' : 'text-slate-200'}>{fmtInt(w.roads)}</span>
        </span>
        <span className="text-slate-400">
          Poles down <span className="text-slate-200">{fmtInt(w.poles)}</span>
        </span>
      </div>
      {out > 0 && (
        <div className="mt-1 text-xs text-amber-300">
          ⚡ {w.gridUp ? `${out}% of the city without power` : 'Citywide blackout'}
          {w.pumpsOff > 0 && <span className="text-red-300"> · {w.pumpsOff} pump{w.pumpsOff > 1 ? 's' : ''} stopped</span>}
        </div>
      )}
    </div>
  )
}

/** Thunderstorms: lightning over and in the city, and a tornado on the ground. */
function StormsNow({ st }) {
  const T = st.tornado
  const every = st.flashRate > 0.05 ? 3600 / (st.flashRate * 314) : null
  if (!T && !st.strikes && !every && !st.tornadoes && !st.nearTornadoes) return null
  return (
    <div className="mb-3">
      {T && (
        <div className={`mb-2 rounded-md px-2 py-1.5 text-xs font-semibold ${T.down ? 'animate-pulse bg-red-600/80 text-white' : 'bg-red-500/25 text-red-100'}`}>
          🌪️ {T.down ? `Tornado on the ground: ${T.ef}, ${T.kmh} km/h` : 'Tornado warning: take cover on the lowest floor'}
          {T.damaged > 0 && <span className="font-normal"> · {T.damaged} buildings hit</span>}
        </div>
      )}
      <div className="text-[11px] tracking-wider text-slate-400 uppercase">Thunderstorms</div>
      <div className="mt-1 text-xs text-slate-400">
        ⚡ {every ? `Lightning every ~${every < 60 ? `${Math.max(1, Math.round(every))} s` : `${Math.round(every / 60)} min`} within 10 km` : 'No lightning nearby'}
        {' · '}
        <span className={st.strikes ? 'text-amber-300' : 'text-slate-200'}>{st.strikes}</span> strike{st.strikes === 1 ? '' : 's'} in the city
        {st.fires > 0 && <span className="text-orange-300"> · {st.fires} fire{st.fires > 1 ? 's' : ''}</span>}
      </div>
      {(st.tornadoes > 0 || st.nearTornadoes > 0) && (
        <div className="text-xs text-slate-400">
          🌪️ {st.tornadoes ? `${st.tornadoes} crossed the city` : ''}
          {st.tornadoes && st.nearTornadoes ? ' · ' : ''}
          {st.nearTornadoes ? `${st.nearTornadoes} reported nearby` : ''}
        </div>
      )}
    </div>
  )
}

/** The sea at the coast: level above normal (surge + tide) against the beachfront. */
function SeaNow({ sea }) {
  const over = sea.rise > sea.shore
  const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} m`
  return (
    <>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-[11px] tracking-wider text-slate-400 uppercase">Sea level</span>
        <span className={`font-mono ${over ? 'text-red-400' : sea.rise > 1 ? 'text-amber-300' : 'text-emerald-300'}`}>{signed(sea.rise)} vs normal</span>
      </div>
      <div className="relative mt-1 h-1.5 overflow-hidden rounded bg-slate-700">
        <div className={`h-full transition-all ${over ? 'bg-red-500' : 'bg-cyan-400'}`} style={{ width: `${Math.max(0, Math.min(100, ((sea.rise + 1) / 8) * 100))}%` }} />
        <div className="absolute top-0 h-full w-0.5 bg-white/70" style={{ left: `${Math.min(100, ((sea.shore + 1) / 8) * 100)}%` }} title="Top of the beachfront" />
      </div>
      <div className="mt-1 text-xs text-slate-400">
        Surge {signed(sea.surge)} · tide {signed(sea.tide)} · beachfront +{sea.shore.toFixed(1)} m{sea.max > 0.3 ? ` · highest ${signed(sea.max)}` : ''}
      </div>
    </>
  )
}

/** What the disaster is doing right now: rain and river, or shocks, fires and ground failure. */
function Situation({ s }) {
  const { flood, quake, typhoon: ty, wind, storms, totals: T } = s.sim
  return (
    <>
    {ty && <StormNow ty={ty} />}
    {wind && <WindToll w={wind} />}
    {storms && <StormsNow st={storms} />}
    {flood && (
      <div className="mb-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] tracking-wider text-slate-400 uppercase">Rainfall</span>
          <span className="font-mono text-sky-300">{flood.rain.toFixed(1)} mm/h</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-700">
          <div className="h-full bg-sky-400 transition-all" style={{ width: `${Math.min(100, (flood.rain / 120) * 100)}%` }} />
        </div>
        <div className="mt-1 text-xs text-slate-400">Total {flood.cumRain.toFixed(0)} mm · upstream {flood.basinRain.toFixed(0)} mm/h · river inflow {fmtInt(flood.inflow)} m³/s</div>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-[11px] tracking-wider text-slate-400 uppercase">River level</span>
          <span className={`font-mono ${flood.stage > 0 ? 'text-red-400' : flood.stage > -1 ? 'text-amber-300' : 'text-emerald-300'}`}>
            {flood.stage > 0 ? `+${flood.stage.toFixed(2)} m over banks` : `${(-flood.stage).toFixed(2)} m below bank`}
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-700">
          <div className={`h-full transition-all ${flood.stage > 0 ? 'bg-red-500' : 'bg-amber-400'}`} style={{ width: `${Math.max(0, Math.min(100, ((flood.stage + 4.5) / 6) * 100))}%` }} />
        </div>
        {(flood.alarm != null || flood.diverted != null || flood.gate != null) && (
          <div className="mt-1 text-xs text-slate-400">
            {flood.alarm != null && <span className={flood.alarm >= 2 ? 'text-red-300' : flood.alarm ? 'text-amber-300' : ''}>{flood.alarm ? `River alarm ${flood.alarm}` : 'No river alarm'}</span>}
            {flood.diverted > 1 && <span> · floodway taking {fmtInt(flood.diverted)} m³/s</span>}
            {flood.gate != null && <span className={flood.gate ? 'text-amber-300' : ''}> · river gate {flood.gate ? 'shut' : 'open'}</span>}
          </div>
        )}
        {flood.sea && <SeaNow sea={flood.sea} />}
        {s.sim.shelters && (s.sim.shelters.cap > 0 || s.sim.shelters.sheltered > 0) && (
          <div className="mt-1 text-xs text-slate-400">
            ⛺ {fmtInt(s.sim.shelters.sheltered)} in shelters of {fmtInt(s.sim.shelters.cap)} places
            {s.sim.shelters.crowded && <span className="text-orange-300"> · overcrowded</span>}
          </div>
        )}
        <div className="mt-2 text-xs">{flood.warned ? <span className="text-amber-300">⚠ Evacuation order in effect</span> : <span className="text-slate-500">No warning issued</span>}</div>
      </div>
    )}
    {quake && (
      <div className="mb-3">
        {!quake.mainDone ? (
          <div className="text-sm text-slate-300">Everything is calm…</div>
        ) : (
          <>
            <div className="text-[11px] tracking-wider text-slate-400 uppercase">Last shock</div>
            <div className="font-mono text-amber-300">
              M{quake.lastShock.M.toFixed(1)} · {quake.lastShock.pga.toFixed(2)} g
            </div>
            <div className="mt-1 text-xs text-slate-400">
              {quake.shocks - 1} aftershocks (M4+){quake.maxAfter ? `, largest M${quake.maxAfter.toFixed(1)}` : ''}
            </div>
            <div className="text-xs text-slate-400">
              {quake.fires} fires started · wind {quake.wind.speed.toFixed(1)} m/s from the {quake.wind.from}
              {(quake.treesBurning > 0 || quake.treesBurnt > 0) && (
                <span className="text-orange-300">
                  {' '}
                  · {quake.treesBurning} trees burning, {quake.treesBurnt} burnt
                </span>
              )}
            </div>
            <div className="mt-2 text-[11px] tracking-wider text-slate-400 uppercase">Standing buildings</div>
            <div className="mt-1 h-2 overflow-hidden rounded bg-slate-700">
              <div
                className={`h-full transition-all ${T.integrity < 0.5 ? 'bg-red-500' : T.integrity < 0.75 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                style={{ width: `${Math.round(T.integrity * 100)}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-slate-400">
              {Math.round(T.integrity * 100)}% average integrity · {fmtInt(T.weakened)} badly weakened
              {T.lateCollapses > 0 && <span className="text-red-300"> · {fmtInt(T.lateCollapses)} fell after the main shock</span>}
            </div>
            {(quake.ground.liquefiedHa > 0 || quake.ground.slides > 0) && (
              <div className="mt-1 text-xs text-amber-300/90">
                Ground failure: {quake.ground.liquefiedHa > 0 && `${quake.ground.liquefiedHa.toFixed(1)} ha liquefied`}
                {quake.ground.liquefiedHa > 0 && quake.ground.slides > 0 && ' · '}
                {quake.ground.slides > 0 && `${quake.ground.slides} landslide${quake.ground.slides > 1 ? 's' : ''}`}
                {T.leaning > 0 && ` · ${T.leaning} leaning`}
              </div>
            )}
            {quake.bridges > 0 && (
              <div className="mt-1 text-xs text-red-300">
                {quake.bridges} bridge{quake.bridges > 1 ? 's' : ''} closed{quake.bridgesDown ? `, ${quake.bridgesDown} collapsed` : ''}
              </div>
            )}
            <PanicBar p={quake.panic} />
          </>
        )}
      </div>
    )}
    </>
  )
}

function StatGrid({ s }) {
  const { quake, totals: T } = s.sim
  return (
    <>
    <div className="grid grid-cols-2 gap-1.5">
      <Stat label="Deaths" value={fmtInt(T.dead)} tone={T.dead >= 1 ? 'text-red-400' : 'text-white'} sub={`of ${fmtInt(s.sim.population)}`} />
      <Stat label="Injured" value={fmtInt(T.injured)} tone="text-amber-300" />
      {quake ? (
        <>
          <Stat label="Trapped" value={fmtInt(T.trapped)} tone={T.trapped >= 1 ? 'text-orange-300' : 'text-white'} sub={`${fmtInt(T.rescued)} rescued`} />
          <Stat label="Awaiting care" value={fmtInt(T.critUntreated)} tone={T.critUntreated >= 1 ? 'text-orange-300' : 'text-white'} sub={`${fmtInt(T.treated)} treated`} />
          <Stat label="Damaged" value={fmtInt(T.damaged)} sub={`${fmtInt(T.destroyed)} destroyed`} />
          <Stat label="Burning" value={fmtInt(T.burning)} tone={T.burning ? 'text-orange-400' : 'text-white'} />
        </>
      ) : (
        <>
          <Stat label="In danger" value={fmtInt(T.atRisk)} tone={T.atRisk >= 1 ? 'text-orange-300' : 'text-white'} sub="water > 0.5 m inside" />
          <Stat label="Evacuated" value={fmtInt(T.evacuated)} tone="text-sky-300" sub={`${fmtInt(T.rescued)} by boat`} />
          <Stat label="Flooded" value={fmtInt(T.flooded)} sub="buildings" />
          <Stat label="Destroyed" value={fmtInt(T.destroyed)} />
        </>
      )}
    </div>
    <div className="mt-2 flex justify-between text-xs text-slate-400">
      <span>Economic loss</span>
      <span className="font-mono text-slate-200">{fmtMoney(T.loss)}</span>
    </div>
    </>
  )
}

function readFeedOpen() {
  try {
    return localStorage.getItem('metrorisk.open.feed') !== '0'
  } catch {
    return true
  }
}

export default function SimHUD({ s, game }) {
  const mobile = useIsMobile()
  const replay = useReplay(s, game)
  // the feed as of the moment on screen: everything so far, or up to the point being replayed
  const { view } = replay
  const feed = useMemo(() => buildFeed(view.sim.log, s.city.name), [view.sim.log, s.city.name])
  return mobile ? <MobileSim s={s} view={view} game={game} replay={replay} feed={feed} /> : <DesktopSim s={s} view={view} game={game} replay={replay} feed={feed} />
}

/**
 * Desktop and tablet: the situation on the left, the selected building on the
 * right, and along the bottom the news feed, the headline ticker and the
 * replay bar. s is the simulation now; view is s, or the recorded moment
 * being replayed.
 */
function DesktopSim({ s, view, game, replay, feed }) {
  const sim = s.sim
  const quake = sim.quake
  const done = s.phase === 'results'
  const startHour = s.settings.startHour
  const [lenses, setLenses] = useState(false)
  const [feedOpen, setFeedOpen] = useState(readFeedOpen)
  const lensOn = (sim.lens ?? 'city') !== 'city'
  // the button is the on/off switch: on opens the panel on the flood depth lens, off returns to the plain city
  const toggleLenses = () => {
    if (lenses || lensOn) {
      setLenses(false)
      game.setLens('city')
    } else {
      setLenses(true)
      game.setLens('flood')
    }
  }
  const toggleFeed = () => {
    setFeedOpen(!feedOpen)
    try {
      localStorage.setItem('metrorisk.open.feed', feedOpen ? '0' : '1')
    } catch {
      /* storage unavailable: it just won't be remembered */
    }
  }
  return (
    <>
      {/* left: the situation and the toll, now or at the moment being replayed */}
      <div className="scroll-thin pointer-events-auto absolute top-3 left-3 max-h-[calc(100vh-1.5rem)] w-64 overflow-y-auto">
        <div className={`panel p-3 ${replay.reviewing ? 'ring-1 ring-amber-400/60' : ''}`}>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-bold text-white">{s.city.name}</span>
            <span className={`font-mono text-[11px] whitespace-nowrap ${replay.reviewing ? 'text-amber-200' : 'text-slate-400'}`}>{view.sim.clock}</span>
          </div>
          {replay.reviewing && <div className="mb-2 rounded bg-amber-500/15 px-2 py-1 text-[11px] leading-snug text-amber-100">Replay: these readings and the news are from this moment. The 3D city shows the present.</div>}
          <Situation s={view} />
          <StatGrid s={view} />
        </div>
      </div>

      {/* right: the selected building */}
      {s.selected && (
        <div className="scroll-thin pointer-events-auto absolute top-3 right-3 max-h-[calc(100vh-1.5rem)] w-80 overflow-y-auto">
          <BuildingPanel info={s.selected} title="Selected" onClose={() => game.select(null)} />
        </div>
      )}

      {/* middle: lenses on top; the feed, the ticker and the replay bar docked at the bottom */}
      <div className={`pointer-events-none absolute top-3 bottom-3 left-[17.5rem] flex flex-col justify-between gap-2 ${s.selected ? 'right-[21.5rem]' : 'right-3'}`}>
        <div className="scroll-thin pointer-events-auto min-h-0 w-72 overflow-y-auto">
          {(lenses || lensOn) && !quake && (
            <LensPanel
              s={s}
              game={game}
              onClose={() => {
                setLenses(false)
                game.setLens('city')
              }}
            />
          )}
        </div>
        <div className="mx-auto flex w-full max-w-5xl shrink-0 flex-col gap-2">
          {feedOpen && (
            <div className="panel fadein pointer-events-auto overflow-hidden">
              <NewsFeed items={feed} startHour={startHour} className="max-h-[34vh]" />
            </div>
          )}
          <Ticker items={feed} startHour={startHour} open={feedOpen} onToggle={toggleFeed} />
          <ReplayBar s={s} game={game} replay={replay}>
            {quake ? (
              <button onClick={() => game.toggleOverlay()} className={`rounded-md px-3 py-1.5 text-sm ${s.overlay ? 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-400' : 'text-slate-300 hover:bg-slate-700/60'}`}>
                Integrity view
              </button>
            ) : (
              <button onClick={toggleLenses} title="Turn the lenses on or off (L)" className={`rounded-md px-3 py-1.5 text-sm ${lenses || lensOn ? 'bg-sky-500/25 text-sky-100 ring-1 ring-sky-400' : 'text-slate-300 hover:bg-slate-700/60'}`}>
                🔍 Lenses {lenses || lensOn ? 'on' : 'off'}
              </button>
            )}
            {!done && (
              <button onClick={() => game.endDisaster()} className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-red-500">
                End disaster ■
              </button>
            )}
          </ReplayBar>
        </div>
      </div>
    </>
  )
}

function Mini({ label, value, tone = 'text-white' }) {
  return (
    <div>
      <div className="text-[9px] tracking-wide text-slate-400 uppercase">{label}</div>
      <div className={`font-mono text-sm font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  )
}

/** Phone layout: clock and controls on top, the key numbers under them, details, log and the selected building in sheets. */
function MobileSim({ s, view, game, replay, feed }) {
  const [sheet, setSheet] = useState(null) // 'details' | 'log' | 'lens'
  const sim = s.sim
  const T = view.sim.totals
  const quake = sim.quake
  const done = s.phase === 'results'
  const open = (k) => setSheet(sheet === k ? null : k)
  const tab = (k) => `rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap ${sheet === k ? 'bg-sky-500/25 text-white ring-1 ring-sky-400' : 'text-slate-300'}`
  return (
    <>
      <div className="pointer-events-none absolute top-2 right-2 left-2">
        <div className="panel pointer-events-auto flex items-center gap-2 px-2.5 py-1.5">
          <div className="min-w-0">
            <div className={`font-mono text-sm font-bold tabular-nums ${replay.reviewing ? 'text-amber-200' : 'text-white'}`}>{view.sim.clock}</div>
          </div>
          <LiveChip s={s} replay={replay} short />
          {!done && (
            <>
              <button onClick={() => game.togglePause()} className="ml-auto rounded-md bg-slate-700/60 px-2.5 py-1.5 text-sm text-white" aria-label={sim.paused ? 'Resume' : 'Pause'}>
                {sim.paused ? '▶' : '⏸'}
              </button>
              <select value={sim.speedIdx} onChange={(e) => game.setSpeed(+e.target.value)} aria-label="Speed" className="rounded-md bg-slate-800 px-1.5 py-1.5 text-xs text-white ring-1 ring-slate-700">
                {SPEEDS.map((sp, i) => (
                  <option key={sp.label} value={i}>
                    {sp.label}
                  </option>
                ))}
              </select>
              <button onClick={() => game.endDisaster()} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-bold whitespace-nowrap text-white">
                End ■
              </button>
            </>
          )}
        </div>
        <div className="panel pointer-events-auto mt-1.5 grid grid-cols-4 gap-1 px-2 py-1.5 text-center">
          <Mini label="Deaths" value={fmtInt(T.dead)} tone={T.dead >= 1 ? 'text-red-400' : 'text-white'} />
          <Mini label="Injured" value={fmtInt(T.injured)} tone="text-amber-300" />
          {quake ? <Mini label="Trapped" value={fmtInt(T.trapped)} tone={T.trapped >= 1 ? 'text-orange-300' : 'text-white'} /> : <Mini label="In danger" value={fmtInt(T.atRisk)} tone={T.atRisk >= 1 ? 'text-orange-300' : 'text-white'} />}
          <Mini label="Destroyed" value={fmtInt(T.destroyed)} />
        </div>
      </div>

      <div className="safe-bottom pointer-events-none absolute right-0 bottom-0 left-0 flex flex-col gap-1.5 px-2">
        {s.selected ? (
          <div className="scroll-thin pointer-events-auto max-h-[45vh] overflow-y-auto">
            <BuildingPanel info={s.selected} title="Selected" onClose={() => game.select(null)} />
          </div>
        ) : sheet === 'details' ? (
          <Sheet title={replay.reviewing ? `Situation at ${view.sim.clock}` : 'Situation'} onClose={() => setSheet(null)}>
            <Situation s={view} />
            <StatGrid s={view} />
          </Sheet>
        ) : sheet === 'log' ? (
          <Sheet title="News feed" onClose={() => setSheet(null)}>
            <NewsFeed items={feed} startHour={s.settings.startHour} />
          </Sheet>
        ) : sheet === 'lens' ? (
          <div className="scroll-thin pointer-events-auto max-h-[55vh] overflow-y-auto">
            <LensPanel s={s} game={game} onClose={() => setSheet(null)} />
          </div>
        ) : (sim.lens ?? 'city') !== 'city' ? (
          // the lens stays on while its sheet is closed, so the map can be seen; this turns it off
          <div className="panel pointer-events-auto flex items-center gap-2 px-3 py-1.5 text-[13px]">
            <span className="text-sky-200">🔍 {LENS_NAME[sim.lens]} lens on</span>
            <button onClick={() => setSheet('lens')} className="ml-auto rounded-md px-2 py-1 text-slate-300">
              Change
            </button>
            <button onClick={() => game.setLens('city')} className="rounded-md bg-slate-700/70 px-2.5 py-1 font-semibold text-white">
              Turn off
            </button>
          </div>
        ) : null}
        {sheet !== 'log' && !s.selected && <Ticker items={feed} startHour={s.settings.startHour} open={false} onToggle={() => open('log')} />}
        <Timeline s={s} replay={replay} className="panel pointer-events-auto px-2 pt-2 pb-1" />
        <div className="panel pointer-events-auto flex items-center gap-1 px-2 py-1.5">
          <button onClick={() => open('details')} className={tab('details')}>
            Details
          </button>
          <button onClick={() => open('log')} className={tab('log')}>
            News
          </button>
          <button
            onClick={() => {
              if (quake) return game.toggleOverlay()
              if (sheet !== 'lens' && (sim.lens ?? 'city') === 'city') game.setLens('flood')
              open('lens')
            }}
            className={`rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap ${s.overlay ? 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-400' : 'text-slate-300'}`}
          >
            {quake ? 'Integrity' : 'Lenses'}
          </button>
          <span className="ml-auto text-[11px] text-slate-500">Tap a building</span>
        </div>
      </div>
    </>
  )
}
