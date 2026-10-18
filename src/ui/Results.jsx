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
    <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-2 sm:p-4">
      <div className="panel fadein scroll-thin max-h-full w-full max-w-[680px] min-w-0 overflow-y-auto p-4 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs tracking-wider text-slate-400 uppercase">Disaster report — {s.city.name}</div>
            <h2 className="text-xl font-bold text-white sm:text-2xl">{d === 'quake' ? `M${s.level.M.toFixed(1)} earthquake${s.level.title ? ` · ${s.level.title}` : ''}` : s.level.name}</h2>
            <div className="text-sm text-slate-400">
              {s.city.typeName} · {r.hours.toFixed(1)} hours simulated · {fmtInt(r.pop)} people in the district
            </div>
          </div>
          <div className="text-center">
            <div className={`text-5xl leading-none font-black sm:text-6xl ${GRADE_TONE[r.grade]}`}>{r.grade}</div>
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

        {r.prep && <PrepComparison r={r} p={r.prep} />}

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
        <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
          Simulated outcome from simplified models — real events can turn out very differently. Not yet validated for real-world safety or planning decisions. · Made by{' '}
          <a href="https://github.com/FrancisCodex" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:text-sky-300">
            FrancisCodex
          </a>
        </p>
      </div>
    </div>
  )
}

const approx = (n) => (n < 0.5 ? '<1' : `~${fmtInt(Math.round(n))}`)

/** Without vs with: one bar for the estimate without preparations, one for what happened. */
function Versus({ label, without, actual, fmt }) {
  const max = Math.max(without, actual, 1e-9)
  return (
    <div className="rounded-lg bg-slate-800/60 p-3">
      <div className="text-[11px] tracking-wide text-slate-400 uppercase">{label}</div>
      <div className="mt-1.5 space-y-1 text-[12px]">
        <div>
          <div className="flex justify-between">
            <span className="text-slate-400">Unprepared</span>
            <span className="font-mono text-red-300">{fmt(without, true)}</span>
          </div>
          <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-slate-900">
            <div className="h-full bg-red-500/80" style={{ width: `${(without / max) * 100}%` }} />
          </div>
        </div>
        <div>
          <div className="flex justify-between">
            <span className="text-slate-400">Prepared (this run)</span>
            <span className="font-mono text-emerald-300">{fmt(actual, false)}</span>
          </div>
          <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-slate-900">
            <div className="h-full bg-emerald-500/80" style={{ width: `${(actual / max) * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** What the preparations bought, against the same city left as it was generated. */
function PrepComparison({ r, p }) {
  if (!p.rows.length)
    return (
      <div className="mt-5 rounded-lg border border-slate-700 p-3 text-[13px] text-slate-400">
        No earthquake preparations were made. Try the city-wide programs or the Quake tools, then use <span className="text-slate-200">Retry with my preparations</span> to compare.
      </div>
    )
  const count = (n, est) => (est ? approx(n) : fmtInt(n))
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase">What your preparations did</h3>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {p.saved.lives >= 0.5 ? (
          <span className="text-lg font-bold text-emerald-300">{approx(p.saved.lives)} lives saved</span>
        ) : (
          <span className="text-[13px] text-slate-300">This time the unprepared city came off no worse: chance plays a part in any single quake.</span>
        )}
        {p.spent > 0 && p.saved.loss > 0 && (
          <span className="text-[13px] text-slate-300">
            Every $1 spent avoided <span className="font-semibold text-white">${p.bcr.toFixed(1)}</span> of damage{' '}
            <span className="text-slate-500">(real-world average for seismic retrofit: $13, NIBS 2019)</span>
          </span>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Versus label="Deaths" without={p.without.dead} actual={r.dead} fmt={count} />
        <Versus label="Buildings destroyed" without={p.without.destroyed} actual={r.destroyed} fmt={count} />
        <Versus label="Economic loss" without={p.without.loss} actual={r.loss} fmt={(v) => fmtMoney(v)} />
      </div>
      <table className="mt-3 w-full text-[12px]">
        <thead>
          <tr className="text-left text-[11px] text-slate-500 uppercase">
            <th className="py-1 font-medium">Measure</th>
            <th className="hidden py-1 text-right font-medium sm:table-cell">Buildings</th>
            <th className="hidden py-1 text-right font-medium sm:table-cell">Spent</th>
            <th className="py-1 text-right font-medium">Lives saved</th>
            <th className="py-1 text-right font-medium">Damage avoided</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((m) => (
            <tr key={m.key} className="border-t border-slate-800 text-slate-300">
              <td className="py-1">{m.label}</td>
              <td className="hidden py-1 text-right font-mono sm:table-cell">{m.key === 'warning' || m.key === 'gas' ? 'city-wide' : fmtInt(m.count)}</td>
              <td className="hidden py-1 text-right font-mono sm:table-cell">{m.spent > 0 ? fmtMoney(m.spent) : '—'}</td>
              <td className="py-1 text-right font-mono text-emerald-300">{approx(Math.max(0, m.lives))}</td>
              <td className="py-1 text-right font-mono">{m.loss > 0.005 ? fmtMoney(m.loss) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
        "Unprepared" is the same earthquake run on the city as it was generated, alongside this one. That run has no people in the street, so it reuses this run's outdoor deaths. The split between measures is an estimate: building measures are taken away again in the damage model, facades are judged from the street deaths that unanchored facades caused, and early warning and gas valves by their effect in the simulation.
      </p>
    </div>
  )
}

function Big({ label, value, tone = 'text-white', sub }) {
  return (
    <div className="rounded-lg bg-slate-800/60 p-3">
      <div className="text-[11px] tracking-wide text-slate-400 uppercase">{label}</div>
      <div className={`text-xl font-bold tabular-nums sm:text-2xl ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}
