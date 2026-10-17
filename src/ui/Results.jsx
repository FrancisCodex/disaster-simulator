import { useState } from 'react'
import { fmtInt, fmtMoney } from '../engine/math.js'

const GRADE_TONE = { 'A+': 'text-emerald-300', A: 'text-emerald-300', B: 'text-lime-300', C: 'text-amber-300', D: 'text-orange-400', F: 'text-red-400' }
const GRADE_TEXT = {
  'A+': 'No lives lost.',
  A: 'Outstanding management.',
  B: 'Well prepared.',
  C: 'Significant losses.',
  D: 'Severe losses.',
  F: 'Catastrophe.',
}

export default function Results({ s, game }) {
  const [hidden, setHidden] = useState(false)
  const r = s.results
  if (hidden)
    return (
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
        <button onClick={() => setHidden(false)} className="panel px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
          Show results ({r.grade})
        </button>
      </div>
    )
  const maxCause = Math.max(1, ...r.causes.map((c) => c.value))
  const d = s.settings.disaster
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/40 p-4">
      <div className="panel fadein scroll-thin max-h-full w-[680px] max-w-full overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs tracking-wider text-slate-400 uppercase">Disaster report — {s.city.name}</div>
            <h2 className="text-2xl font-bold text-white">{d === 'quake' ? `M${s.level.M.toFixed(1)} earthquake${s.level.title ? ` · ${s.level.title}` : ''}` : s.level.name}</h2>
            <div className="text-sm text-slate-400">
              {s.city.typeName} · {r.hours.toFixed(1)} hours simulated · {fmtInt(r.pop)} people in the district
            </div>
          </div>
          <div className="text-center">
            <div className={`text-6xl leading-none font-black ${GRADE_TONE[r.grade]}`}>{r.grade}</div>
            <div className="mt-1 text-xs text-slate-400">{GRADE_TEXT[r.grade]}</div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Big label="Deaths" value={fmtInt(r.dead)} tone="text-red-400" sub={`${(r.rate * 100).toFixed(r.rate < 0.001 ? 3 : 2)}% of people`} />
          <Big label="Injured" value={fmtInt(r.injured)} tone="text-amber-300" />
          <Big label="Displaced" value={fmtInt(r.displaced)} tone="text-sky-300" sub="lost their homes" />
          <Big label="Economic loss" value={fmtMoney(r.loss)} tone="text-slate-100" sub={`prep spent ${fmtMoney(r.spent)}`} />
          <Big label={d === 'quake' ? 'Damaged' : 'Flooded'} value={fmtInt(r.damaged)} sub={`of ${fmtInt(r.buildings)} buildings`} />
          <Big label="Destroyed" value={fmtInt(r.destroyed)} />
          {d === 'quake' ? <Big label="Rescued alive" value={fmtInt(r.rescued)} tone="text-emerald-300" /> : <Big label="Evacuated" value={fmtInt(r.evacuated)} tone="text-emerald-300" />}
          {d === 'quake' ? <Big label="Still trapped" value={fmtInt(r.trapped)} tone={r.trapped ? 'text-orange-300' : undefined} /> : <Big label="Boat rescues" value={fmtInt(r.rescued)} />}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase">Causes of death</h3>
            {r.causes.map((c) => (
              <div key={c.label} className="mb-1.5">
                <div className="flex justify-between text-[13px]">
                  <span className="text-slate-300">{c.label}</span>
                  <span className="font-mono text-slate-200">{fmtInt(c.value)}</span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-slate-800">
                  <div className="h-full bg-red-500/80" style={{ width: `${(c.value / maxCause) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase">What we learned</h3>
            <ul className="space-y-1.5">
              {r.lessons.map((l, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-snug text-slate-300">
                  <span className="text-sky-400">›</span>
                  {l}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button onClick={() => setHidden(true)} className="rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-700/60">
            Look around
          </button>
          <button onClick={() => game.backToMenu()} className="rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-700/60">
            Main menu
          </button>
          <button onClick={() => game.retry(false)} className="rounded-md border border-slate-600 px-3 py-2 text-sm text-white hover:bg-slate-700/60">
            Same city, start over
          </button>
          <button onClick={() => game.retry(true)} className="rounded-md bg-sky-500 px-4 py-2 text-sm font-bold text-white hover:bg-sky-400">
            Retry with my preparations
          </button>
        </div>
      </div>
    </div>
  )
}

function Big({ label, value, tone = 'text-white', sub }) {
  return (
    <div className="rounded-lg bg-slate-800/60 p-3">
      <div className="text-[11px] tracking-wide text-slate-400 uppercase">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}
