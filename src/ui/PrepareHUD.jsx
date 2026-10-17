import { TOOLS } from '../engine/game.js'
import { UPGRADES, CONSTRUCTION } from '../engine/config.js'
import { Row, BuildingPanel, ModelToggle } from './common.jsx'
import { fmtInt, fmtMoney } from '../engine/math.js'
import { QuakePhysics } from './QuakeScenario.jsx'

const GROUPS = ['General', 'Build', 'Flood', 'Quake']

export default function PrepareHUD({ s, game }) {
  const remaining = s.budget - s.spent
  const disaster = s.settings.disaster
  const tool = TOOLS.find((t) => t.key === s.tool)
  const p = s.prep
  return (
    <>
      {/* top bar */}
      <div className="pointer-events-none absolute top-3 right-3 left-3 flex items-start justify-between gap-3">
        <div className="panel pointer-events-auto flex items-center gap-4 px-4 py-2">
          <div>
            <div className="text-lg leading-tight font-bold text-white">{s.city.name}</div>
            <div className="text-xs text-slate-400">
              {s.city.typeName} · seed {s.city.seed}
            </div>
          </div>
          <div className="h-8 w-px bg-slate-700" />
          <div className="text-sm">
            <div className="text-slate-400">Incoming</div>
            <div className="font-semibold text-amber-300">
              {disaster === 'quake' ? `M${s.level.M.toFixed(1)} earthquake${s.level.title ? ` · ${s.level.title}` : ''}` : `${s.level.name} (${s.level.peak} mm/h)`}
            </div>
          </div>
          <div className="h-8 w-px bg-slate-700" />
          <div className="w-48">
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Budget</span>
              <span className="font-mono text-emerald-300">
                {fmtMoney(remaining)} / {fmtMoney(s.budget)}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-700">
              <div className="h-full bg-emerald-400" style={{ width: `${(remaining / s.budget) * 100}%` }} />
            </div>
          </div>
        </div>
        <div className="pointer-events-auto flex gap-2">
          <button onClick={() => game.backToMenu()} className="panel px-3 py-2 text-sm text-slate-300 hover:text-white">
            ← Menu
          </button>
        </div>
      </div>

      {/* tools */}
      <div className="panel scroll-thin pointer-events-auto absolute top-24 left-3 max-h-[calc(100vh-8rem)] w-52 overflow-y-auto p-2">
        {GROUPS.map((g) => (
          <div key={g} className="mb-2">
            <div className="px-1 pb-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">
              {g}
              {g === 'Flood' && disaster === 'flood' && <span className="ml-1 text-amber-400">• relevant</span>}
              {g === 'Quake' && disaster === 'quake' && <span className="ml-1 text-amber-400">• relevant</span>}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {TOOLS.filter((t) => t.group === g).map((t) => (
                <button
                  key={t.key}
                  onClick={() => game.setTool(t.key)}
                  title={t.desc}
                  className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition ${s.tool === t.key ? 'bg-sky-500/25 text-white ring-1 ring-sky-400' : 'text-slate-300 hover:bg-slate-700/50'}`}
                >
                  <span>{t.icon}</span>
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* right column */}
      <div className="scroll-thin pointer-events-auto absolute top-24 right-3 flex max-h-[calc(100vh-8rem)] w-80 flex-col gap-2 overflow-y-auto">
        <div className="panel p-3">
          <div className="mb-1 text-[11px] tracking-wider text-slate-400 uppercase">City overview</div>
          <Row k="Residents" v={fmtInt(p.residents)} />
          <Row k="People in district at start" v={fmtInt(p.present)} />
          <Row k="Buildings" v={fmtInt(p.buildings)} />
          {s.relocated > 0 && <Row k="Awaiting new homes" v={fmtInt(s.relocated)} accent="text-orange-300" />}
          {disaster === 'quake' ? (
            <>
              <Row k="Structural demand (avg)" v={`${p.pga.toFixed(2)} g`} accent="text-amber-300" />
              <QuakePhysics ev={s.level} observed={s.level.observed} />
              <Row k="Expected collapses" v={p.expCollapse.toFixed(1)} accent={p.expCollapse >= 1 ? 'text-red-400' : undefined} />
              <Row k="Rough death estimate" v={`~${fmtInt(p.expDeaths)}`} accent={p.expDeaths >= 1 ? 'text-red-400' : undefined} />
              <div className="mt-2 text-[11px] text-slate-500 uppercase">Structures</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {Object.entries(p.byClass)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, n]) => (
                    <span key={k} className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-300">
                      {CONSTRUCTION[k].short}: {n}
                    </span>
                  ))}
              </div>
            </>
          ) : (
            <>
              <Row k="People in low-lying homes" v={fmtInt(p.lowLying)} accent={p.lowLying > 0 ? 'text-orange-300' : undefined} />
              <Row k="Storm drains" v={`${p.drainage} mm/h`} />
              <Row k="Flood walls" v={`${fmtInt(p.leveeM)} m`} />
              <Row k="Pump stations" v={p.pumps} />
              <Row k="Shelter capacity" v={fmtInt(p.shelterCap)} />
            </>
          )}
        </div>

        <div className="panel p-3">
          <div className="mb-2 text-[11px] tracking-wider text-slate-400 uppercase">City-wide upgrades</div>
          {Object.entries(UPGRADES)
            .sort((a, b) => (a[1].disaster === disaster ? -1 : 1) - (b[1].disaster === disaster ? -1 : 1))
            .map(([k, U]) => {
              const { cost, owned, lvl } = game.upgradeCost(k)
              const relevant = U.disaster === disaster
              return (
                <div key={k} className={`mb-2 rounded-md border p-2 ${relevant ? 'border-slate-600' : 'border-slate-800 opacity-60'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-[13px] font-semibold text-white">
                      {U.name}
                      {U.max ? <span className="ml-1 text-xs text-slate-400">({lvl}/{U.max})</span> : null}
                    </div>
                    <button
                      disabled={owned || cost > remaining}
                      onClick={() => game.buyUpgrade(k)}
                      className="shrink-0 rounded bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white enabled:hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400"
                    >
                      {owned ? 'Owned' : fmtMoney(cost)}
                    </button>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{U.desc}</p>
                </div>
              )
            })}
        </div>

        <BuildingPanel info={s.selected} title="Selected" onClose={() => game.select(null)} />
        {!s.selected && s.hoverInfo && <BuildingPanel info={s.hoverInfo} title="Hover" />}
      </div>

      {/* bottom bar */}
      <div className="pointer-events-none absolute right-3 bottom-3 left-3 flex items-end justify-center gap-3">
        <div className="panel pointer-events-auto flex items-center gap-3 px-4 py-2.5">
          <div className="max-w-md text-sm">
            <span className="mr-1">{tool?.icon}</span>
            <span className="font-semibold text-white">{tool?.name}</span>
            <span className="ml-2 text-slate-400">{tool?.desc}</span>
            {s.hover && s.hover.cost > 0 && (
              <span className={`ml-2 font-mono ${s.hover.reason ? 'text-red-400' : 'text-emerald-300'}`}>{s.hover.reason ?? fmtMoney(s.hover.cost)}</span>
            )}
          </div>
          <div className="h-8 w-px bg-slate-700" />
          <button onClick={() => game.toggleOverlay()} className={`rounded-md px-3 py-1.5 text-sm ${s.overlay ? 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-400' : 'text-slate-300 hover:bg-slate-700/60'}`}>
            {disaster === 'quake' ? 'Seismic risk map' : 'Flood risk map'}
          </button>
          <ModelToggle s={s} game={game} />
          <button onClick={() => game.newGame({ ...s.settings, seed: Math.floor(Math.random() * 999999) })} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700/60">
            New map
          </button>
          <button onClick={() => game.startSimulation()} className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-bold text-white shadow-lg shadow-red-900/40 hover:bg-red-500">
            Start disaster ▶
          </button>
        </div>
      </div>
    </>
  )
}
