import { useState } from 'react'
import { fmtInt, fmtMoney } from '../engine/math.js'
import { resonanceAt } from '../engine/quakeSim.js'

function readOpen(id, fallback) {
  try {
    const v = localStorage.getItem(`metrorisk.open.${id}`)
    return v == null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

/** A panel whose body folds away; remembers whether it was open. summary shows while folded. */
export function Section({ id, title, summary, defaultOpen = true, className = '', children }) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen))
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(`metrorisk.open.${id}`, open ? '0' : '1')
    } catch {
      /* storage unavailable: it just won't be remembered */
    }
  }
  return (
    <div className={`panel p-3 ${className}`}>
      <button onClick={toggle} aria-expanded={open} className="flex w-full items-center justify-between gap-2 text-left text-[11px] tracking-wider text-slate-400 uppercase hover:text-slate-200">
        <span>{title}</span>
        <span className="flex items-center gap-2 normal-case">
          {!open && summary && <span className="text-[12px] tracking-normal text-slate-300">{summary}</span>}
          <span className={`text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
        </span>
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  )
}

/** A panel that slides up over the lower part of the map, with its own close button. */
export function Sheet({ title, onClose, children }) {
  return (
    <div className="panel fadein scroll-thin pointer-events-auto max-h-[45vh] overflow-y-auto p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] tracking-wider text-slate-400 uppercase">{title}</span>
        <button onClick={onClose} className="px-1 text-slate-400 hover:text-white" aria-label="Close">
          ✕
        </button>
      </div>
      {children}
    </div>
  )
}

export function Row({ k, v, accent }) {
  return (
    <div className="flex justify-between gap-3 py-0.5 text-[13px]">
      <span className="text-slate-400">{k}</span>
      <span className={`text-right font-medium ${accent ?? 'text-slate-100'}`}>{v}</span>
    </div>
  )
}

export function Stat({ label, value, tone = 'text-white', sub }) {
  return (
    <div className="rounded-lg bg-slate-800/50 px-3 py-2">
      <div className="text-[11px] tracking-wide text-slate-400 uppercase">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}

const pct = (p) => (p < 0.001 ? '<0.1%' : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`)

// period axis of the resonance gauge (s), log scale
const T_MIN = 0.05
const T_MAX = 5
const tPos = (T) => (Math.log(Math.min(T_MAX, Math.max(T_MIN, T)) / T_MIN) / Math.log(T_MAX / T_MIN)) * 100
const resColor = (r) =>
  r >= 1
    ? `hsla(${40 - 40 * Math.min(1, (r - 1) / 0.5)}, 85%, 55%, ${0.15 + 0.75 * Math.min(1, (r - 1) / 0.5)})`
    : `hsla(150, 60%, 45%, ${0.15 + 0.6 * Math.min(1, (1 - r) / 0.5)})`

/**
 * The building's own sway period against the ground's shaking period: the
 * band shows how much harder (red) or easier (green) this shaking is on a
 * building of each period, the dot is this building.
 */
function ResonanceGauge({ T, Tm, res }) {
  const cells = 40
  const band = Array.from({ length: cells }, (_, i) => {
    const t = T_MIN * (T_MAX / T_MIN) ** ((i + 0.5) / cells)
    return resColor(resonanceAt(t, Tm))
  })
  // the multiplier is relative to the ordinary shaking the damage estimates are based on
  const inStep = Math.abs(Math.log(T / Tm)) < 0.35
  const verdict = inStep
    ? res >= 1.05
      ? 'In step with the ground: the shaking builds up in it.'
      : 'In step with the ground, as in most quakes: no worse than usual.'
    : res >= 1.05
      ? 'This shaking is harder on it than usual.'
      : res <= 0.85
        ? 'Well off the ground’s period: it rides the shaking out.'
        : 'Off the ground’s period: about the usual demand.'
  return (
    <div className="mt-1.5 py-0.5" title="Every building sways back and forth at its own period (taller = slower). Shaking near that period builds up in it, as in Mexico City 1985, where the lakebed shook at ~2 s and mid-rise blocks fell.">
      <div className="flex justify-between text-[13px]">
        <span className="text-slate-400">Resonance</span>
        <span className={`font-medium ${res >= 1.2 ? 'text-red-400' : res >= 1.05 ? 'text-amber-300' : res <= 0.85 ? 'text-emerald-300' : 'text-slate-100'}`}>×{res.toFixed(2)} vs a typical quake</span>
      </div>
      <div className="relative mt-1 h-3 rounded bg-slate-700/60">
        <div className="absolute inset-0 flex overflow-hidden rounded">
          {band.map((c, i) => (
            <div key={i} className="h-full flex-1" style={{ background: c }} />
          ))}
        </div>
        <div className="absolute -top-0.5 -bottom-0.5 w-0.5 -translate-x-1/2 bg-amber-300" style={{ left: `${tPos(Tm)}%` }} />
        <div className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-900 bg-white" style={{ left: `${tPos(T)}%` }} />
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-slate-500">
        <span>0.05 s · stiff</span>
        <span>
          <span className="text-white">●</span> building {T.toFixed(2)} s · <span className="text-amber-300">|</span> ground {Tm.toFixed(2)} s
        </span>
        <span>5 s · tall</span>
      </div>
      <div className="text-[11px] text-slate-400">{verdict}</div>
    </div>
  )
}

const OPTION_TONE = { ok: 'text-emerald-300', done: 'text-sky-300', na: 'text-slate-500' }

/** What has been done to this building, and which quake measures it can still take. */
function Preparations({ measures, options }) {
  return (
    <div className="mt-2 rounded-md bg-slate-800/60 p-2">
      <div className="mb-1 text-[11px] text-slate-400 uppercase">Preparations</div>
      {measures.length ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {measures.map((m) => (
            <span key={m} className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-200 ring-1 ring-sky-400/30">
              ✓ {m}
            </span>
          ))}
        </div>
      ) : (
        <div className="mb-1 text-[12px] text-slate-500">None yet.</div>
      )}
      {options?.map((o) => (
        <div key={o.key} className="py-0.5 text-[12px]">
          <div className="flex justify-between gap-3">
            <span className={o.status === 'na' ? 'text-slate-500' : 'text-slate-300'}>
              <span className="mr-1">{o.icon}</span>
              {o.name}
            </span>
            <span className={OPTION_TONE[o.status]}>{o.status === 'ok' ? fmtMoney(o.note) : o.status === 'done' ? '✓ done' : '✕ not applicable'}</span>
          </div>
          {o.status === 'na' && <div className="pl-5 text-[11px] leading-snug text-slate-500">{o.note}</div>}
        </div>
      ))}
    </div>
  )
}

