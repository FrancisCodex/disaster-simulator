import { useState } from 'react'
import { TOOLS, BUILDING_TOOLS } from '../engine/game.js'
import { UPGRADES, CONSTRUCTION } from '../engine/config.js'
import { Row, BuildingPanel, Section, Sheet } from './common.jsx'
import { useIsMobile } from './useIsMobile.js'
import { RepoIcon } from './RepoCredit.jsx'
import { fmtInt, fmtMoney } from '../engine/math.js'
import { QuakePhysics } from './QuakeScenario.jsx'

// tool groups shown for each scenario: the other disaster's tools are hidden
const GROUPS = { flood: ['General', 'Build', 'Flood'], quake: ['General', 'Build', 'Quake'] }

function Swatch({ color, label }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-white/20" style={{ background: color }} />
      {label}
    </span>
  )
}

function Legend() {
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
      <Swatch color="#22c55e" label="can be applied" />
      <Swatch color="#38bdf8" label="already done" />
      <Swatch color="#3b4252" label="not applicable" />
    </div>
  )
}

const incoming = (s) => (s.settings.disaster === 'quake' ? `M${s.level.M.toFixed(1)} earthquake${s.level.title ? ` · ${s.level.title}` : ''}` : `${s.level.name} (${s.level.peak} mm/h)`)

/** Upgrades for this scenario only. */
const upgradesFor = (disaster) => Object.entries(UPGRADES).filter(([, U]) => U.disaster === disaster)

