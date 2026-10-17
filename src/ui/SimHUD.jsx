import { SPEEDS } from '../engine/config.js'
import { Stat, BuildingPanel, WorldToggle, ModelToggle } from './common.jsx'
import { fmtInt, fmtMoney } from '../engine/math.js'

const fmtT = (t) => {
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  return `T+${h}h ${String(m).padStart(2, '0')}m`
}

const LOG_TONE = { bad: 'text-red-300', warn: 'text-amber-200', info: 'text-slate-300', good: 'text-emerald-300' }

export default function SimHUD({ s, game }) {
  const sim = s.sim
  const T = sim.totals
  const flood = sim.flood
  const quake = sim.quake
  const done = s.phase === 'results'
  return (
    <>
      {/* clock & controls */}
      <div className="pointer-events-none absolute top-3 right-3 left-3 flex justify-center">
        <div className="panel pointer-events-auto flex items-center gap-3 px-4 py-2">
          <div className="text-center">
            <div className="font-mono text-lg font-bold text-white tabular-nums">{sim.clock}</div>
            <div className="font-mono text-[11px] text-slate-400">{fmtT(sim.elapsed)}</div>
          </div>
          <div className="h-8 w-px bg-slate-700" />
          {!done && (
            <>
              <button onClick={() => game.togglePause()} className="rounded-md bg-slate-700/60 px-3 py-1.5 text-sm text-white hover:bg-slate-600" title="Space">
                {sim.paused ? '▶ Resume' : '⏸ Pause'}
              </button>
              <div className="flex overflow-hidden rounded-md ring-1 ring-slate-700">
                {SPEEDS.map((sp, i) => (
                  <button
                    key={sp.label}
                    onClick={() => game.setSpeed(i)}
                    className={`px-2.5 py-1.5 text-xs ${sim.speedIdx === i && !sim.paused ? 'bg-sky-500/30 text-white' : 'text-slate-300 hover:bg-slate-700/60'}`}
                  >
                    {sp.label}
                  </button>
                ))}
              </div>
              {sim.physicsLimited && <span className="text-[11px] text-amber-300" title="Flood physics is running as fast as your CPU allows">CPU-limited</span>}
              <div className="h-8 w-px bg-slate-700" />
              <button onClick={() => game.endDisaster()} className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-red-500">
                End disaster ■
              </button>
            </>
          )}
          <button onClick={() => game.toggleOverlay()} className={`rounded-md px-3 py-1.5 text-sm ${s.overlay ? 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-400' : 'text-slate-300 hover:bg-slate-700/60'}`}>
            {quake ? 'Damage view' : 'Flood depth view'}
          </button>
          <WorldToggle s={s} game={game} />
          <ModelToggle s={s} game={game} />
        </div>
      </div>

      {/* left: live stats */}
      <div className="pointer-events-auto absolute top-24 left-3 flex w-64 flex-col gap-2">
        <div className="panel p-3">
          {flood && (
            <div className="mb-3">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] tracking-wider text-slate-400 uppercase">Rainfall</span>
                <span className="font-mono text-sky-300">{flood.rain.toFixed(1)} mm/h</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-700">
                <div className="h-full bg-sky-400 transition-all" style={{ width: `${Math.min(100, (flood.rain / 120) * 100)}%` }} />
              </div>
              <div className="mt-1 text-xs text-slate-400">Total {flood.cumRain.toFixed(0)} mm · river inflow {fmtInt(flood.inflow)} m³/s</div>
              <div className="mt-2 flex items-baseline justify-between">
                <span className="text-[11px] tracking-wider text-slate-400 uppercase">River level</span>
                <span className={`font-mono ${flood.stage > 0 ? 'text-red-400' : flood.stage > -1 ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {flood.stage > 0 ? `+${flood.stage.toFixed(2)} m over banks` : `${(-flood.stage).toFixed(2)} m below bank`}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-700">
                <div className={`h-full transition-all ${flood.stage > 0 ? 'bg-red-500' : 'bg-amber-400'}`} style={{ width: `${Math.max(0, Math.min(100, ((flood.stage + 4.5) / 6) * 100))}%` }} />
              </div>
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
                  <div className="text-xs text-slate-400">{quake.fires} fires started</div>
                </>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="Deaths" value={fmtInt(T.dead)} tone={T.dead >= 1 ? 'text-red-400' : 'text-white'} sub={`of ${fmtInt(sim.population)}`} />
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
        </div>
      </div>

      {/* right: log + selection */}
      <div className="pointer-events-auto absolute top-24 right-3 flex max-h-[calc(100vh-7rem)] w-80 flex-col gap-2">
        <div className="panel flex min-h-0 flex-col p-3">
          <div className="mb-1 text-[11px] tracking-wider text-slate-400 uppercase">Event log</div>
          <div className="scroll-thin max-h-72 overflow-y-auto pr-1">
            {[...sim.log].reverse().map((e, i) => (
              <div key={sim.log.length - i} className="border-b border-slate-800 py-1 text-[12.5px] leading-snug">
                <span className="mr-1.5 font-mono text-[11px] text-slate-500">{fmtT(e.t)}</span>
                <span className={LOG_TONE[e.level] ?? 'text-slate-300'}>{e.text}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="scroll-thin min-h-0 overflow-y-auto">
          <BuildingPanel info={s.selected} title="Selected" onClose={() => game.select(null)} />
        </div>
      </div>
      {!s.selected && <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-slate-300/80 drop-shadow">Click a building to inspect it · Right-drag to rotate · Scroll to zoom</div>}
    </>
  )
}
