import { useState } from 'react'
import { CITY_TYPES, QUAKE_LEVELS, FLOOD_LEVELS } from '../engine/config.js'
import { START_TIMES } from '../engine/game.js'
import { QuakePicker } from './QuakeScenario.jsx'
import { GitHubMark } from './RepoCredit.jsx'
import { REPO_URL } from './links.js'

const CITY_META = {
  rural: { icon: '🏡', pop: '~1–2 thousand', density: 'Low' },
  metropolis: { icon: '🏙️', pop: '~15–20 thousand', density: 'High' },
  megacity: { icon: '🌆', pop: '70–160 thousand', density: 'Extreme' },
}

function Step({ n, title, children }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wider text-slate-400 uppercase">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-sky-500/20 text-[11px] text-sky-300">{n}</span>
        {title}
      </h3>
      {children}
    </section>
  )
}

export default function Menu({ onStart }) {
  const [cityType, setCityType] = useState('metropolis')
  const [disaster, setDisaster] = useState('flood')
  const [level, setLevel] = useState(3)
  const [startHour, setStartHour] = useState(8)
  const [quake, setQuake] = useState({ mode: 'tier', aftershocks: true, variability: true })
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 999999))

  const levels = disaster === 'quake' ? QUAKE_LEVELS : FLOOD_LEVELS
  const lvl = levels[Math.min(level, levels.length - 1)]

  const pickDisaster = (d) => {
    setDisaster(d)
    setLevel(d === 'quake' ? 3 : 3)
  }

  return (
    <div className="pointer-events-none absolute inset-0 flex">
      <div className="panel scroll-thin pointer-events-auto m-4 flex w-[440px] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto p-6">
        <div className="mb-6">
          <div className="flex items-center gap-3">
            <img src="./favicon.svg" alt="" className="h-10 w-10" />
            <div>
              <h1 className="text-3xl font-black tracking-tight text-white">
                Metro<span className="text-sky-400">Risk</span>
              </h1>
              <p className="text-sm text-slate-400">3D city disaster management simulator</p>
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-slate-300">
            Generate a city, choose a natural disaster, then strengthen, rebuild and protect the city before it strikes. Every life counts.
          </p>
        </div>

        <Step n="1" title="City">
          <div className="grid grid-cols-3 gap-2">
            {Object.values(CITY_TYPES).map((c) => (
              <button
                key={c.key}
                onClick={() => setCityType(c.key)}
                className={`rounded-lg border p-2.5 text-left transition ${cityType === c.key ? 'border-sky-400 bg-sky-500/15' : 'border-slate-700 bg-slate-800/40 hover:border-slate-500'}`}
              >
                <div className="text-2xl">{CITY_META[c.key].icon}</div>
                <div className="mt-1 text-sm font-semibold text-white">{c.name}</div>
                <div className="text-[11px] text-slate-400">Density: {CITY_META[c.key].density}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            {CITY_TYPES[cityType].blurb} Population {CITY_META[cityType].pop}. Budget ${CITY_TYPES[cityType].budget}M.
          </p>
        </Step>

        <Step n="2" title="Disaster">
          <div className="grid grid-cols-2 gap-2">
            {[
              ['flood', '🌧️', 'Heavy rain & flooding', 'River floods, flash floods, drainage failure'],
              ['quake', '🌋', 'Earthquake', 'Ground shaking, collapses, fires, aftershocks'],
            ].map(([k, icon, name, sub]) => (
              <button
                key={k}
                onClick={() => pickDisaster(k)}
                className={`rounded-lg border p-3 text-left transition ${disaster === k ? 'border-amber-400 bg-amber-500/15' : 'border-slate-700 bg-slate-800/40 hover:border-slate-500'}`}
              >
                <div className="text-2xl">{icon}</div>
                <div className="mt-1 text-sm font-semibold text-white">{name}</div>
                <div className="text-[11px] leading-tight text-slate-400">{sub}</div>
              </button>
            ))}
          </div>
        </Step>

        <Step n="3" title={disaster === 'quake' ? 'Earthquake' : 'Intensity'}>
          {disaster === 'quake' ? (
            <QuakePicker quake={quake} setQuake={setQuake} level={level} setLevel={setLevel} />
          ) : (
            <>
              <input type="range" min={0} max={levels.length - 1} value={level} onChange={(e) => setLevel(+e.target.value)} className="w-full accent-amber-400" />
              <div className="mt-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-bold text-white">{lvl.name}</span>
                  <span className="font-mono text-amber-300">{lvl.peak} mm/h peak</span>
                </div>
                <p className="mt-1 text-sm text-slate-300">{lvl.desc}</p>
                <p className="mt-1 text-xs text-slate-400 italic">e.g. {lvl.example}</p>
              </div>
            </>
          )}
        </Step>

        <Step n="4" title="Time of day">
          <div className="grid grid-cols-4 gap-1.5">
            {START_TIMES.map((t) => (
              <button
                key={t.hour}
                onClick={() => setStartHour(t.hour)}
                title={t.sub}
                className={`rounded-md border px-2 py-1.5 text-xs transition ${startHour === t.hour ? 'border-sky-400 bg-sky-500/15 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-400">{START_TIMES.find((t) => t.hour === startHour)?.sub}</p>
        </Step>

        <Step n="5" title="Map seed">
          <div className="flex gap-2">
            <input
              value={seed}
              onChange={(e) => setSeed(Math.abs(parseInt(e.target.value.replace(/\D/g, '') || '0', 10)))}
              className="w-full rounded-md border border-slate-700 bg-slate-900/60 px-3 py-1.5 font-mono text-sm text-white outline-none focus:border-sky-400"
            />
            <button onClick={() => setSeed(Math.floor(Math.random() * 999999))} className="rounded-md border border-slate-700 px-3 hover:border-slate-500" title="Random seed">
              🎲
            </button>
          </div>
        </Step>

        <button
          onClick={() => onStart({ cityType, disaster, level, startHour, seed, quake })}
          className="mt-auto rounded-lg bg-sky-500 py-3 text-base font-bold text-white shadow-lg shadow-sky-900/40 transition hover:bg-sky-400"
        >
          Generate city →
        </button>
        <p className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-100/80">
          <span className="font-semibold text-amber-200">This is a simulation.</span> It uses simplified models from published engineering and earthquake research, but real
          disasters depend on many things it can't capture. Results are illustrations, not predictions. It has not yet been validated for engineering design or official safety and
          planning decisions — use it to learn and to explore scenarios.
        </p>
        <p className="mt-3 text-center text-[11px] text-slate-500">
          Made by{' '}
          <a href="https://github.com/FrancisCodex" target="_blank" rel="noopener noreferrer" className="font-semibold text-sky-300 hover:text-sky-200">
            FrancisCodex
          </a>{' '}
          ·{' '}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-sky-300 hover:text-sky-200">
            <GitHubMark className="h-3 w-3" />
            Source on GitHub
          </a>{' '}
          · runs entirely in your browser
        </p>
      </div>
    </div>
  )
}