function Overview({ s }) {
  const p = s.prep
  return (
    <>
      <Row k="Residents" v={fmtInt(p.residents)} />
      <Row k="People in district at start" v={fmtInt(p.present)} />
      <Row k="Buildings" v={fmtInt(p.buildings)} />
      {s.relocated > 0 && <Row k="Awaiting new homes" v={fmtInt(s.relocated)} accent="text-orange-300" />}
      {s.settings.disaster === 'quake' ? (
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
    </>
  )
}

/** One line for the folded overview: the number that matters most. */
const overviewSummary = (s) => (s.settings.disaster === 'quake' ? `~${fmtInt(s.prep.expDeaths)} deaths est.` : `${fmtInt(s.prep.lowLying)} in low-lying homes`)

function Upgrades({ s, game }) {
  const remaining = s.budget - s.spent
  return upgradesFor(s.settings.disaster).map(([k, U]) => {
    const { cost, owned, lvl, count } = game.upgradeCost(k)
    const nothing = U.program && !owned && count === 0
    return (
      <div key={k} className="mb-2 rounded-md border border-slate-600 p-2 last:mb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="text-[13px] font-semibold text-white">
            {U.name}
            {U.max ? <span className="ml-1 text-xs text-slate-400">({lvl}/{U.max})</span> : null}
            {U.program && !owned ? <span className="ml-1 text-xs font-normal text-slate-400">· {fmtInt(count)} building{count === 1 ? '' : 's'}</span> : null}
          </div>
          <button
            disabled={owned || nothing || cost > remaining}
            onClick={() => game.buyUpgrade(k)}
            className="shrink-0 rounded bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white enabled:hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400"
          >
            {owned ? (U.program ? 'Done' : 'Owned') : nothing ? 'None needed' : fmtMoney(cost)}
          </button>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{U.desc}</p>
      </div>
    )
  })
}

function upgradesSummary(s, game) {
  const list = upgradesFor(s.settings.disaster)
  const owned = list.filter(([k]) => game.upgradeCost(k).owned).length
  return `${owned}/${list.length} done`
}

/** The tool in hand: what it does, and what the building under the cursor would cost or why it can't. */
function ToolStatus({ s, tool, compact }) {
  return (
    <div className={compact ? 'text-[12px] leading-snug' : 'max-w-md text-sm'}>
      <span className="mr-1">{tool?.icon}</span>
      <span className="font-semibold text-white">{tool?.name}</span>
      {!compact && <span className="ml-2 hidden text-slate-400 lg:inline">{tool?.desc}</span>}
      {s.hover && s.hover.cost > 0 && <span className={`ml-2 font-mono ${s.hover.reason ? 'text-red-400' : 'text-emerald-300'}`}>{s.hover.reason ?? fmtMoney(s.hover.cost)}</span>}
      {compact && !(s.hover && s.hover.cost > 0) && <span className="ml-2 text-slate-400">{s.tool === 'inspect' ? 'Tap a building to see its details and risk.' : 'Tap where to apply it.'}</span>}
      {BUILDING_TOOLS.includes(s.tool) && <Legend />}
    </div>
  )
}

export default function PrepareHUD({ s, game }) {
  const mobile = useIsMobile()
  return mobile ? <MobilePrepare s={s} game={game} /> : <DesktopPrepare s={s} game={game} />
}

function DesktopPrepare({ s, game }) {
  const remaining = s.budget - s.spent
  const disaster = s.settings.disaster
  const tool = TOOLS.find((t) => t.key === s.tool)
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
            <div className="font-semibold text-amber-300">{incoming(s)}</div>
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
        {GROUPS[disaster].map((g) => (
          <div key={g} className="mb-2">
            <div className="px-1 pb-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">{g}</div>
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
      <div className="scroll-thin pointer-events-auto absolute top-24 right-3 flex max-h-[calc(100vh-13rem)] w-80 flex-col gap-2 overflow-y-auto">
        <Section id="overview" title="City overview" summary={overviewSummary(s)}>
          <Overview s={s} />
        </Section>
        <Section id="upgrades" title="City-wide upgrades" summary={upgradesSummary(s, game)}>
          <Upgrades s={s} game={game} />
        </Section>
        <BuildingPanel info={s.selected} title="Selected" onClose={() => game.select(null)} />
        {!s.selected && s.hoverInfo && <BuildingPanel info={s.hoverInfo} title="Hover" />}
      </div>

      {/* bottom bar (leaves the corner to the GitHub credit, an icon below 2xl) */}
      <div className="pointer-events-none absolute right-14 bottom-3 left-3 flex items-end justify-center gap-3 2xl:right-3">
        <div className="panel pointer-events-auto flex items-center gap-3 px-4 py-2.5">
          <ToolStatus s={s} tool={tool} />
          <div className="h-8 w-px bg-slate-700" />
          <button onClick={() => game.toggleOverlay()} className={`rounded-md px-3 py-1.5 text-sm whitespace-nowrap ${s.overlay ? 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-400' : 'text-slate-300 hover:bg-slate-700/60'}`}>
            {disaster === 'quake' ? 'Seismic risk map' : 'Flood risk map'}
          </button>
          <button onClick={() => game.newGame({ ...s.settings, seed: Math.floor(Math.random() * 999999) })} className="rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-slate-300 hover:bg-slate-700/60">
            New map
          </button>
          <button onClick={() => game.startSimulation()} className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-bold whitespace-nowrap text-white shadow-lg shadow-red-900/40 hover:bg-red-500">
            Start disaster ▶
          </button>
        </div>
      </div>
    </>
  )
}

function MobilePrepare({ s, game }) {
  const [sheet, setSheet] = useState(null) // 'overview' | 'upgrades' | 'more'
  const remaining = s.budget - s.spent
  const disaster = s.settings.disaster
  const tool = TOOLS.find((t) => t.key === s.tool)
  const open = (k) => setSheet(sheet === k ? null : k)
  const tab = (k) => `rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap ${sheet === k ? 'bg-sky-500/25 text-white ring-1 ring-sky-400' : 'text-slate-300'}`
  return (
    <>
      {/* top bar: city, disaster, budget */}
      <div className="pointer-events-none absolute top-2 right-2 left-2 flex items-start gap-2">
        <div className="panel pointer-events-auto min-w-0 flex-1 px-3 py-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-bold text-white">{s.city.name}</span>
            <span className="shrink-0 font-mono text-xs text-emerald-300">
              {fmtMoney(remaining)} <span className="text-slate-500">/ {fmtMoney(s.budget)}</span>
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="truncate text-xs font-semibold text-amber-300">{incoming(s)}</span>
            <div className="h-1 min-w-10 flex-1 overflow-hidden rounded bg-slate-700">
              <div className="h-full bg-emerald-400" style={{ width: `${(remaining / s.budget) * 100}%` }} />
            </div>
          </div>
        </div>
        <RepoIcon className="h-9 w-9 shrink-0" />
        <button onClick={() => game.backToMenu()} className="panel pointer-events-auto shrink-0 px-3 py-2 text-sm text-slate-300" aria-label="Back to menu">
          ←
        </button>
      </div>

      {/* bottom: sheet, tool strip, status, actions */}
      <div className="safe-bottom pointer-events-none absolute right-0 bottom-0 left-0 flex flex-col gap-1.5 px-2">
        {s.selected ? (
          <div className="scroll-thin pointer-events-auto max-h-[45vh] overflow-y-auto">
            <BuildingPanel info={s.selected} title="Selected" onClose={() => game.select(null)} />
          </div>
        ) : sheet === 'overview' ? (
          <Sheet title="City overview" onClose={() => setSheet(null)}>
            <Overview s={s} />
          </Sheet>
        ) : sheet === 'upgrades' ? (
          <Sheet title="City-wide upgrades" onClose={() => setSheet(null)}>
            <Upgrades s={s} game={game} />
          </Sheet>
        ) : sheet === 'more' ? (
          <Sheet title="More" onClose={() => setSheet(null)}>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => game.newGame({ ...s.settings, seed: Math.floor(Math.random() * 999999) })} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700/60">
                New map
              </button>
            </div>
          </Sheet>
        ) : null}

        <div className="no-scrollbar pointer-events-auto flex gap-1 overflow-x-auto">
          {GROUPS[disaster].flatMap((g) => TOOLS.filter((t) => t.group === g)).map((t) => (
            <button
              key={t.key}
              onClick={() => game.setTool(t.key)}
              className={`panel flex shrink-0 items-center gap-1 px-2.5 py-1.5 text-xs ${s.tool === t.key ? 'bg-sky-500/30 text-white ring-1 ring-sky-400' : 'text-slate-300'}`}
            >
              <span>{t.icon}</span>
              <span className="whitespace-nowrap">{t.name}</span>
            </button>
          ))}
        </div>

        <div className="panel pointer-events-auto px-3 py-2">
          <ToolStatus s={s} tool={tool} compact />
          <div className="mt-2 flex items-center gap-1">
            <button onClick={() => open('overview')} className={tab('overview')}>
              Overview
            </button>
            <button onClick={() => open('upgrades')} className={tab('upgrades')}>
              Upgrades
            </button>
            <button onClick={() => game.toggleOverlay()} className={`rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap ${s.overlay ? 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-400' : 'text-slate-300'}`}>
              Risk map
            </button>
            <button onClick={() => open('more')} className={tab('more')} aria-label="More options">
              ⋯
            </button>
            <button onClick={() => game.startSimulation()} className="ml-auto shrink-0 rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-bold whitespace-nowrap text-white">
              Start ▶
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
