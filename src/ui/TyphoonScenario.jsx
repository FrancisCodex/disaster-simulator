import { useMemo, useState } from 'react'
import { TYPHOON_LEVELS, HISTORICAL_TYPHOONS } from '../engine/config.js'
import { typhoonScenarioFrom, CUSTOM_TYPHOON, stormCityCoast } from '../engine/game.js'
import { buildStorm, forecastSummary, bulletinGeometry, pagasaCat, tenMinKmh, msToKmh, SIGNALS, TEN_TO_ONE, GUST_LAND, SITE_EXPOSURE, KDM, KT, TIDE_PHASES, M2_PERIOD } from '../engine/typhoonPhysics.js'
import { Slider, Toggle } from './QuakeScenario.jsx'

const HEADINGS = [
  ['N', 0], ['NNE', 22.5], ['NE', 45], ['ENE', 67.5], ['E', 90], ['ESE', 112.5], ['SE', 135], ['SSE', 157.5],
  ['S', 180], ['SSW', 202.5], ['SW', 225], ['WSW', 247.5], ['W', 270], ['WNW', 292.5], ['NW', 315], ['NNW', 337.5],
]
const headingName = (h) => HEADINGS.reduce((a, b) => (Math.abs(((b[1] - h + 540) % 360) - 180) < Math.abs(((a[1] - h + 540) % 360) - 180) ? b : a))[0]

// for "fill from a bulletin": where the district stands
const CITIES = [
  ['Metro Manila', 14.6, 121.0],
  ['Marikina', 14.65, 121.1],
  ['Tuguegarao', 17.61, 121.73],
  ['Laoag', 18.2, 120.59],
  ['Baguio', 16.41, 120.6],
  ['Legazpi', 13.14, 123.74],
  ['Virac', 13.58, 124.23],
  ['Tacloban', 11.24, 125.0],
  ['Iloilo City', 10.72, 122.56],
  ['Cebu City', 10.32, 123.89],
  ['Surigao City', 9.79, 125.49],
  ['Davao City', 7.07, 125.61],
  ['Hong Kong', 22.3, 114.17],
  ['Taipei', 25.03, 121.56],
  ['Naha, Okinawa', 26.21, 127.68],
  ['Tokyo', 35.68, 139.69],
  ['Shanghai', 31.23, 121.47],
  ['Hải Phòng', 20.86, 106.68],
]

const RAIN_BOOSTS = [
  [1, 'None', 'The storm on its own.'],
  [1.4, 'Mountains', 'Moist air forced up hills or mountains rains out more (Hagibis over Hakone, Morakot over Taiwan).'],
  [1.8, 'Monsoon', 'The storm pulls in the southwest monsoon (habagat): rain far from the centre for longer.'],
  [2.6, 'Monsoon + mountains', 'Both together. Ketsana (Ondoy) in 2009 was more extreme still: its reenactment uses ×3.8.'],
]

const SIGNAL_TONE = ['bg-slate-700 text-slate-300', 'bg-sky-500/80 text-white', 'bg-yellow-400 text-slate-900', 'bg-orange-500 text-white', 'bg-red-600 text-white', 'bg-fuchsia-700 text-white']
const SIGNAL_FILL = ['transparent', '#0ea5e9', '#facc15', '#f97316', '#dc2626', '#a21caf']

