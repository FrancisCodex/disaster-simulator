import { DEPTH_BANDS } from '../engine/floodMap.js'
import { fmtInt } from '../engine/math.js'

const rgb = (c) => `rgb(${c.join(',')})`
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} m`
const when = (tau) => (Math.abs(tau) < 0.5 ? 'around closest approach' : tau > 0 ? `~${Math.round(tau)} h after closest approach` : `~${Math.round(-tau)} h before closest approach`)

/** What is under the cursor on the flood map. */
function HereReadout({ c }) {
  if (!c) return <div className="text-[11px] text-slate-500">Point at the map to read the depth there.</div>
  if (c.sea) return <div className="text-[11px] text-slate-400">The sea.</div>
  if (c.river) return <div className="text-[11px] text-slate-400">The river channel.</div>
  return (
    <div className="text-[11px] text-slate-300">
      {c.depth > 0.02 ? (
        <>
          <span className="font-semibold text-sky-300">{c.depth.toFixed(2)} m deep</span> {c.source === 3 ? '(storm surge)' : c.source === 2 ? '(rain ponding in a hollow)' : '(river water)'}
        </>
      ) : (
        <span className="text-emerald-300">Dry</span>
      )}
      <span className="text-slate-400">
        {' '}
        · ground {c.aboveSea != null ? `${c.aboveSea.toFixed(1)} m above sea level` : `${signed(c.aboveBank)} vs the riverbank`}
        {c.wall ? ' · flood wall' : ''}
      </span>
    </div>
  )
}

/** Sea level for the map (surge + tide above normal) and the forecast peak. */
function SeaLevel({ M, game }) {
  const F = M.forecast.sea
  return (
    <div className="mt-2">
      <label className="block">
        <div className="flex justify-between text-xs">
          <span className="text-slate-400">Sea level (surge + tide)</span>
          <span className="font-mono text-sky-300">{signed(M.sea)} vs normal</span>
        </div>
        <input type="range" min={-1} max={8} step={0.1} value={M.sea} onChange={(e) => game.setSeaLevelMap(+e.target.value)} className="w-full accent-sky-400" />
      </label>
      {F && (
        <div className="text-[11px] text-slate-400">
          Forecast peak: <span className="text-slate-200">{signed(F.peak)}</span> ({F.surgeAtPeak.toFixed(1)} m surge, tide {signed(F.tideAtPeak)}, {when(F.peakTau)})
          {!M.seaAuto && (
            <button onClick={() => game.setSeaLevelMap(null)} className="ml-1 text-sky-300 hover:text-sky-200">
              use forecast
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The typhoon risk map: flood depth over the land at a chosen river level
 * and, on the coast, sea level (the forecast peaks by default), or wind
 * damage risk to buildings.
 */
export default function RiskMapPanel({ s, game, compact = false }) {
  const layer = s.riskLayer ?? 'flood'
  const M = s.floodMap
  const chip = (k, label) => (
    <button onClick={() => game.setRiskLayer(k)} className={`flex-1 rounded-md px-2 py-1 text-xs ${layer === k ? 'bg-sky-500/25 font-semibold text-white ring-1 ring-sky-400' : 'text-slate-300 hover:bg-slate-700/50'}`}>
      {label}
    </button>
  )
  return (
    <div className={`panel p-3 ${compact ? 'text-xs' : ''}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] tracking-wider text-slate-400 uppercase">Risk map</span>
        <button onClick={() => game.toggleOverlay()} className="text-xs text-slate-500 hover:text-white" aria-label="Close risk map">
          ✕
        </button>
      </div>
      <div className="mb-2 flex gap-1 rounded-lg bg-slate-900/50 p-1">
        {chip('flood', '🌊 Flood depth')}
        {chip('wind', '💨 Wind damage')}
      </div>
      {layer === 'flood' && M && (
        <>
          <label className="block">
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">River level</span>
              <span className="font-mono text-sky-300">{signed(M.level)} vs banks</span>
            </div>
            <input type="range" min={-3} max={5} step={0.1} value={M.level} onChange={(e) => game.setFloodLevel(+e.target.value)} className="w-full accent-sky-400" />
          </label>
          <div className="text-[11px] text-slate-400">
            Forecast peak for this storm: <span className="text-slate-200">{signed(M.forecast.stage)}</span> ({fmtInt(M.forecast.inflow)} m³/s, {when(M.forecast.tPeak)})
            {!M.auto && (
              <button onClick={() => game.setFloodLevel(null)} className="ml-1 text-sky-300 hover:text-sky-200">
                use forecast
              </button>
            )}
          </div>
          {M.sea != null && <SeaLevel M={M} game={game} />}
          <div className="mt-2 grid grid-cols-1 gap-0.5">
            {DEPTH_BANDS.map((b) => (
              <div key={b.label} className="flex items-center gap-2 text-[11px]">
                <span className="inline-block h-2.5 w-4 shrink-0 rounded-sm" style={{ background: rgb(b.color) }} />
                <span className="w-16 shrink-0 font-mono text-slate-200">{b.label}</span>
                <span className="truncate text-slate-400">{b.note}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1 text-center">
            <div className="rounded bg-slate-800/60 px-1 py-1">
              <div className="font-mono text-sm text-sky-300">{M.areaHa.toFixed(1)} ha</div>
              <div className="text-[10px] text-slate-400">land under water</div>
            </div>
            <div className="rounded bg-slate-800/60 px-1 py-1">
              <div className={`font-mono text-sm ${M.buildingsWet ? 'text-orange-300' : 'text-slate-200'}`}>{fmtInt(M.buildingsWet)}</div>
              <div className="text-[10px] text-slate-400">buildings flooded inside</div>
            </div>
            <div className="rounded bg-slate-800/60 px-1 py-1">
              <div className={`font-mono text-sm ${M.peopleWet ? 'text-orange-300' : 'text-slate-200'}`}>{fmtInt(M.peopleWet)}</div>
              <div className="text-[10px] text-slate-400">people in them</div>
            </div>
          </div>
          <div className="mt-2">
            <HereReadout c={M.cell} />
          </div>
          {!compact && (
            <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
              Water spreads from the river{M.sea != null ? ' and the sea' : ''} to all low ground it can reach. Flood walls keep it out while they hold, and hollows fill with rain. Drag the level to see what each extra metre of {M.sea != null ? 'river or sea' : 'river'} puts under water.
            </p>
          )}
        </>
      )}
      {layer === 'wind' && (
        <>
          <div className="h-2 rounded" style={{ background: 'linear-gradient(90deg, hsl(130,70%,48%), hsl(55,85%,50%), hsl(0,85%,50%))' }} />
          <div className="mt-0.5 flex justify-between text-[10px] text-slate-400">
            <span>holds</span>
            <span>loses its roof</span>
            <span>flattened</span>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">Each building's chance of losing its roof or being flattened at the forecast peak gusts. Click one for the details.</p>
        </>
      )}
    </div>
  )
}
