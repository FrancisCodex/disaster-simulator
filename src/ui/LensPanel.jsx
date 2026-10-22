import { DEPTH_BANDS } from '../engine/floodMap.js'
import { fmtInt } from '../engine/math.js'

const LENSES = [
  ['city', '🗺️', 'City', 'The plain map, no analysis.'],
  ['flood', '🌊', 'Flood depth', 'Standing water by what it stops: cars float at 0.3 m, wading turns deadly at 0.6 m.'],
  ['damage', '🏚️', 'Damage', 'Buildings by the worst of flood and wind damage so far.'],
  ['power', '⚡', 'Power', 'Grid supply, backup generators and blackout.'],
]

const pct = (x) => `${Math.round(x * 100)}%`

function Vital({ value, label, tone = 'text-slate-100' }) {
  return (
    <div className="rounded-md bg-slate-800/60 px-2 py-1.5">
      <div className={`font-mono text-base font-bold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[10px] leading-tight text-slate-400">{label}</div>
    </div>
  )
}

function Row({ k, v, accent }) {
  return (
    <div className="flex justify-between gap-3 text-[12px]">
      <span className="text-slate-400">{k}</span>
      <span className={`font-mono ${accent ?? 'text-slate-100'}`}>{v}</span>
    </div>
  )
}

/** The ground under the cursor: what is there, its height, the water on it, power. */
function Ground({ c }) {
  if (!c) return <div className="text-[11px] text-slate-500">Point at the map to read the ground there.</div>
  return (
    <div className="rounded-md bg-slate-800/60 p-2">
      <div className="text-[10px] tracking-wider text-slate-500 uppercase">Ground</div>
      <div className="mb-1 font-semibold text-white">
        {c.kind} at {c.i}, {c.j}
      </div>
      <Row k="Ground vs riverbank" v={`${c.ground >= 0 ? '+' : ''}${c.ground.toFixed(1)} m`} />
      <Row k="Water" v={`${c.depth.toFixed(2)} m`} accent={c.depth > 0.6 ? 'text-red-400' : c.depth > 0.3 ? 'text-orange-300' : c.depth > 0.1 ? 'text-amber-200' : undefined} />
      {c.depth > 0.05 && <Row k="Current" v={`${c.speed.toFixed(1)} m/s`} accent={c.speed > 1.5 ? 'text-red-400' : undefined} />}
      {c.inside != null && <Row k="Water inside" v={`${c.inside.toFixed(2)} m`} accent={c.inside > 0.05 ? 'text-orange-300' : undefined} />}
      <Row k="Power" v={c.powered} accent={c.powered === 'Off' ? 'text-amber-300' : 'text-emerald-300'} />
    </div>
  )
}

/** Lenses over the city during a typhoon: pick one, read its legend and the numbers that go with it. */
export default function LensPanel({ s, game, onClose }) {
  const sim = s.sim
  const lens = sim.lens ?? 'city'
  const L = sim.lensStats
  const T = sim.totals
  return (
    <div className="panel p-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] tracking-wider text-slate-400 uppercase">Lenses</div>
          <div className="text-[11px] text-slate-500">Grey out the city and paint one measure over it.</div>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-slate-500 hover:text-white" aria-label="Close lenses">
            ✕
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {LENSES.map(([k, icon, name, desc]) => (
          <button key={k} onClick={() => game.setLens(k)} className={`rounded-lg border px-2.5 py-1.5 text-left ${lens === k ? 'border-sky-400 bg-sky-500/10' : 'border-transparent hover:bg-slate-700/40'}`}>
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <span>{icon}</span>
              {name}
            </div>
            <div className="text-[11px] leading-snug text-slate-400">{desc}</div>
            {k === 'flood' && lens === 'flood' && (
              <div className="mt-1.5">
                <div className="flex h-2 overflow-hidden rounded">
                  {DEPTH_BANDS.map((b) => (
                    <div key={b.label} className="flex-1" style={{ background: `rgb(${b.color.join(',')})` }} />
                  ))}
                </div>
                <div className="mt-0.5 flex text-[10px] text-slate-400">
                  {DEPTH_BANDS.map((b) => (
                    <span key={b.label} className="flex-1" title={b.note}>
                      {b.min} m{b.max === Infinity ? '+' : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {k === 'power' && lens === 'power' && (
              <div className="mt-1 flex gap-3 text-[10px] text-slate-400">
                <span>
                  <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-yellow-400" />
                  powered
                </span>
                <span>
                  <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-400" />
                  generator
                </span>
                <span>
                  <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-600" />
                  blackout
                </span>
              </div>
            )}
          </button>
        ))}
      </div>
      {L && lens !== 'city' && (
        <div className="mt-2 grid grid-cols-3 gap-1">
          <Vital value={pct(L.flooded)} label="of the city flooded" tone={L.flooded > 0.2 ? 'text-red-400' : L.flooded > 0.05 ? 'text-amber-300' : 'text-slate-100'} />
          <Vital value={pct(L.roadsCut)} label="of streets impassable" tone={L.roadsCut > 0.2 ? 'text-orange-300' : 'text-slate-100'} />
          <Vital value={pct(L.noPower)} label="without power" tone={L.noPower > 0.5 ? 'text-amber-300' : 'text-slate-100'} />
          <Vital value={fmtInt(L.cutOff)} label="cut off by water" tone={L.cutOff >= 1 ? 'text-orange-300' : 'text-slate-100'} />
          <Vital value={fmtInt(T.atRisk)} label="in water indoors" tone={T.atRisk >= 1 ? 'text-red-400' : 'text-slate-100'} />
          <Vital value={fmtInt(T.evacuated)} label="evacuated" tone="text-sky-300" />
        </div>
      )}
      {lens !== 'city' && (
        <div className="mt-2">
          <Ground c={sim.lensCell} />
        </div>
      )}
    </div>
  )
}