export function SignalChip({ n, className = '' }) {
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${SIGNAL_TONE[n]} ${className}`}>{n ? `Signal No. ${n}` : 'No signal'}</span>
}

const when = (tau) => (Math.abs(tau) < 0.5 ? 'at closest approach' : tau > 0 ? `${Math.round(tau)} h after` : `${Math.round(-tau)} h before`)

const avgName = (avg) => (avg === 10 ? '10-min (PAGASA / JMA)' : '1-min (JTWC)')

/**
 * Typhoon scenario chooser for the menu: intensity tiers, historical storms, or a custom storm from a bulletin.
 * coast: the city's coastline ({ on, shelf }, chosen with the city); picking a storm that struck a coast puts the city on that kind of coast.
 */
export function TyphoonPicker({ typhoon, setTyphoon, level, setLevel, coast, setCityCoast }) {
  const mode = typhoon.mode ?? 'tier'
  const set = (patch) => setTyphoon({ ...typhoon, ...patch })
  const sc = typhoonScenarioFrom({ typhoon, level, coast })
  const pickStorm = (id) => {
    set({ id, coast: undefined })
    const c = stormCityCoast(id)
    if (c) setCityCoast(c)
  }
  const hist = mode === 'historical' ? sc : null
  const customise = () => {
    const { wind, avg, pc, heading, speed, dist, side, landfall, rmax, r34, lat, rainBoost } = sc
    set({ mode: 'custom', coast: sc.coast, params: { ...CUSTOM_TYPHOON, wind, avg, pc: pc ?? null, heading, speed, dist, side, landfall: landfall ?? null, rmax: rmax ?? null, r34: r34 ?? null, lat, rainBoost: rainBoost ?? 1 } })
  }
  return (
    <div>
      <div className="mb-2 grid grid-cols-3 gap-1 rounded-lg bg-slate-900/50 p-1 text-xs">
        {[
          ['tier', 'Intensity'],
          ['historical', 'Historical'],
          ['custom', 'Custom'],
        ].map(([k, l]) => (
          <button key={k} onClick={() => set({ mode: k, ...(k === 'historical' && !typhoon.id ? { id: 'haiyan2013' } : {}) })} className={`rounded-md py-1.5 ${mode === k ? 'bg-amber-500/25 font-semibold text-amber-100' : 'text-slate-400 hover:text-white'}`}>
            {l}
          </button>
        ))}
      </div>

      {mode === 'tier' && (
        <>
          <input type="range" min={0} max={TYPHOON_LEVELS.length - 1} value={level} onChange={(e) => setLevel(+e.target.value)} className="w-full accent-amber-400" />
          <div className="mt-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-lg font-bold text-white">{sc.name}</span>
              <span className="font-mono text-amber-300">{sc.wind} km/h <span className="text-[10px] text-slate-400">10-min</span></span>
            </div>
            <p className="mt-1 text-sm text-slate-300">{sc.desc}</p>
            <p className="mt-1 text-xs text-slate-400 italic">e.g. {sc.example}</p>
            <button onClick={customise} className="mt-2 text-xs text-sky-300 hover:text-sky-200">
              Customise this storm →
            </button>
          </div>
        </>
      )}

      {mode === 'historical' && (
        <>
          <select value={hist.id} onChange={(e) => pickStorm(e.target.value)} className="w-full rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1.5 text-sm text-white outline-none focus:border-amber-400">
            {HISTORICAL_TYPHOONS.map((h) => (
              <option key={h.id} value={h.id}>
                {h.year} · {h.name}
                {h.local ? ` (${h.local})` : ''}, {h.place} — {h.wind} km/h
              </option>
            ))}
          </select>
          <div className="mt-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-lg font-bold text-white">{hist.title}</span>
              <span className="font-mono text-amber-300">{hist.pc} hPa</span>
            </div>
            <p className="mt-1 text-sm text-slate-300">{hist.desc}</p>
            <p className="mt-1 text-xs text-slate-400">
              Reenacted at <span className="text-slate-200">{hist.city}</span> · {hist.wind} km/h {hist.avg === 10 ? '10-min' : '1-min'} · moving {headingName(hist.heading)} at {hist.speed} km/h · passes {hist.dist} km to the {hist.side === 'right' ? 'left' : 'right'} of the city · deaths {hist.deaths}
            </p>
            {hist.observed && <p className="mt-1 text-xs text-sky-300/90">Recorded: {hist.observed}</p>}
            <button onClick={customise} className="mt-2 text-xs text-sky-300 hover:text-sky-200">
              Customise this storm →
            </button>
          </div>
        </>
      )}

      {mode === 'custom' && <CustomStorm params={{ ...CUSTOM_TYPHOON, ...typhoon.params }} setParams={(params) => set({ params })} />}

      <CoastOptions sc={sc} historical={mode === 'historical'} setCoast={(patch) => set({ coast: { ...typhoon.coast, ...patch } })} />

      <TyphoonForecast sc={sc} defaultOpen />
    </div>
  )
}

const FACINGS = HEADINGS.filter((_, i) => i % 2 === 0)

/** For a coastal city (chosen with the city): which way the sea lies, and the tide. */
function CoastOptions({ sc, historical, setCoast }) {
  const c = sc.coast
  const facing = FACINGS.reduce((a, b) => (Math.abs(((b[1] - c.facing + 540) % 360) - 180) < Math.abs(((a[1] - c.facing + 540) % 360) - 180) ? b : a))
  return (
    <div className="mt-2 space-y-1 rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-xs">
      <div className="font-semibold text-slate-200">🌊 Storm surge</div>
      {!c.on ? (
        <p className="text-[11px] text-slate-500">The city is inland: no storm surge. Choose a coastal city in step 1 to put it on the sea.</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">The sea lies to the</span>
            {historical ? (
              <span className="font-mono text-slate-200">{facing[0]}</span>
            ) : (
              <select value={facing[0]} onChange={(e) => setCoast({ facing: FACINGS.find((h) => h[0] === e.target.value)[1] })} className="rounded border border-slate-700 bg-slate-900/80 px-1.5 py-1 text-white">
                {FACINGS.map(([n]) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            )}
          </div>
          <p className="text-[11px] text-slate-500">Onshore winds pile the sea up against the coast. A storm coming in from the sea, with the city on its {sc.lat >= 0 ? 'right' : 'left'} side, drives the highest surge.</p>
          <Slider label="Tide: high water above mean sea level" value={c.tide} min={0} max={2.5} step={0.1} unit=" m" onChange={(tide) => setCoast({ tide })} />
          <div className="text-slate-400">Tide at closest approach</div>
          <div className="grid grid-cols-4 gap-1">
            {Object.values(TIDE_PHASES).map((t) => (
              <button key={t.key} onClick={() => setCoast({ tidePhase: t.key })} className={`rounded-md border px-1 py-1 text-[11px] ${c.tidePhase === t.key ? 'border-amber-400 bg-amber-500/15 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
                {t.name}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">The same surge at high tide instead of low puts the sea {(2 * c.tide).toFixed(1)} m higher. The tide here is the main lunar tide (M2, {M2_PERIOD} h).</p>
        </>
      )}
    </div>
  )
}

