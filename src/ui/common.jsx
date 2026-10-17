import { fmtInt, fmtMoney } from '../engine/math.js'

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
      {q && !s && (
        <div className="mt-2 rounded-md bg-slate-800/60 p-2">
          <div className="mb-1 text-[11px] text-slate-400 uppercase">Scenario risk estimate</div>
          <Row k="Expected shaking" v={`${q.pga.toFixed(2)} g`} />
          <Row
            k="Shape"
            v={`${q.slender < 1 ? 'Squat' : q.slender < 2.5 ? 'Compact' : q.slender < 4 ? 'Slender' : 'Very slender'} (H/B ${q.slender.toFixed(1)})`}
            accent={q.shapeCap < 0.95 ? 'text-orange-300' : q.shapeCap > 1.05 ? 'text-emerald-300' : undefined}
          />
          <Row k="Heavy damage" v={pct(q.pExtensive)} accent={q.pExtensive > 0.3 ? 'text-orange-300' : undefined} />
          <Row k="Destroyed" v={pct(q.pComplete)} accent={q.pComplete > 0.2 ? 'text-red-400' : undefined} />
          <Row k="Collapse" v={pct(q.pCollapse)} accent={q.pCollapse > 0.05 ? 'text-red-400' : undefined} />
        </div>
      )}
      {s && (
        <div className="mt-2 rounded-md bg-slate-800/60 p-2">
          <div className="mb-1 text-[11px] text-slate-400 uppercase">Current state</div>
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
    <div key={notice.t} className={`panel fadein pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2 border px-4 py-2 text-sm ${tone}`}>
      {notice.text}
    </div>
  )
}

/** Vehicles & people: detailed Quaternius models or the built-in procedural ones. */
export function ModelToggle({ s, game }) {
  return (
    <button
      onClick={() => game.setModelStyle(!s.detailedModels)}
      disabled={!s.modelsReady}
      title="Switch vehicles and people between the detailed (Quaternius) models and the simpler built-in ones"
      className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700/60 disabled:opacity-40"
    >
      Models: {s.detailedModels ? 'Detailed' : 'Built-in'}
    </button>
  )
}
