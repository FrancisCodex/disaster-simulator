import { useState } from 'react'
import { QUAKE_LEVELS, HISTORICAL_QUAKES } from '../engine/config.js'
import { MECHANISMS, RUPTURE_DIRS, describeEvent, mmiLabel } from '../engine/quakePhysics.js'
import { quakeEventFrom, CUSTOM_QUAKE } from '../engine/game.js'
import { groundPeriod } from '../engine/quakeSim.js'

const GROUNDS = [
  ['map', 'As generated', 'Each part of the district keeps its own ground: rock on the hills, soft sand by the river.'],
  ['rock', 'Hard rock', 'Rock carries the quake straight up into the frames as fast, jerky shaking: hardest on short, stiff buildings. Nothing liquefies.'],
  ['stiff', 'Stiff soil', 'Dense gravel and clay: moderate amplification, no liquefaction.'],
  ['sand', 'Wet sand', 'Loose, saturated sand everywhere: it slows the shaking into a long roll (hard on tall buildings) and liquefies, so buildings sink and tilt, often intact.'],
]
// ASCE 7 approximate period of a concrete frame, T = 0.0466·h^0.9, solved for the number of storeys
const storeysFor = (T) => Math.max(1, Math.round((T / 0.0466) ** (1 / 0.9) / 3.2))
const hz = (f) => (f < 1 ? f.toFixed(2) : f.toFixed(1))