/** A storm built from the numbers a PAGASA / JTWC bulletin prints. */
function CustomStorm({ params: p, setParams }) {
  const setP = (patch) => setParams({ ...p, ...patch })
  const [bulletin, setBulletin] = useState(false)
  const kz = useMemo(() => buildStorm({ ...p, pc: null }).pc(-(p.leadH ?? 24)), [p])
  const cat = pagasaCat(p.avg === 10 ? p.wind : p.wind * TEN_TO_ONE)
  const delta = p.windCA != null ? p.windCA - p.wind : 0
  const switchAvg = (avg) => {
    if (avg === p.avg) return
    const k = avg === 10 ? TEN_TO_ONE : 1 / TEN_TO_ONE
    setP({ avg, wind: Math.round(p.wind * k), windCA: p.windCA != null ? Math.round(p.windCA * k) : null })
  }
  return (
    <div className="space-y-1 rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-xs">
      <div className="text-slate-400">Wind averaging (as the bulletin gives it)</div>
      <div className="grid grid-cols-2 gap-1">
        {[10, 1].map((a) => (
          <button key={a} onClick={() => switchAvg(a)} className={`rounded-md border px-2 py-1 text-[11px] ${p.avg === a ? 'border-amber-400 bg-amber-500/15 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
            {avgName(a)}
          </button>
        ))}
      </div>
      <Slider label={`Maximum sustained wind · ${cat.name}`} value={p.wind} min={30} max={360} step={5} unit=" km/h" onChange={(wind) => setP({ wind, ...(p.windCA != null ? { windCA: wind + delta } : {}) })} />
      <div className="flex items-center justify-between">
        <span className="text-slate-400">Central pressure</span>
        <Toggle label="Auto" on={p.pc == null} onChange={(v) => setP({ pc: v ? null : Math.round(kz) })} hint="Auto: Knaff & Zehr (2007) wind–pressure relationship" />
      </div>
      {p.pc == null ? (
        <p className="text-[11px] text-slate-500">≈ {Math.round(kz)} hPa from the wind (Knaff &amp; Zehr 2007)</p>
      ) : (
        <Slider label="" value={p.pc} min={870} max={1008} unit=" hPa" onChange={(pc) => setP({ pc })} />
      )}
      <Slider label="Forecast change by closest approach" value={delta} min={-120} max={120} step={5} unit=" km/h" fmt={(v) => (v > 0 ? `+${v}` : v)} onChange={(d) => setP({ windCA: d ? p.wind + d : null })} />
      {delta !== 0 && <Slider label="Hours from this bulletin to closest approach" value={Math.round(p.leadH ?? 24)} min={3} max={72} unit=" h" onChange={(leadH) => setP({ leadH })} />}

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-slate-400">Moving toward</span>
        <select value={headingName(p.heading)} onChange={(e) => setP({ heading: HEADINGS.find((h) => h[0] === e.target.value)[1] })} className="rounded border border-slate-700 bg-slate-900/80 px-1.5 py-1 text-white">
          {HEADINGS.map(([n]) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <Slider label="Forward speed" value={p.speed} min={2} max={60} unit=" km/h" onChange={(speed) => setP({ speed })} />
      <p className="text-[11px] text-slate-500">Slow storms are the rain killers: the same storm at half the speed drops twice the rain.</p>
      <Slider label="Closest approach to the city" value={p.dist} min={0} max={300} unit=" km" onChange={(dist) => setP({ dist })} />
      <div className="grid grid-cols-2 gap-1">
        {[
          ['left', 'Track passes to the right of the city'],
          ['right', 'Track passes to the left of the city'],
        ].map(([k, l]) => (
          <button key={k} onClick={() => setP({ side: k })} className={`rounded-md border px-2 py-1 text-left text-[11px] ${p.side === k ? 'border-amber-400 bg-amber-500/15 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
            {l}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">
        Facing the way the storm moves, its {p.lat >= 0 ? 'right' : 'left'} side is the windy one: the storm's own motion adds to the winds there{p.lat < 0 ? ' (southern hemisphere)' : ''}.
      </p>
      <div className="flex items-center justify-between pt-1">
        <span className="text-slate-400">Landfall</span>
        <Toggle label="Stays at sea" on={p.landfall == null} onChange={(v) => setP({ landfall: v ? null : -2 })} hint="A coastal city with the centre still over water" />
      </div>
      {p.landfall != null && (
        <Slider label="Landfall relative to closest approach" value={p.landfall} min={-48} max={12} step={0.5} fmt={(v) => (v < 0 ? `${-v} h before` : v > 0 ? `${v} h after` : 'at closest approach')} onChange={(landfall) => setP({ landfall })} />
      )}

      <div className="flex items-center justify-between pt-1">
        <span className="text-slate-400">Radius of maximum wind</span>
        <Toggle label="Auto" on={p.rmax == null} onChange={(v) => setP({ rmax: v ? null : 25 })} hint="Auto: Willoughby et al. (2006) from wind and latitude" />
      </div>
      {p.rmax != null && <Slider label="" value={p.rmax} min={5} max={100} unit=" km" onChange={(rmax) => setP({ rmax })} />}
      <div className="flex items-center justify-between">
        <span className="text-slate-400">Radius of gale-force winds</span>
        <Toggle label="Auto" on={p.r34 == null} onChange={(v) => setP({ r34: v ? null : 250 })} hint="PAGASA bulletins give the extent of gale-force winds; sets how fast winds drop off away from the eyewall (Holland et al. 2010)" />
      </div>
      {p.r34 != null && <Slider label="" value={p.r34} min={50} max={700} step={10} unit=" km" onChange={(r34) => setP({ r34 })} />}
      <Slider label="Latitude" value={p.lat} min={-35} max={40} step={0.5} unit="°" fmt={(v) => `${Math.abs(v)}${v < 0 ? ' S' : ' N'}`} onChange={(lat) => setP({ lat: lat === 0 ? 0.5 : lat })} />
      <div className="text-slate-400">Extra rain</div>
      <div className="grid grid-cols-2 gap-1">
        {RAIN_BOOSTS.map(([v, l, d]) => (
          <button key={v} onClick={() => setP({ rainBoost: v })} title={d} className={`rounded-md border px-2 py-1 text-left text-[11px] ${p.rainBoost === v ? 'border-amber-400 bg-amber-500/15 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
            {l}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">{(RAIN_BOOSTS.find((r) => r[0] === p.rainBoost) ?? RAIN_BOOSTS[0])[2]}</p>

      <button onClick={() => setBulletin(!bulletin)} className="pt-1 text-sky-300 hover:text-sky-200">
        {bulletin ? '▴' : '▾'} Fill the track from a bulletin position
      </button>
      {bulletin && <BulletinTrack p={p} setP={setP} />}
    </div>
  )
}

/** Storm position + movement from a bulletin, and the city's position → closest approach, side and lead time. */
function BulletinTrack({ p, setP }) {
  const [pos, setPos] = useState({ lat: 12.5, lon: 128.5, city: 0, clat: CITIES[0][1], clon: CITIES[0][2] })
  const g = bulletinGeometry({ lat: pos.lat, lon: pos.lon, heading: p.heading, speed: p.speed }, { lat: pos.clat, lon: pos.clon })
  const num = (k) => (e) => setPos({ ...pos, [k]: +e.target.value })
  const input = 'w-20 rounded border border-slate-700 bg-slate-900/80 px-1.5 py-0.5 text-right font-mono text-white'
  return (
    <div className="space-y-1.5 rounded border border-slate-700/70 bg-slate-950/40 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-400">Centre (bulletin)</span>
        <span className="flex gap-1">
          <input type="number" step="0.1" value={pos.lat} onChange={num('lat')} className={input} title="Latitude °N" />
          <input type="number" step="0.1" value={pos.lon} onChange={num('lon')} className={input} title="Longitude °E" />
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-400">The city stands in for</span>
        <select value={pos.city} onChange={(e) => {
          const i = +e.target.value
          setPos(i < 0 ? { ...pos, city: i } : { ...pos, city: i, clat: CITIES[i][1], clon: CITIES[i][2] })
        }} className="rounded border border-slate-700 bg-slate-900/80 px-1.5 py-0.5 text-white">
          {CITIES.map(([n], i) => (
            <option key={n} value={i}>
              {n}
            </option>
          ))}
          <option value={-1}>Other (lat / lon)…</option>
        </select>
      </div>
      {pos.city < 0 && (
        <div className="flex justify-end gap-1">
          <input type="number" step="0.01" value={pos.clat} onChange={num('clat')} className={input} title="City latitude" />
          <input type="number" step="0.01" value={pos.clon} onChange={num('clon')} className={input} title="City longitude" />
        </div>
      )}
      <p className="text-[11px] text-slate-400">
        Now {g.now} km away. On its current heading ({headingName(p.heading)}, {p.speed} km/h) it {g.leadH > 0 ? `passes ${g.dist} km ${g.side === 'right' ? 'to the left' : 'to the right'} of the city in about ${Math.round(g.leadH)} h` : 'is already moving away from the city'}.
      </p>
      <button
        disabled={g.leadH <= 0}
        onClick={() => setP({ dist: Math.min(300, g.dist), side: g.side, leadH: Math.max(3, Math.round(g.leadH)), lat: Math.round(pos.clat * 2) / 2 || 0.5 })}
        className="w-full rounded bg-sky-600/80 py-1 font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
      >
        Use this track
      </button>
      <p className="text-[10px] text-slate-500">A straight-line track from the bulletin's position and movement. Real storms curve; use the forecast track's closest point if you have it.</p>
    </div>
  )
}

/** What the storm will do at the city: peak wind, signal, pressure, rain, eye — and a timeline. */
export function TyphoonForecast({ sc, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const [eq, setEq] = useState(false)
  const fc = useMemo(() => forecastSummary(buildStorm(sc)), [sc])
  const kmh = (ms) => Math.round(msToKmh(ms))
  return (
    <div className="mt-2 rounded-lg border border-slate-700/70 bg-slate-900/40 text-xs">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="font-semibold text-slate-200">Forecast for the city</span>
        <span className="flex items-center gap-2 text-slate-400">
          {Math.round(fc.peakKmh10)} km/h <SignalChip n={fc.signal} /> {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          <Timeline fc={fc} />
          <Sec title="At the city">
            <R k="Peak sustained wind (10-min)" v={`${Math.round(fc.peakKmh10)} km/h`} accent="text-amber-300" />
            <R k="Peak gusts (3-s)" v={`~${kmh(fc.peakGust)} km/h`} />
            <R k="Highest wind signal" v={fc.signal ? `No. ${fc.signal} · ${SIGNALS[fc.signal - 1].name.toLowerCase()}` : 'none'} />
            <R k="Lowest pressure" v={`${Math.round(fc.pmin)} hPa`} />
            <R k="Storm-total rain" v={`~${Math.round(fc.rainTotal)} mm`} accent="text-sky-300" />
            <R k="Eye passes over" v={fc.eyeH > 0 ? `yes, ~${Math.max(10, Math.round((fc.eyeH * 60) / 10) * 10)} min of calm` : 'no'} accent={fc.eyeH > 0 ? 'text-red-300' : undefined} />
            <R k="Simulation starts" v={`${Math.round(-fc.startH)} h before closest approach`} />
          </Sec>
          {fc.sea && (
            <Sec title="The sea at the coast">
              <R k="Peak sea level (above normal)" v={`${fc.sea.peak.toFixed(1)} m · ${when(fc.sea.peakTau)}`} accent={fc.sea.peak >= 2 ? 'text-red-300' : 'text-sky-300'} />
              <R k="Storm surge at the peak" v={`${fc.sea.surgeAtPeak.toFixed(1)} m`} />
              <R k="· low pressure / wind / waves" v={`${fc.sea.parts.pressure.toFixed(1)} / ${fc.sea.parts.wind.toFixed(1)} / ${fc.sea.parts.wave.toFixed(1)} m`} />
              <R k="Tide at the peak" v={`${fc.sea.tideAtPeak >= 0 ? '+' : '−'}${Math.abs(fc.sea.tideAtPeak).toFixed(1)} m`} />
            </Sec>
          )}
          <Sec title="The storm at closest approach">
            <R k={`Category (PAGASA)${fc.ss ? ' · Saffir–Simpson' : ''}`} v={`${fc.category.name}${fc.ss ? ` · Cat ${fc.ss}` : ''}`} />
            <R k="Max sustained near the centre" v={`${Math.round(tenMinKmh(fc.vmaxCA))} km/h 10-min · ${kmh(fc.vmaxCA)} 1-min`} />
            <R k="Central pressure" v={`${Math.round(fc.pcCA)} hPa`} />
            <R k="Radius of maximum wind" v={`${Math.round(fc.rmax)} km`} />
            <R k="Holland B · outer exponent" v={`${fc.B.toFixed(2)} · ${fc.xn.toFixed(2)}`} />
          </Sec>
          <p className="text-[10px] text-slate-500">
            City winds are for open ground at the coast (×{SITE_EXPOSURE} of the marine wind). Buildings feel more at roof height and in the open, less behind taller neighbours.{fc.sea ? ' Sea levels are a bulk estimate at the coast, not a full surge model; wave runup comes on top.' : ''}
          </p>
          <button onClick={() => setEq(!eq)} className="text-sky-300 hover:text-sky-200">
            {eq ? 'Hide' : 'Show'} equations
          </button>
          {eq && <Equations />}
        </div>
      )}
    </div>
  )
}

/** 10-min wind (line) and rain (bars) at the city over the storm's passage, with the wind signals behind. */
function Timeline({ fc }) {
  const from = fc.startH
  const to = Math.max(fc.endH + 4, 6)
  const pts = fc.timeline.filter((e) => e.tau >= from && e.tau <= to)
  const W = 300
  const H = 96
  const x = (tau) => ((tau - from) / (to - from)) * W
  const maxW = Math.max(80, ...pts.map((e) => e.kmh10)) * 1.1
  const maxR = Math.max(10, ...pts.map((e) => e.rain)) * 1.1
  const yW = (v) => H - (v / maxW) * (H - 6)
  const line = pts.map((e, i) => `${i ? 'L' : 'M'}${x(e.tau).toFixed(1)},${yW(e.kmh10).toFixed(1)}`).join('')
  const bands = []
  for (const g of SIGNALS) if (g.kmh < maxW) bands.push(g)
  // sea level at the coast (m above normal), on its own scale
  const sea = fc.sea?.timeline.filter((e) => e.tau >= from && e.tau <= to)
  const maxS = sea ? Math.max(2, ...sea.map((e) => e.level)) * 1.1 : 1
  const yS = (v) => H - ((v + 1) / (maxS + 1)) * (H - 6)
  const seaLine = sea?.map((e, i) => `${i ? 'L' : 'M'}${x(e.tau).toFixed(1)},${yS(e.level).toFixed(1)}`).join('')
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 12}`} className="w-full" role="img" aria-label="Wind and rain at the city over time">
        {bands.map((g, i) => (
          <rect key={g.n} x={0} width={W} y={yW(Math.min(maxW, bands[i + 1]?.kmh ?? maxW))} height={yW(g.kmh) - yW(Math.min(maxW, bands[i + 1]?.kmh ?? maxW))} fill={SIGNAL_FILL[g.n]} opacity={0.12} />
        ))}
        {pts.map((e) => (
          <rect key={e.tau} x={x(e.tau)} width={W / pts.length + 0.3} y={H - (e.rain / maxR) * (H * 0.6)} height={(e.rain / maxR) * (H * 0.6)} fill="#38bdf8" opacity={0.45} />
        ))}
        {seaLine && <path d={seaLine} fill="none" stroke="#22d3ee" strokeWidth={1.4} strokeDasharray="4 2" />}
        <path d={line} fill="none" stroke="#fbbf24" strokeWidth={1.6} />
        <line x1={x(0)} x2={x(0)} y1={0} y2={H} stroke="#94a3b8" strokeDasharray="2 2" strokeWidth={0.8} />
        <text x={x(0) + 2} y={9} fontSize={8} fill="#94a3b8">
          closest
        </text>
        <text x={0} y={H + 10} fontSize={8} fill="#64748b">
          {Math.round(from)} h
        </text>
        <text x={W} y={H + 10} fontSize={8} fill="#64748b" textAnchor="end">
          +{Math.round(to)} h
        </text>
      </svg>
      <div className="flex justify-between text-[10px] text-slate-500">
        <span>
          <span className="text-amber-300">━</span> wind {Math.round(maxW / 1.1)} km/h max
        </span>
        {sea && (
          <span>
            <span className="text-cyan-400">┅</span> sea +{(maxS / 1.1).toFixed(1)} m max
          </span>
        )}
        <span>
          <span className="text-sky-400">▮</span> rain {Math.round(maxR / 1.1)} mm/h max
        </span>
      </div>
    </div>
  )
}

function Sec({ title, children }) {
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

function Equations() {
  const lines = [
    ['Wind profile (Holland 1980 / 2010)', 'V(r) = Vm·[(Rm/r)^B·e^(1−(Rm/r)^B)]^x,  x = ½ inside Rm, fitted to the gale radius outside'],
    ['Shape parameter', 'B = ρ·e·Vm² / Δp,  ρ = 1.15 kg/m³'],
    ['Pressure', 'p(r) = pc + Δp·exp(−(Rm/r)^B)'],
    ['Wind–pressure (Knaff & Zehr 2007)', 'Δp = −23.29 + 0.483·Vsrm + (Vsrm/24.25)² + 12.59·S + 0.483·|φ|,  Vsrm = Vmax − 1.5·c^0.63 (kt)'],
    ['Radius of max wind (Willoughby 2006)', 'Rm = 46.4·exp(−0.0155·Vmax + 0.0169·|φ|) km'],
    ['Asymmetry', 'V = Vsym(r) + 0.55·c·Vsym(r)/Vm along the motion; inflow 22° at sea, 35° over land'],
    ['Inland decay (Kaplan & DeMaria 1995)', `V(t) = Vb + (V₀ − Vb)·e^(−αt),  Vb = ${(KDM.vb / KT).toFixed(1)} kt, α = ${KDM.alpha} h⁻¹`],
    ['Averaging and gusts (WMO 2010)', `10-min = ${TEN_TO_ONE} × 1-min;  3-s gust ≈ ${GUST_LAND} × 1-min over land`],
    ['Rain (R-CLIPER, Tuleya 2007)', 'R = T₀ + (Tm − T₀)·r/rm inside rm,  Tm·e^(−(r−rm)/re) outside; + eye, eyewall and spiral rainbands'],
    ['Wind signals (PAGASA 2022)', 'No. 1–5 at 39 / 62 / 89 / 118 / 185 km/h, raised 36 / 24 / 18 / 12 / 12 h ahead'],
    ['Storm surge (bulk model)', 'η = Δp/(ρw·g) + k·ρa·Cd·|U|·Uₙ·L/(ρw·g·h) + 0.15·Hs,  Hs ≈ 0.2·U;  Cd: Large & Pond (1981), ≤ 2.5×10⁻³'],
    ['Surge build-up and tide', 'wind setup relaxes over L/√(g·h);  tide = A·cos(2π(t − t_high)/12.42 h)'],
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