const ROOF_NAME = { light: 'Sheet / tile on timber', metal: 'Metal sheet on steel', slab: 'Concrete slab' }
const kmh = (ms) => (ms ? `${Math.round(ms * 3.6)} km/h` : '—')

/** What the forecast gusts are likely to do to this building. */
function WindRisk({ w }) {
  const m = w.medians
  return (
    <div className="mt-2 rounded-md bg-slate-800/60 p-2">
      <div className="mb-1 text-[11px] text-slate-400 uppercase">Wind risk at the forecast peak</div>
      <Row k="Roof" v={ROOF_NAME[w.kind]} />
      <Row k="Gust at roof height" v={kmh(w.gust)} />
      {m.glass && <Row k="Windows break" v={`${pct(w.pGlass)} · 50% at ${kmh(m.glass)}`} accent={w.pGlass > 0.5 ? 'text-amber-300' : undefined} />}
      {m.cover && <Row k="Roof sheets / tiles lost" v={`${pct(w.pCover)} · 50% at ${kmh(m.cover)}`} accent={w.pCover > 0.5 ? 'text-amber-300' : undefined} />}
      {m.roof && <Row k="Whole roof torn off" v={`${pct(w.pRoof)} · 50% at ${kmh(m.roof)}`} accent={w.pRoof > 0.3 ? 'text-orange-300' : undefined} />}
      <Row k="Flattened" v={`${pct(w.pCollapse)} · 50% at ${kmh(m.collapse)}`} accent={w.pCollapse > 0.1 ? 'text-red-400' : undefined} />
    </div>
  )
}