/** Ground type for the whole district, and the shaking's frequency (what resonates with what). */
function GroundAndFrequency({ quake, set, ev, rjb }) {
  const soil = quake.soil ?? 'map'
  const auto = quake.freq == null
  const soilIdx = { rock: 0, stiff: 1, sand: 2 }[soil] ?? 1
  const Tauto = groundPeriod(ev.M, rjb, soilIdx)
  const T = auto ? Tauto : 1 / quake.freq
  // log-scale slider: 0.2–10 Hz
  const toS = (f) => Math.round(Math.log(f / 0.2) / Math.log(50) * 100)
  const fromS = (s) => +(0.2 * 50 ** (s / 100)).toFixed(2)
  return (
    <div className="mt-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-xs">
      <div className="text-slate-400">Ground under the city</div>
      <div className="mt-1 grid grid-cols-2 gap-1">
        {GROUNDS.map(([k, l, d]) => (
          <button key={k} onClick={() => set({ soil: k })} title={d} className={`rounded-md border px-2 py-1 text-left text-[11px] ${soil === k ? 'border-amber-400 bg-amber-500/15 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
            {l}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">{GROUNDS.find((g) => g[0] === soil)[2]}</p>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-slate-400">Shaking frequency</span>
        <Toggle label="Auto" on={auto} onChange={(v) => set({ freq: v ? null : +(1 / Tauto).toFixed(2) })} hint="Auto: set by the earthquake's size and distance and by the ground (Rathje et al. 1998)" />
      </div>
      <input type="range" min={0} max={100} value={toS(1 / T)} disabled={auto} onChange={(e) => set({ freq: fromS(+e.target.value) })} className={`w-full accent-amber-400 ${auto ? 'opacity-40' : ''}`} />
      <div className="flex justify-between text-[11px]">
        <span className="text-slate-500">slow, rolling</span>
        <span className="font-mono text-amber-300">
          {hz(1 / T)} Hz · {T.toFixed(2)} s
        </span>
        <span className="text-slate-500">fast, jerky</span>
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        Resonates with buildings of about <span className="text-slate-100">{storeysFor(T)}</span> storeys{' '}
        {T < 0.25 ? '— short, stiff houses and low blocks snap; towers barely notice.' : T > 1.2 ? '— towers swing hard; low buildings ride it out.' : '— mid-rise blocks take the worst of it.'}
      </p>
    </div>
  )
}

const BEARINGS = [
  [null, 'Random'],
  [0, 'N'],
  [45, 'NE'],
  [90, 'E'],
  [135, 'SE'],
  [180, 'S'],
  [225, 'SW'],
  [270, 'W'],
  [315, 'NW'],
]



const sci = (x) => {
  const e = Math.floor(Math.log10(x))
  return `${(x / 10 ** e).toFixed(2)}×10^${e}`
}
const g2 = (x) => (x < 0.01 ? x.toFixed(3) : x.toFixed(2))

function Slider({ label, value, min, max, step = 1, unit, onChange, fmt = (v) => v }) {
  return (
    <label className="block py-1">
      <div className="flex justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-amber-300">
          {fmt(value)}
          {unit}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} className="w-full accent-amber-400" />
    </label>
  )
}

function Toggle({ label, on, onChange, hint }) {
  return (
    <button onClick={() => onChange(!on)} title={hint} className={`rounded-md border px-2 py-1 text-[11px] ${on ? 'border-sky-400 bg-sky-500/15 text-sky-100' : 'border-slate-700 text-slate-400'}`}>
      {on ? '✓ ' : ''}
      {label}
    </button>
  )
}

/** Earthquake scenario chooser for the menu: intensity tiers, historical reenactments, or a custom event. */
export function QuakePicker({ quake, setQuake, level, setLevel }) {
  const mode = quake.mode ?? 'tier'
  const set = (patch) => setQuake({ ...quake, ...patch })
  const params = { ...CUSTOM_QUAKE, ...quake.params }
  const setP = (patch) => set({ params: { ...params, ...patch } })
  const ev = quakeEventFrom({ quake, level })
  const hist = mode === 'historical' ? HISTORICAL_QUAKES.find((h) => h.id === quake.id) ?? HISTORICAL_QUAKES[0] : null
  const customise = () => set({ mode: 'custom', params: { M: ev.M, depth: ev.depth, dist: ev.dist, mech: ev.mech, strike: ev.strike, rupture: ev.rupture, ...(ev.dip ? { dip: ev.dip } : {}) } })
  return (
    <div>
      <div className="mb-2 grid grid-cols-3 gap-1 rounded-lg bg-slate-900/50 p-1 text-xs">
        {[
          ['tier', 'Intensity'],
          ['historical', 'Historical'],
          ['custom', 'Custom'],
        ].map(([k, l]) => (
          <button key={k} onClick={() => set({ mode: k, ...(k === 'historical' && !quake.id ? { id: 'kobe1995' } : {}) })} className={`rounded-md py-1.5 ${mode === k ? 'bg-amber-500/25 font-semibold text-amber-100' : 'text-slate-400 hover:text-white'}`}>
            {l}
          </button>
        ))}
      </div>

      {mode === 'tier' && (
        <>
          <input type="range" min={0} max={QUAKE_LEVELS.length - 1} value={level} onChange={(e) => setLevel(+e.target.value)} className="w-full accent-amber-400" />
          <div className="mt-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-lg font-bold text-white">{ev.name}</span>
              <span className="font-mono text-amber-300">M {ev.M.toFixed(1)}</span>
            </div>
            <p className="mt-1 text-sm text-slate-300">{ev.desc}</p>
            <p className="mt-1 text-xs text-slate-400 italic">e.g. {ev.example}</p>
          </div>
        </>
      )}

      {mode === 'historical' && (
        <>
          <select value={hist.id} onChange={(e) => set({ id: e.target.value })} className="w-full rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1.5 text-sm text-white outline-none focus:border-amber-400">
            {HISTORICAL_QUAKES.map((h) => (
              <option key={h.id} value={h.id}>
                {h.year} · {h.name}, {h.place} — M{h.M.toFixed(1)}
              </option>
            ))}
          </select>
          <div className="mt-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-lg font-bold text-white">
                {hist.year} {hist.name}
              </span>
              <span className="font-mono text-amber-300">Mw {hist.M.toFixed(1)}</span>
            </div>
            <p className="mt-1 text-sm text-slate-300">{hist.desc}</p>
            <p className="mt-1 text-xs text-slate-400">
              Reenacted at <span className="text-slate-200">{hist.city}</span> · {hist.dist} km from the epicentre · {hist.depth} km deep · {MECHANISMS[hist.mech].name.toLowerCase()} · deaths {hist.deaths}
            </p>
            <button onClick={customise} className="mt-2 text-xs text-sky-300 hover:text-sky-200">
              Customise this event →
            </button>
          </div>
        </>
      )}

      {mode === 'custom' && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
          <Slider label="Magnitude (Mw)" value={params.M} min={3} max={10} step={0.1} onChange={(M) => setP({ M })} fmt={(v) => v.toFixed(1)} />
          <Slider label="Focal depth" value={params.depth} min={1} max={300} onChange={(depth) => setP({ depth })} unit=" km" />
          <Slider label="Epicentre distance from the city" value={params.dist} min={0} max={500} onChange={(dist) => setP({ dist })} unit=" km" />
          <div className="mt-1 text-xs text-slate-400">Fault type</div>
          <div className="mt-1 grid grid-cols-2 gap-1">
            {Object.values(MECHANISMS).map((m) => (
              <button
                key={m.key}
                onClick={() => setP({ mech: m.key, dip: undefined })}
                title={m.desc}
                className={`rounded-md border px-2 py-1 text-left text-[11px] ${params.mech === m.key ? 'border-amber-400 bg-amber-500/15 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
              >
                {m.name}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">{MECHANISMS[params.mech].desc}</p>
          <Slider label="Fault dip" value={params.dip ?? MECHANISMS[params.mech].dip} min={5} max={90} onChange={(dip) => setP({ dip })} unit="°" />
          <Slider
            label="Fault direction"
            value={params.strike}
            min={0}
            max={90}
            onChange={(strike) => setP({ strike })}
            fmt={(v) => (v < 15 ? 'points at city' : v > 75 ? 'runs alongside' : `${v}°`)}
          />
          <div className="mt-1 flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-400">Rupture spreads</span>
            <select value={params.rupture} onChange={(e) => setP({ rupture: e.target.value })} className="rounded border border-slate-700 bg-slate-900/80 px-1.5 py-1 text-white">
              {Object.entries(RUPTURE_DIRS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-slate-500">Epicentre to the</span>
        <select value={quake.bearing ?? ''} onChange={(e) => set({ bearing: e.target.value === '' ? null : +e.target.value })} className="rounded border border-slate-700 bg-slate-900/80 px-1.5 py-0.5 text-[11px] text-white">
          {BEARINGS.map(([v, l]) => (
            <option key={l} value={v ?? ''}>
              {l}
            </option>
          ))}
        </select>
        <Toggle label="Aftershocks" on={quake.aftershocks !== false} onChange={(v) => set({ aftershocks: v })} hint="Simulate the aftershock sequence (Reasenberg & Jones statistics)" />
        <Toggle label="Natural scatter" on={quake.variability !== false} onChange={(v) => set({ variability: v })} hint="Off: every shock produces exactly the median ground motion — useful for checking the maths" />
      </div>

      <GroundAndFrequency quake={quake} set={set} ev={ev} rjb={describeEvent(ev).rjb} />
      <QuakePhysics ev={ev} observed={hist?.observed} />
    </div>
  )
}

/** The numbers behind a scenario: source size, distances, predicted shaking and the equations used. */
export function QuakePhysics({ ev, observed, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const [eq, setEq] = useState(false)
  const d = describeEvent(ev)
  const lo = (x) => g2(x / d.sigmaFactor)
  const hi = (x) => g2(x * d.sigmaFactor)
  return (
    <div className="mt-2 rounded-lg border border-slate-700/70 bg-slate-900/40 text-xs">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-2 text-left">
        <span className="font-semibold text-slate-200">Scenario physics</span>
        <span className="text-slate-400">
          {g2(d.sites[1])} g · MMI {mmiLabel(d.mmi)} {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          <Section title="Source">
            <R k="Seismic moment M₀" v={`${sci(d.src.M0)} N·m`} />
            <R k="Energy radiated" v={`${sci(d.src.energy)} J ≈ ${d.src.tnt >= 1000 ? `${(d.src.tnt / 1000).toFixed(d.src.tnt > 1e5 ? 0 : 1)} Mt` : `${d.src.tnt.toFixed(d.src.tnt < 1 ? 3 : 1)} kt`} TNT`} />
            <R k="Rupture" v={`${d.src.L.toFixed(0)} × ${d.src.W.toFixed(0)} km (${Math.round(d.src.area).toLocaleString()} km²)`} />
            <R k="Average slip" v={`${d.src.slip.toFixed(2)} m`} />
            <R k="Fault plane depth" v={`${d.src.ztor.toFixed(1)}–${d.src.zbot.toFixed(1)} km, dip ${d.src.dip}°`} />
          </Section>
          <Section title="Distance to the city centre">
            <R k="Epicentral / hypocentral" v={`${ev.dist.toFixed(0)} / ${Math.hypot(ev.dist, ev.depth).toFixed(0)} km`} />
            <R k="To the rupture surface (Rjb)" v={`${d.rjb.toFixed(1)} km`} />
            <R k="To the rupture plane (Rrup)" v={`${d.rrup.toFixed(1)} km`} />
          </Section>
          <Section title={`Peak ground acceleration — ${d.gmpe.name}`}>
            <R k="Rock (Vs30 760 m/s)" v={`${g2(d.rock)} g  (${lo(d.rock)}–${hi(d.rock)})`} />
            <R k="Stiff soil (400 m/s)" v={`${g2(d.sites[1])} g  (${lo(d.sites[1])}–${hi(d.sites[1])})`} />
            <R k="Soft alluvium (200 m/s)" v={`${g2(d.sites[2])} g  (${lo(d.sites[2])}–${hi(d.sites[2])})`} />
            <R k="Intensity (Wald et al. 1999)" v={`MMI ${mmiLabel(d.mmi)}`} />
            <R k="Strong shaking lasts" v={`~${Math.round(d.duration)} s`} />
            <p className="text-[10px] text-slate-500">Median, with the ±1σ range in brackets (×{d.sigmaFactor.toFixed(2)}). Soft soil damps peak acceleration in strong shaking but amplifies the slower sway that damages buildings.</p>
          </Section>
          {observed && (
            <Section title="Compared with what was recorded">
              <R k={`Recorded (${observed.where})`} v={`${observed.pga[0] === observed.pga[1] ? observed.pga[0] : `${observed.pga[0]}–${observed.pga[1]}`} g`} accent="text-sky-300" />
              <R k="Model, rock → soft soil" v={`${g2(Math.min(...d.sites))}–${g2(Math.max(...d.sites))} g`} />
            </Section>
          )}
          <Section title="Aftershocks (first 3 days)">
            <R k={`Expected ≥ M${d.after.Mmin.toFixed(1)}`} v={`~${Math.round(d.after.n)}`} />
            <R k="Largest typically (Båth's law)" v={`M${d.after.bath.toFixed(1)}`} />
          </Section>
          {d.warnings.map((w) => (
            <p key={w} className="rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
              ⚠ {w}
            </p>
          ))}
          <button onClick={() => setEq(!eq)} className="text-sky-300 hover:text-sky-200">
            {eq ? 'Hide' : 'Show'} equations
          </button>
          {eq && <Equations regime={d.gmpe.regime} />}
        </div>
      )}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] tracking-wider text-slate-500 uppercase">{title}</div>
      {children}
    </div>
  )
}

function R({ k, v, accent }) {
  return (
    <div className="flex justify-between gap-3 py-px">
      <span className="text-slate-400">{k}</span>
      <span className={`text-right font-mono ${accent ?? 'text-slate-100'}`}>{v}</span>
    </div>
  )
}

function Equations({ regime }) {
  const lines = [
    ['Seismic moment', 'M₀ = 10^(1.5·Mw + 9.1) N·m  (Hanks & Kanamori 1979)'],
    ['Energy', 'log₁₀ E = 1.5·Mw + 4.8 J  (Gutenberg & Richter)'],
    regime === 'interface'
      ? ['Rupture size', 'log L = −2.477 + 0.585·Mw,  log W = −0.882 + 0.351·Mw  (Strasser et al. 2010)']
      : ['Rupture size', 'log L = −2.44 + 0.59·Mw,  log W = −1.01 + 0.32·Mw  (Wells & Coppersmith 1994)'],
    ['Average slip', 'D = M₀ / (μ·L·W),  μ = 30–40 GPa'],
    regime === 'crustal'
      ? ['Rock PGA (BA08)', 'ln PGA = F_M + [c₁ + c₂(M − 4.5)]·ln R + c₃(R − 1),  R = √(Rjb² + 1.35²);  F_M = e_type + e₅(M − 6.75) + e₆(M − 6.75)² below M6.75, flat above']
      : ['Rock PGA (Youngs 1997)', `ln PGA = 0.2418 + 1.414·M − 2.552·ln(Rrup + 1.7818·e^(0.554·M)) + 0.00607·H${regime === 'intraslab' ? ' + 0.3846' : ''}`],
    ['Site term (BA08)', 'ln F_S = −0.36·ln(Vs30/760) + b_nl(Vs30)·ln(PGA_rock/0.1)  (nonlinear above 0.09 g)'],
    ['Intensity', 'MMI = 3.66·log₁₀(PGA cm/s²) − 1.66  (Wald et al. 1999; 2.20·log + 1.00 below V)'],
    ['Aftershocks', 'rate = 10^(−1.67 + 0.91(M − Mmin)) · (t + 0.05)^−1.08 per day  (Reasenberg & Jones 1989)'],
    ['Liquefaction', 'CSR = 0.65·a_max·(σv/σv′)·r_d vs CRR·MSF,  MSF = 10^2.24 / M^2.56  (Seed & Idriss; Idriss 1999)'],
    ['Landslides', 'log D_N = −2.71 + log[(1 − a_c/a_max)^2.335 (a_c/a_max)^−1.478] + 0.424·M cm  (Jibson 2007)'],
  ]
  return (
    <div className="space-y-1 rounded bg-slate-950/50 p-2">
      {lines.map(([k, v]) => (
        <div key={k}>
          <div className="text-[10px] text-slate-500">{k}</div>
          <div className="font-mono text-[10.5px] leading-snug text-slate-300">{v}</div>
        </div>
      ))}
    </div>
  )
}