export function BuildingPanel({ info, title = 'Building', onClose }) {
  if (!info) return null
  const q = info.quake
  const s = info.state
  return (
    <div className="panel fadein p-3">
      <div className="mb-1 flex items-start justify-between">
        <div>
          <div className="text-[11px] tracking-wider text-slate-400 uppercase">{title}</div>
          <div className="font-semibold text-white">{info.type}</div>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-slate-500 hover:text-white" aria-label="Close">
            ✕
          </button>
        )}
      </div>
      <Row k="Floors / height" v={`${info.floors} · ${info.height.toFixed(0)} m`} />
      <Row k="Structure" v={info.construction} />
      <Row k="Built" v={info.era} />
      <Row k="Floor area" v={`${fmtInt(info.area)} m²`} />
      {info.residents > 0 && <Row k="Residents" v={fmtInt(info.residents)} />}
      <Row k="People inside at start" v={fmtInt(info.present)} />
      {info.beds && <Row k="Hospital beds" v={fmtInt(info.beds)} />}
      {info.capacity && <Row k="Shelter capacity" v={fmtInt(info.capacity)} />}
      <Row k="Value" v={fmtMoney(info.value)} />
      <Row k="Ground" v={info.soil} />
      <Row k="Floor above riverbank" v={`${info.aboveBank.toFixed(1)} m${info.elevated ? ' (elevated)' : ''}`} accent={info.aboveBank < 1.5 ? 'text-orange-300' : undefined} />
      {(info.measures?.length > 0 || info.options) && <Preparations measures={info.measures ?? []} options={info.options} />}
      {q && !s && (
        <div className="mt-2 rounded-md bg-slate-800/60 p-2">
          <div className="mb-1 text-[11px] text-slate-400 uppercase">Scenario risk estimate</div>
          <Row k="Expected shaking" v={`${q.pga.toFixed(2)} g`} />
          <Row
            k="Shape"
            v={`${q.slender < 1 ? 'Squat' : q.slender < 2.5 ? 'Compact' : q.slender < 4 ? 'Slender' : 'Very slender'} (H/B ${q.slender.toFixed(1)})`}
            accent={q.shapeCap < 0.95 ? 'text-orange-300' : q.shapeCap > 1.05 ? 'text-emerald-300' : undefined}
          />
          {info.softStorey && <Row k="Ground floor" v="Open shopfront: soft storey" accent="text-orange-300" />}
          {info.softFixed && info.openFront && <Row k="Ground floor" v="Braced" accent="text-emerald-300" />}
          {info.sheds && <Row k="Facade" v={info.facadeAnchored ? 'Anchored' : 'Unanchored: falls on street'} accent={info.facadeAnchored ? 'text-emerald-300' : 'text-amber-300'} />}
          {q.T && <ResonanceGauge T={q.T} Tm={q.Tm} res={q.res} />}
          <Row k="Heavy damage" v={pct(q.pExtensive)} accent={q.pExtensive > 0.3 ? 'text-orange-300' : undefined} />
          <Row k="Destroyed" v={pct(q.pComplete)} accent={q.pComplete > 0.2 ? 'text-red-400' : undefined} />
          <Row k="Collapse" v={pct(q.pCollapse)} accent={q.pCollapse > 0.05 ? 'text-red-400' : undefined} />
        </div>
      )}
      {info.wind && !s && <WindRisk w={info.wind} />}
      {s && (
        <div className="mt-2 rounded-md bg-slate-800/60 p-2">
          <div className="mb-1 text-[11px] text-slate-400 uppercase">Current state</div>
          {s.wind && <Row k="Wind damage" v={s.wind} accent={s.wind === 'Intact' ? undefined : s.wind.startsWith('Flattened') ? 'text-red-400' : 'text-orange-300'} />}
          {s.gust > 15 && <Row k="Gusts at roof height" v={`${Math.round(s.gust * 3.6)} km/h (max ${Math.round(s.maxGust * 3.6)})`} />}
          {s.powered === false && <Row k="Power" v="Cut" accent="text-amber-300" />}
          {'ds' in s && <Row k="Damage" v={s.collapsed ? (s.toppled ? 'Toppled' : 'Collapsed') : s.burnt ? 'Burnt out' : s.ds} accent={s.collapsed || s.burnt ? 'text-red-400' : undefined} />}
          {'integrity' in s && !s.collapsed && (
            <div className="py-0.5">
              <div className="flex justify-between text-[13px]">
                <span className="text-slate-400">Structural integrity</span>
                <span className={`font-medium ${s.integrity < 0.4 ? 'text-red-400' : s.integrity < 0.7 ? 'text-amber-300' : 'text-slate-100'}`}>{Math.round(s.integrity * 100)}%</span>
              </div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-slate-700">
                <div className={`h-full ${s.integrity < 0.4 ? 'bg-red-500' : s.integrity < 0.7 ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${Math.round(s.integrity * 100)}%` }} />
              </div>
            </div>
          )}
          {s.hits > 0 && <Row k="Damaging shocks" v={fmtInt(s.hits)} />}
          {s.groundState && <Row k="Ground" v={s.groundState} accent="text-amber-300" />}
          {s.settle >= 0.01 && <Row k="Settlement" v={`${Math.round(s.settle * 100)} cm`} accent={s.settle > 0.3 ? 'text-orange-300' : undefined} />}
          {s.lean >= 0.002 && <Row k="Tilt" v={`${((s.lean * 180) / Math.PI).toFixed(1)}°`} accent={s.lean > 1 / 60 ? 'text-red-400' : undefined} />}
          {s.burning && <Row k="Fire" v="Burning" accent="text-orange-400" />}
          {'depthIn' in s && <Row k="Water inside" v={`${s.depthIn.toFixed(2)} m (max ${s.maxIn.toFixed(2)})`} accent={s.depthIn > 1 ? 'text-red-400' : undefined} />}
          {'depthOut' in s && <Row k="Street water" v={`${s.depthOut.toFixed(2)} m · ${s.velocity.toFixed(1)} m/s`} />}
          {s.collapsed && 'depthIn' in s && <Row k="Structure" v="Swept away" accent="text-red-400" />}
          <Row k="People inside" v={fmtInt(s.present)} />
          {s.evacuated > 0 && <Row k="Evacuated" v={fmtInt(s.evacuated)} accent="text-sky-300" />}
          {s.trapped > 0.5 && <Row k="Trapped" v={fmtInt(s.trapped)} accent="text-orange-300" />}
          {s.injured > 0.5 && <Row k="Injured" v={fmtInt(s.injured)} accent="text-amber-300" />}
          <Row k="Deaths" v={fmtInt(s.dead)} accent={s.dead >= 1 ? 'text-red-400' : undefined} />
        </div>
      )}
    </div>
  )
}

export function Notice({ notice }) {
  if (!notice) return null
  const tone = notice.kind === 'bad' ? 'border-red-500/50 text-red-200' : notice.kind === 'good' ? 'border-emerald-500/50 text-emerald-200' : 'border-sky-500/40 text-sky-100'
  return (
    <div key={notice.t} className={`panel fadein notice-pos pointer-events-none absolute left-1/2 max-w-[90vw] -translate-x-1/2 border px-4 py-2 text-sm ${tone}`}>
      {notice.text}
    </div>
  )
}
