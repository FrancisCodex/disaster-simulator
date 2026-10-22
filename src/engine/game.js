// Game orchestrator: phases (menu → prepare → sim → results), editing tools,
// budget, simulation clock and the bridge between simulations and renderer.
import {
  GRID,
  CELL_GRASS,
  CELL_ROAD,
  CELL_RIVER,
  CELL_PARK,
  CELL_POND,
  CITY_TYPES,
  BUILDING_TYPES,
  CONSTRUCTION,
  QUAKE_LEVELS,
  HISTORICAL_QUAKES,
  TYPHOON_LEVELS,
  HISTORICAL_TYPHOONS,
  roofKind,
  COSTS,
  UPGRADES,
  SPEEDS,
  LEVEE_HEIGHT,
  POND_DEPTH,
  DAMAGE_STATES,
  VARIANT_NAMES,
  SEAWALL_HEIGHT,
  BIG_PUMP_RATE,
  RIVER_HALF_WIDTH,
} from './config.js'
import { DEFAULT_PLAN, SUGGESTED_PLAN } from './evacPlan.js'
import { generateCity, addBuilding, idx, occupancyAt, cityStats, cellToWorld } from './cityGen.js'
import { Rng, clamp, smoothstep } from './math.js'
import { World, sheddingFacade } from './world.js'
import { FloodSim, forecastRiverPeak, GATE_SURGE, GATE_PUMP } from './floodSim.js'
import { floodMap, depthColor, LENS_GREY } from './floodMap.js'
import { buildStorm, forecastSummary, catchmentRain } from './typhoonPhysics.js'
import { windRisk, roofOf } from './windDamage.js'
import { hazardForecast, CG_SHARE } from './stormHazards.js'
import { StormRun } from './stormRun.js'
import { ShadowRuns } from './stormShadow.js'
import { typhoonReport, PEOPLE_UPGRADES } from './stormReport.js'
import { QuakeSim, demand, mediansFor, damageProbs, collapseProb, cellOfBuilding, soilName, rockPgaAt, withGeometry, quakeAzimuth, shapeOf, dsFromD, compass, groundPeriod, buildingPeriod, resonance, softStoreyOf } from './quakeSim.js'
import { siteDistances } from './quakePhysics.js'

/**
 * The earthquake a set of menu settings describes. settings.quake:
 *   { mode: 'tier' } uses QUAKE_LEVELS[settings.level];
 *   { mode: 'historical', id } a HISTORICAL_QUAKES reenactment;
 *   { mode: 'custom', params: {M, depth, dist, mech, strike, rupture, dip?} }.
 * Common options: bearing (deg, null = random from the seed), variability, aftershocks.
 */
export const CUSTOM_QUAKE = { M: 7.0, depth: 15, dist: 20, mech: 'strike', strike: 30, rupture: 'bilateral' }

export function quakeEventFrom(settings) {
  const q = settings.quake ?? { mode: 'tier' }
  let ev
  if (q.mode === 'historical') {
    const h = HISTORICAL_QUAKES.find((x) => x.id === q.id) ?? HISTORICAL_QUAKES[0]
    ev = { ...h, title: `${h.year} ${h.name}`, name: `${h.year} ${h.name}`, example: `Reenacted at ${h.city}, ${h.place}.` }
  } else if (q.mode === 'custom') {
    ev = { name: 'Custom earthquake', desc: 'Your own scenario.', example: '', ...CUSTOM_QUAKE, ...q.params }
  } else ev = { ...QUAKE_LEVELS[clamp(settings.level ?? 3, 0, QUAKE_LEVELS.length - 1)] }
  // freq: the ground's shaking frequency (Hz; null: what the earthquake and the soil produce);
  // soil: 'map' keeps the generated ground, or 'rock' / 'stiff' / 'sand' everywhere
  return { mech: 'strike', strike: 90, rupture: 'bilateral', ...ev, mode: q.mode ?? 'tier', bearing: q.bearing ?? null, variability: q.variability !== false, aftershocks: q.aftershocks !== false, freq: q.freq ?? null, soil: q.soil ?? 'map' }
}

/**
 * The typhoon a set of menu settings describes. settings.typhoon:
 *   { mode: 'tier' } uses TYPHOON_LEVELS[settings.level];
 *   { mode: 'historical', id } a HISTORICAL_TYPHOONS reenactment;
 *   { mode: 'custom', params } a storm from a bulletin (see buildStorm in typhoonPhysics.js).
 * Whether the city is on the coast, and its shelf, come from settings.coast (the
 * city's own setting, for any disaster); settings.typhoon.coast overrides the
 * storm's sea direction and tide (see TYPHOON_LEVELS).
 */
export const CUSTOM_TYPHOON = { wind: 150, avg: 10, pc: null, windCA: null, leadH: 24, heading: 290, speed: 20, dist: 20, side: 'right', landfall: null, rmax: null, r34: null, lat: 14, rainBoost: 1 }
export const DEFAULT_COAST = { on: false, shelf: 'open', facing: null, tide: 0.5, tidePhase: 'rising' }

/** The coast a historical storm struck, as a city setting ({ on, shelf }), or null when it hit inland. */
export function stormCityCoast(id) {
  const c = HISTORICAL_TYPHOONS.find((x) => x.id === id)?.coast
  return c?.on ? { on: true, shelf: c.shelf } : null
}

export function typhoonScenarioFrom(settings) {
  const t = settings.typhoon ?? { mode: 'tier' }
  let sc
  if (t.mode === 'historical') {
    const h = HISTORICAL_TYPHOONS.find((x) => x.id === t.id) ?? HISTORICAL_TYPHOONS[0]
    const title = `${h.year} ${h.name}${h.local ? ` (${h.local})` : ''}`
    sc = { ...CUSTOM_TYPHOON, ...h, mode: 'historical', title, example: `Reenacted at ${h.city}, ${h.place}.` }
  } else if (t.mode === 'custom') sc = { ...CUSTOM_TYPHOON, name: 'Custom typhoon', title: 'Custom typhoon', desc: 'Your own storm, from a bulletin or a what-if.', example: '', ...t.params, mode: 'custom' }
  else {
    const L = TYPHOON_LEVELS[clamp(settings.level ?? 4, 0, TYPHOON_LEVELS.length - 1)]
    sc = { ...CUSTOM_TYPHOON, ...L, mode: 'tier', title: L.name }
  }
  const coast = { ...DEFAULT_COAST, ...sc.coast, ...t.coast }
  // the city decides whether there is a coast at all, and what its shelf is like
  if (settings.coast) {
    coast.on = !!settings.coast.on
    coast.shelf = settings.coast.shelf ?? coast.shelf
  }
  // unless told otherwise, the sea lies the way the storm comes from
  if (coast.facing == null) coast.facing = (sc.heading + 180) % 360
  // tornado: 'natural' (the climatology's odds), or 'ef1' / 'ef2' sends one through the city (a what-if)
  return { ...sc, coast, tornado: t.tornado ?? 'natural' }
}

/** The coast a city is generated with for these settings ({ shelf }), or null for an inland city. */
export function cityCoastFrom(settings) {
  return settings.coast?.on ? { shelf: settings.coast.shelf ?? 'open' } : null
}

export const TOOLS = [
  { key: 'inspect', name: 'Inspect', group: 'General', icon: '🔍', desc: 'Click a building to see its details and risk.' },
  { key: 'demolish', name: 'Demolish', group: 'General', icon: '🧨', desc: 'Remove a building, levee or pump. Residents must be rehoused in new housing.' },
  { key: 'house', name: 'House', group: 'Build', icon: '🏠', desc: 'Modern wood-frame house (2 floors). Rehouses relocated residents.', size: [2, 2] },
  { key: 'apartment', name: 'Apartments', group: 'Build', icon: '🏢', desc: 'Modern seismic-code apartment block. Rehouses relocated residents.', size: [3, 3] },
  { key: 'hospital', name: 'Hospital', group: 'Build', icon: '🏥', desc: 'Treats critically injured people. Built to high seismic code.', size: [4, 4] },
  { key: 'fire', name: 'Fire & Rescue', group: 'Build', icon: '🚒', desc: 'Puts out fires, digs out trapped people, runs boat rescues in floods.', size: [3, 3] },
  { key: 'shelter', name: 'Shelter', group: 'Build', icon: '⛺', desc: 'Evacuation centre. Put it on high ground, away from the river.', size: [3, 3] },
  { key: 'park', name: 'Park', group: 'Build', icon: '🌳', desc: 'Green space soaks up rain and gives open space after an earthquake.', size: [3, 3] },
  { key: 'cycshelter', name: 'Cyclone shelter', group: 'Build', icon: '🏛️', desc: 'An evacuation centre on a floor raised 3 m, with a concrete roof and shutters, built for super-typhoon winds (the Ligtas Pinoy standard). A school or hall the rest of the year.', size: [3, 3], disaster: 'typhoon' },
  { key: 'levee', name: 'Flood wall', group: 'Flood', icon: '🧱', desc: 'Drag to paint a flood wall, 2, 3 or 4 m high. Can fail if overtopped.', size: [1, 1] },
  { key: 'pump', name: 'Pump station', group: 'Flood', icon: '⛽', desc: 'Pumps 10 m³/s of floodwater into the river. Fails if its site floods; stops in a blackout without backup generators.', size: [1, 1] },
  { key: 'bigpump', name: 'Large pump', group: 'Flood', icon: '🏭', desc: `Pumps ${BIG_PUMP_RATE} m³/s of floodwater into the river. Fails if its site floods; stops in a blackout without backup generators.`, size: [1, 1] },
  { key: 'seawall', name: 'Sea wall', group: 'Coast', icon: '🧱', desc: `Drag to paint a ${SEAWALL_HEIGHT} m concrete sea wall along the shore (like the Leyte Tide Embankment). Flap culverts let rain water behind it drain out at low tide. The surge goes round it up the river unless the river is gated or its banks walled; a surge near the crest can breach it.`, size: [1, 1], coastal: true },
  { key: 'rivergate', name: 'River gate', group: 'Coast', icon: '🚧', desc: `A storm-surge barrier across the river near its mouth: open for ordinary tides, it shuts once a surge lifts the sea ${GATE_SURGE} m above normal, and pumps ${GATE_PUMP} m³/s of river water over itself until the surge passes. A river in flood still piles up behind it: wall the banks or add an upstream floodway. Tie it into the sea wall on both banks.`, size: [1, 1], coastal: true },
  { key: 'mangrove', name: 'Mangroves', group: 'Coast', icon: '🌿', desc: 'Drag to plant a mangrove belt in the shallows. A belt a few hundred metres wide breaks most of the waves riding on a surge, but lowers the surge itself by only centimetres.', size: [1, 1], coastal: true },
  { key: 'straps', name: 'Roof straps', group: 'Wind', icon: '🔗', desc: 'Hurricane ties on every rafter or truss: the roof stays on and the walls stay braced (+30% wind resistance of the roof structure).' },
  { key: 'fixings', name: 'Sheet fixings', group: 'Wind', icon: '🪛', desc: 'Screws at every purlin and edge strips: the sheets stay on (+25%), and those that go mostly stay with the roof instead of flying.' },
  { key: 'shutters', name: 'Storm shutters', group: 'Wind', icon: '🪟', desc: 'Shutters or impact glass: windows hold against flying roof sheets, so the wind can\'t get in and push the roof off from inside. They only help once closed: put that in the plan.' },
  { key: 'rod', name: 'Lightning rod', group: 'Wind', icon: '⚡', desc: 'A lightning protection system: strikes on the building go safely to ground.' },
  { key: 'pond', name: 'Retention pond', group: 'Flood', icon: '💧', desc: `Excavates a ${POND_DEPTH} m deep basin that stores stormwater.`, size: [4, 4] },
  { key: 'elevate', name: 'Elevate', group: 'Flood', icon: '⬆️', desc: 'Raise a low-rise building 2 m on a new foundation.' },
  { key: 'retrofit', name: 'Retrofit', group: 'Quake', icon: '🔩', desc: 'Strengthen the structure one code level (e.g. masonry → reinforced concrete).' },
  { key: 'isolate', name: 'Base isolation', group: 'Quake', icon: '🛞', desc: 'Put the building on seismic isolators. Very effective, very expensive.' },
  { key: 'softstorey', name: 'Brace soft storey', group: 'Quake', icon: '🏗️', desc: 'Add steel frames or shear walls to an open shopfront ground floor (the LA / San Francisco soft-storey retrofit). Cheap: only the ground floor is worked on.' },
  { key: 'anchor', name: 'Anchor facade', group: 'Quake', icon: '🧷', desc: 'Tie back brick facades and parapets, film the glass. Stops most of the falling masonry and glass that kills people in the street (Christchurch 2011).' },
]

export const BUILDING_TOOLS = ['retrofit', 'isolate', 'elevate', 'softstorey', 'anchor', 'straps', 'fixings', 'shutters', 'rod']
// tools painted cell by cell with a drag
export const PAINT_TOOLS = ['levee', 'seawall', 'mangrove']
const QUAKE_TOOLS = ['retrofit', 'isolate', 'softstorey', 'anchor']
// what each spending key counts towards in the after-action comparison
const SPEND_GROUP = {
  retrofit: 'structural',
  isolate: 'structural',
  urmProgram: 'structural',
  criticalProgram: 'structural',
  softstorey: 'brace',
  softStoreyProgram: 'brace',
  anchor: 'anchor',
  facadeProgram: 'anchor',
  demolish: 'demolish',
  house: 'demolish',
  apartment: 'demolish',
  quakeWarning: 'warning',
  gasShutoff: 'gas',
}
// fraction of a building's value lost in each damage state (slight … complete), after HAZUS
const LOSS_RATIO = [0.02, 0.1, 0.5, 1]

/** Does building b already have the measure this tool applies? */
function hasMeasure(tool, b) {
  if (tool === 'retrofit') return !!b.origConstruction && b.construction !== 'isolated'
  if (tool === 'isolate') return b.construction === 'isolated'
  if (tool === 'softstorey') return !!b.softFixed && !!b.openFront
  if (tool === 'anchor') return !!b.facadeAnchored
  if (tool === 'elevate') return b.elevated > 0
  if (tool === 'straps' || tool === 'fixings' || tool === 'shutters' || tool === 'rod') return !!b[tool]
  return false
}

const NEW_BUILD = {
  house: { floors: 2, construction: 'wood_mod' },
  apartment: { floors: 6, construction: 'rc_high' },
  hospital: { floors: 5, construction: 'rc_high' },
  fire: { floors: 2, construction: 'rc_high' },
  shelter: { floors: 2, construction: 'rc_high' },
  // a raised, slab-roofed, shuttered evacuation centre
  cycshelter: { type: 'shelter', floors: 2, construction: 'rc_high', premium: 1.35 },
}

export const START_TIMES = [
  { hour: 2, label: 'Night', sub: '02:00 — people asleep at home' },
  { hour: 8, label: 'Morning', sub: '08:00 — rush hour' },
  { hour: 13, label: 'Midday', sub: '13:00 — offices & schools full' },
  { hour: 19, label: 'Evening', sub: '19:00 — people heading home' },
]


function heat(t) {
  t = clamp(t, 0, 1)
  if (t < 0.5) return `hsl(${130 - t * 2 * 75}, 70%, 48%)`
  return `hsl(${55 - (t - 0.5) * 2 * 55}, 85%, 50%)`
}

export class Game {
  constructor(container) {
    this.world = new World(container)
    this.listeners = new Set()
    this.version = 0
    this.phase = 'menu'
    this.tool = 'inspect'
    this.overlay = false
    this.speedIdx = 1
    this.paused = false
    this.log = []
    this.notice = null
    this.selected = null
    this.hover = null
    this.last = performance.now()
    this.world.onImpact = (bid, e) => this.buildingHit(bid, e)
    this.world.onStreetHit = (hit) => this.streetHit(hit)
    this.world.onAssetsLoaded = () => {
      // swap in the detailed vehicles, but never in the middle of a disaster
      if (!this.city || this.phase === 'sim' || this.phase === 'results') return
      this.world.life.build(this.city, this.phase === 'menu' ? 17.5 : this.settings.startHour)
    }
    this.bindInput()
    this.loadDemo()
    this.running = true
    const loop = () => {
      if (!this.running) return
      const now = performance.now()
      const dt = Math.min(0.1, (now - this.last) / 1000)
      this.last = now
      this.frame(dt)
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit() {
    this.version++
    for (const fn of this.listeners) fn(this.version)
  }

  destroy() {
    this.running = false
    this.abort.abort()
    this.world.dispose()
  }

  // ---------------------------------------------------------------- setup
  loadDemo() {
    const city = generateCity('metropolis', Math.floor(Math.random() * 1e9))
    this.city = city
    this.world.buildCity(city, 17.5)
    this.preview = new FloodSim(city)
    this.preview.computeFlow()
    this.world.updateWater(this.preview)
    this.world.subsurface.setQuake(null)
    this.world.focus(0, 0, 900)
    this.world.controls.autoRotate = true
    this.world.controls.autoRotateSpeed = 0.35
    this.world.setEnvironment({ hour: 17.5 })
  }

  newGame(settings) {
    this.settings = { ...settings }
    const city = generateCity(settings.cityType, settings.seed, { coast: cityCoastFrom(settings) })
    this.setupCity(city)
    this.budget = CITY_TYPES[city.type].budget
    this.spent = 0
    this.upgrades = { floodWarning: false, drainage: 0, dredge: false, quakeWarning: false, gasShutoff: false, poles: 0 }
    // the typhoon plan: when each action is taken (evacPlan.js)
    this.plan = { ...DEFAULT_PLAN }
    this.leveeHeight = LEVEE_HEIGHT
    this.relocated = 0
    this.actions = {}
    this.spentBy = {}
    // the city as generated, before any preparation: what the results compare against
    this.baselineCity = structuredClone(city)
    this.world.focus((city.center.i - GRID / 2) * 10, (city.center.j - GRID / 2) * 10, city.type === 'rural' ? 520 : 760)
    this.notify(`Welcome to ${city.name}. Prepare the city — then start the disaster.`)
    this.emit()
  }

  setupCity(city) {
    this.city = city
    this.phase = 'prepare'
    this.tool = 'inspect'
    this.selected = null
    this.overlay = false
    this.riskLayer ??= 'flood'
    this.lens = 'city'
    this.lensStats = null
    this.world.setLabels([])
    this.floodLevel = null
    this.seaLevelMap = null
    this.log = []
    this.results = null
    this.stopShadows()
    this.flood = this.quake = this.impact = this.shadow = this.typhoon = this.windDmg = this.hazards = this.tyFire = this.run = null
    // the old colouring reads the simulation just cleared: drop it before the new city is drawn
    this.world.colorFn = null
    this.world.controls.autoRotate = false
    this.world.gateShut = false
    this.world.buildCity(city, this.settings.startHour)
    for (const b of city.buildings) b.openFront = this.world.openFront(b)
    this.world.burning = []
    this.preview = new FloodSim(city)
    this.preview.computeFlow()
    this.world.updateWater(this.preview)
    this.world.setEnvironment({ hour: this.settings.startHour })
    this.updateFault()
    this.applyColorMode()
  }

  /** Point the cut-away view's fault at this scenario's epicentre (same draw the QuakeSim will make). */
  updateFault() {
    const s = this.settings
    if (s?.disaster !== 'quake') return this.world.subsurface.setQuake(null)
    const L = this.quakeEvent()
    this.world.subsurface.setQuake({ az: L.az, dist: L.dist, depth: L.depth, M: L.M })
  }

  /** This scenario's earthquake with its epicentre direction and fault geometry (same draw the QuakeSim makes). */
  quakeEvent() {
    const s = this.settings
    const key = JSON.stringify([s.quake, s.level, s.seed])
    if (this.quakeEvCache?.key !== key) {
      const ev = quakeEventFrom(s)
      const az = quakeAzimuth(ev, new Rng((s.seed ^ 0x5bd1e995) >>> 0).float(0, Math.PI * 2))
      this.quakeEvCache = { key, ev: withGeometry({ ...ev, az }) }
    }
    return this.quakeEvCache.ev
  }

  setShowWorld(v) {
    this.world.setShowWorld(v)
    try {
      localStorage.setItem('metrorisk.showWorld', v ? '1' : '0')
    } catch {
      /* not persisted */
    }
    this.emit()
  }

  get level() {
    return this.settings.disaster === 'quake' ? this.quakeEvent() : this.typhoonScenario()
  }

  typhoonScenario() {
    const s = this.settings
    const key = JSON.stringify([s.typhoon, s.level, s.coast])
    if (this.typhoonCache?.key !== key) {
      const sc = typhoonScenarioFrom(s)
      // the hourly timeline stays out: the scenario goes into every UI snapshot
      const storm = buildStorm(sc)
      const forecast = forecastSummary(storm)
      forecast.hazards = hazardForecast(storm, forecast.startH, forecast.endH)
      delete forecast.timeline
      if (forecast.sea) forecast.sea = { ...forecast.sea, timeline: undefined }
      this.typhoonCache = { key, sc: { ...sc, forecast } }
    }
    return this.typhoonCache.sc
  }

  notify(text, kind = 'info') {
    this.notice = { text, kind, t: performance.now() }
    this.emit()
  }

  setTool(t) {
    this.tool = t
    this.world.setHighlight(null)
    this.applyColorMode()
    this.emit()
  }

  select(id) {
    this.selected = id
    this.emit()
  }

  toggleOverlay() {
    // during a typhoon the overlay is the flood depth lens
    if (this.impact && (this.phase === 'sim' || this.phase === 'results')) return this.setLens(this.lens === 'flood' ? 'city' : 'flood')
    this.overlay = !this.overlay
    this.applyColorMode()
    this.emit()
  }

  remaining() {
    return this.budget - this.spent
  }

  pay(cost, what) {
    if (cost > this.remaining() + 1e-9) {
      this.notify(`Not enough budget for ${what} (${cost.toFixed(2)} $M needed).`, 'bad')
      return false
    }
    this.spent += cost
    this.actions[what] = (this.actions[what] || 0) + 1
    this.spentBy[what] = (this.spentBy[what] || 0) + cost
    return true
  }

  // ---------------------------------------------------------------- input
  bindInput() {
    const el = this.world.renderer.domElement
    this.abort = new AbortController()
    const signal = this.abort.signal
    let down = null
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, button: e.button }
      if (this.phase === 'prepare' && PAINT_TOOLS.includes(this.tool) && e.button === 0) {
        // keep the camera controls from seeing this drag
        e.stopImmediatePropagation()
        this.painting = true
        this.lastPaint = null
        this.world.controls.enabled = false
        this.paintLevee(e)
      }
    }, { signal, capture: true })
    el.addEventListener('pointermove', (e) => {
      if (this.phase !== 'prepare' && this.phase !== 'sim') return
      if (this.painting) {
        e.stopImmediatePropagation()
        this.paintLevee(e)
      }
      this.updateHover(e)
    }, { signal, capture: true })
    window.addEventListener('pointerup', (e) => {
      if (this.painting) {
        this.painting = false
        this.world.controls.enabled = true
        this.emit()
        down = null
        return
      }
      if (!down || e.target !== el) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      if (moved < 6 && down.button === 0) this.click(e)
      down = null
    }, { signal })
    el.addEventListener('pointerleave', () => {
      this.hover = null
      this.world.setHighlight(null)
    }, { signal })
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.key === 'Escape') this.setTool('inspect')
      // L switches the flood depth lens on and off during a typhoon
      if ((e.key === 'l' || e.key === 'L') && this.impact && (this.phase === 'sim' || this.phase === 'results')) this.toggleOverlay()
      if (e.key === ' ' && this.phase === 'sim') {
        e.preventDefault()
        this.togglePause()
      }
    }, { signal })
  }

  footprint(tool, i, j) {
    const T = TOOLS.find((t) => t.key === tool)
    const [w, d] = T?.size ?? [1, 1]
    return { x: i - Math.floor(w / 2), y: j - Math.floor(d / 2), w, d }
  }

  areaFree(x, y, w, d, { allowPark = true, allowRoad = false } = {}) {
    const { city } = this
    if (x < 1 || y < 1 || x + w > GRID - 1 || y + d > GRID - 1) return false
    for (let j = y; j < y + d; j++)
      for (let i = x; i < x + w; i++) {
        const k = idx(i, j)
        const t = city.cellType[k]
        if (city.buildingAt[k] >= 0 || city.levee[k] > 0 || city.bridge[k]) return false
        if (city.pumps.some((p) => p.i === i && p.j === j)) return false
        if (t === CELL_GRASS) continue
        if (t === CELL_PARK && allowPark) continue
        if (t === CELL_ROAD && allowRoad) continue
        return false
      }
    return true
  }

  toolCost(tool, b, fp) {
    const P = CITY_TYPES[this.city.type]
    switch (tool) {
      case 'demolish':
        return b ? (b.area * COSTS.demolishM2) / 1e6 : 0
      case 'retrofit':
        return b ? (b.area * COSTS.retrofitM2) / 1e6 : 0
      case 'isolate':
        return b ? (b.area * COSTS.isolateM2) / 1e6 : 0
      case 'softstorey':
        return b ? (b.fw * b.fd * COSTS.softStoreyM2) / 1e6 : 0
      case 'anchor':
        return b ? (2 * (b.fw + b.fd) * b.height * COSTS.anchorM2) / 1e6 : 0
      case 'elevate':
        return b ? (b.fw * b.fd * COSTS.elevateM2) / 1e6 : 0
      case 'straps':
        return b ? (b.fw * b.fd * COSTS.strapsM2) / 1e6 : 0
      case 'fixings':
        return b ? (b.fw * b.fd * COSTS.fixingsM2) / 1e6 : 0
      case 'shutters':
        // the facade up to ~10 storeys; above that the glazing is engineered curtain wall anyway
        return b ? (2 * (b.fw + b.fd) * Math.min(b.height, 30) * COSTS.shuttersM2) / 1e6 : 0
      case 'rod':
        return b ? COSTS.rod * (b.height > 40 ? 3 : 1) : 0
      case 'levee':
        return (COSTS.leveeCell * this.leveeHeight) / LEVEE_HEIGHT
      case 'seawall':
        return COSTS.seawallCell
      case 'mangrove':
        return COSTS.mangroveCell
      case 'rivergate':
        return COSTS.riverGate
      case 'pump':
        return COSTS.pump
      case 'bigpump':
        return COSTS.bigPump
      case 'pond':
        return COSTS.pond
      case 'park':
        return COSTS.park
      default: {
        if (!NEW_BUILD[tool] || !fp) return 0
        const T = BUILDING_TYPES[NEW_BUILD[tool].type ?? tool]
        let floors = NEW_BUILD[tool].floors
        if (tool === 'apartment' && P.key === 'rural') floors = 3
        const area = (fp.w * 10 - 5) * (fp.d * 10 - 5) * floors
        return (area * T.costM2 * (NEW_BUILD[tool].premium ?? 1)) / 1e6
      }
    }
  }

  checkTool(tool, b) {
    if (!b) return 'Select a building'
    if (tool === 'retrofit') {
      const next = CONSTRUCTION[b.construction].next
      if (!next) return 'Already built to a high seismic code'
      return null
    }
    if (tool === 'isolate') {
      if (b.construction === 'isolated') return 'Already base-isolated'
      if (b.floors < 2) return 'Single-storey buildings gain little from isolation'
      if (b.floors > 40) return 'Too tall for isolation retrofit'
      return null
    }
    if (tool === 'softstorey') {
      if (b.softFixed) return 'Ground floor already braced'
      if (!b.openFront) return 'No open shopfront ground floor to brace'
      if (!softStoreyOf(b)) return 'Built to a modern code: the ground floor is already designed for it'
      return null
    }
    if (tool === 'anchor') {
      if (b.facadeAnchored) return 'Facade already anchored'
      if (!sheddingFacade(b)) return 'Low-rise without masonry parapets: little to fall off'
      return null
    }
    if (tool === 'elevate') {
      if (b.elevated) return 'Already elevated'
      if (b.floors > 3) return 'Only low-rise buildings (≤3 floors) can be raised'
      return null
    }
    if (tool === 'straps') {
      if (b.straps) return 'Roof already strapped'
      if (roofOf(b) === 'slab') return 'Concrete roof slab: nothing to strap down'
      return null
    }
    if (tool === 'fixings') {
      if (b.fixings) return 'Roof sheets already fixed'
      if (roofOf(b) === 'slab') return 'Concrete roof slab: no sheets to fix'
      return null
    }
    if (tool === 'shutters') {
      if (b.shutters) return 'Already has shutters'
      if (BUILDING_TYPES[b.type].windows === 0) return 'No windows to protect'
      return null
    }
    if (tool === 'rod') return b.rod ? 'Already has a lightning rod' : null
    return null
  }

  /** Can a painting tool go on cell (i, j)? Returns null if so, else why not. */
  paintCheck(tool, i, j) {
    const { city } = this
    const k = idx(i, j)
    if (city.buildingAt[k] >= 0 || city.bridge[k] || city.pumps.some((q) => q.i === i && q.j === j)) return 'Blocked'
    if (tool === 'mangrove') {
      if (city.mangrove?.[k]) return 'Already planted'
      const coast = city.coast
      const deep = coast ? coast.msl - city.z[k] : 0
      // in the shallows off the beach, out of the river's channel
      if (!coast || !city.sea[k] || deep > 2.5) return 'Mangroves grow in the shallows off the beach'
      if (Math.abs(i + 0.5 - city.riverCenter[j]) < RIVER_HALF_WIDTH + 1) return 'Keep the river mouth open'
      return null
    }
    if (city.levee[k] > 0 || city.cellType[k] === CELL_RIVER) return 'Blocked'
    if (tool === 'seawall') {
      if (!city.coast || city.coast.shore[i] - (j + 0.5) > 12) return 'A sea wall goes along the shore'
      return null
    }
    return null
  }

  updateHover(e) {
    const p = this.world.pick(e.clientX, e.clientY)
    if (!p) {
      this.hover = null
      this.world.setHighlight(null)
      return
    }
    const { city } = this
    const tool = this.phase === 'sim' ? 'inspect' : this.tool
    const bid = city.buildingAt[idx(p.i, p.j)]
    const b = p.building ?? (bid >= 0 ? city.byId.get(bid) : null)
    let hl = null
    let cost = 0
    let reason = null
    if (tool === 'inspect' || tool === 'demolish' || BUILDING_TOOLS.includes(tool)) {
      if (b) {
        reason = tool === 'inspect' || tool === 'demolish' ? null : this.checkTool(tool, b)
        cost = this.toolCost(tool, b)
        hl = { x: b.x, y: b.y, w: b.w, d: b.d, h: b.height + b.elevated + 1, base: b.base, color: tool === 'inspect' ? 0x93c5fd : reason ? 0xef4444 : tool === 'demolish' ? 0xf97316 : 0x4ade80 }
      } else if (tool === 'demolish') {
        const k = idx(p.i, p.j)
        if (city.levee[k] > 0 || city.mangrove?.[k] || city.riverGate?.cells.includes(k) || city.pumps.some((q) => q.i === p.i && q.j === p.j)) hl = { x: p.i, y: p.j, w: 1, d: 1, h: 5, color: 0xf97316 }
      }
    } else {
      const fp = this.footprint(tool, p.i, p.j)
      let why
      if (PAINT_TOOLS.includes(tool)) why = this.paintCheck(tool, p.i, p.j)
      else if (tool === 'pump' || tool === 'bigpump') why = this.areaFree(fp.x, fp.y, 1, 1, { allowRoad: true }) ? null : 'Blocked — needs empty land or a road'
      else if (tool === 'rivergate') why = this.gateCheck(p.i, p.j)
      else why = this.areaFree(fp.x, fp.y, fp.w, fp.d) ? null : 'Blocked — needs empty land'
      cost = this.toolCost(tool, null, fp)
      reason = why
      const gate = tool === 'rivergate' && !why ? this.gateCells(p.j) : null
      const hx = gate ? Math.min(...gate.map((q) => q % GRID)) : fp.x
      hl = { ...fp, x: hx, w: gate ? gate.length : fp.w, h: tool === 'levee' ? this.leveeHeight : tool === 'seawall' ? SEAWALL_HEIGHT : tool === 'mangrove' ? 3 : 6, color: why ? 0xef4444 : 0x4ade80 }
    }
    this.world.setHighlight(hl)
    const prev = this.hover
    this.hover = { i: p.i, j: p.j, bid: b?.id ?? null, cost, reason, tool }
    if (!prev || prev.bid !== this.hover.bid || prev.i !== p.i || prev.j !== p.j) this.emit()
  }

  click(e) {
    const p = this.world.pick(e.clientX, e.clientY)
    if (!p) return
    const { city } = this
    const bid = city.buildingAt[idx(p.i, p.j)]
    const b = p.building ?? (bid >= 0 ? city.byId.get(bid) : null)
    if (this.phase === 'sim' || this.phase === 'results' || this.tool === 'inspect') {
      this.selected = b ? b.id : null
      this.emit()
      return
    }
    if (this.phase !== 'prepare') return
    const tool = this.tool
    if (tool === 'demolish') return this.demolish(b, p)
    if (BUILDING_TOOLS.includes(tool)) {
      if (!b) return
      const why = this.checkTool(tool, b)
      if (why) return this.notify(why, 'bad')
      const cost = this.toolCost(tool, b)
      if (!this.pay(cost, tool)) return
      this.applyMeasure(tool, b)
      if (tool === 'elevate') this.world.rebuildStatic()
      this.world.rebuildBuildings()
      this.applyColorMode()
      this.selected = b.id
      this.notify(`${TOOLS.find((t) => t.key === tool).name}: ${BUILDING_TYPES[b.type].name} — ${cost.toFixed(2)} $M`, 'good')
      return
    }
    const fp = this.footprint(tool, p.i, p.j)
    if (PAINT_TOOLS.includes(tool)) return
    if (tool === 'pump' || tool === 'bigpump') {
      if (!this.areaFree(fp.x, fp.y, 1, 1, { allowRoad: true })) return this.notify('A pump needs an empty cell or road.', 'bad')
      if (!this.pay(this.toolCost(tool), tool)) return
      const rate = tool === 'bigpump' ? BIG_PUMP_RATE : 10
      city.pumps.push({ i: fp.x, j: fp.y, rate })
      this.world.rebuildStatic()
      this.notify(`Pump station built (${rate} m³/s)${this.upgrades.pumpGenerators ? ', with a backup generator' : ''}.`, 'good')
      return
    }
    if (tool === 'rivergate') {
      const why = this.gateCheck(p.i, p.j)
      if (why) return this.notify(why, 'bad')
      if (!this.pay(COSTS.riverGate, 'rivergate')) return
      city.riverGate = { j: p.j, cells: this.gateCells(p.j), crest: city.coast.msl + 5 }
      this.world.rebuildStatic()
      this.refreshPreview()
      this.notify('River gate built across the mouth. It shuts while the sea stands above the river.', 'good')
      return
    }
    if (!this.areaFree(fp.x, fp.y, fp.w, fp.d)) return this.notify('That spot is blocked — it needs open land.', 'bad')
    if (tool === 'park' || tool === 'pond') {
      if (!this.pay(this.toolCost(tool), tool)) return
      for (let j = fp.y; j < fp.y + fp.d; j++)
        for (let i = fp.x; i < fp.x + fp.w; i++) {
          const k = idx(i, j)
          if (tool === 'park') {
            city.cellType[k] = CELL_PARK
            city.trees.push({ i, j, ox: Math.random() * 6 - 3, oz: Math.random() * 6 - 3, s: 0.8 + Math.random() * 0.4, kind: 0 })
          } else {
            city.cellType[k] = CELL_POND
            city.z[k] -= POND_DEPTH
          }
        }
      if (tool === 'park') {
        city.parks.push({ ...fp })
        this.world.buildProps()
      }
      if (tool === 'pond') {
        city.ponds.push(fp)
        this.world.updateTerrainHeights()
        this.refreshPreview()
      }
      this.world.paintTerrain()
      this.world.buildTrees()
      this.notify(tool === 'park' ? 'Park created.' : `Retention pond excavated (${(fp.w * fp.d * 100 * POND_DEPTH).toLocaleString()} m³ storage).`, 'good')
      return
    }
    if (NEW_BUILD[tool]) {
      const cost = this.toolCost(tool, null, fp)
      if (!this.pay(cost, tool)) return
      let floors = NEW_BUILD[tool].floors
      if (tool === 'apartment' && city.type === 'rural') floors = 3
      const rng = new Rng(Math.floor(Math.random() * 1e9))
      for (let j = fp.y; j < fp.y + fp.d; j++) for (let i = fp.x; i < fp.x + fp.w; i++) if (city.cellType[idx(i, j)] === CELL_PARK) city.cellType[idx(i, j)] = CELL_GRASS
      const nb = addBuilding(city, rng, { type: NEW_BUILD[tool].type ?? tool, ...fp, floors, construction: NEW_BUILD[tool].construction })
      nb.built = true
      if (tool === 'cycshelter') {
        // raised above the surge, under a concrete roof, shuttered
        Object.assign(nb, { elevated: 3, slabRoof: true, shutters: true, cyclone: true })
        this.world.rebuildStatic()
      }
      if (nb.residents) this.relocated = Math.max(0, this.relocated - nb.residents)
      this.world.paintTerrain()
      this.world.buildTrees()
      this.world.rebuildBuildings()
      this.applyColorMode()
      this.selected = nb.id
      this.notify(`${TOOLS.find((t) => t.key === tool).name} built — ${cost.toFixed(2)} $M`, 'good')
    }
  }

  demolish(b, p) {
    const { city } = this
    const k = idx(p.i, p.j)
    if (!b) {
      if (city.levee[k] > 0) {
        city.levee[k] = 0
        if (city.seawall) city.seawall[k] = 0
        this.world.rebuildStatic()
        this.world.paintTerrain()
        if (this.overlay) this.applyColorMode()
        this.emit()
        return
      }
      if (city.riverGate?.cells.includes(k)) {
        city.riverGate = null
        this.world.rebuildStatic()
        this.refreshPreview()
        this.emit()
        return
      }
      if (city.mangrove?.[k]) {
        city.mangrove[k] = 0
        city.trees = city.trees.filter((t) => idx(t.i, t.j) !== k)
        this.world.paintTerrain()
        this.world.buildTrees()
        this.emit()
        return
      }
      const pi = city.pumps.findIndex((q) => q.i === p.i && q.j === p.j)
      if (pi >= 0) {
        city.pumps.splice(pi, 1)
        this.world.rebuildStatic()
        this.emit()
      }
      return
    }
    const cost = this.toolCost('demolish', b)
    if (!this.pay(cost, 'demolish')) return
    city.buildings = city.buildings.filter((x) => x !== b)
    city.byId.delete(b.id)
    for (let j = b.y; j < b.y + b.d; j++) for (let i = b.x; i < b.x + b.w; i++) city.buildingAt[idx(i, j)] = -1
    this.relocated += b.residents
    if (this.selected === b.id) this.selected = null
    this.world.paintTerrain()
    this.world.rebuildBuildings()
    this.world.rebuildStatic()
    this.applyColorMode()
    this.notify(`Demolished ${BUILDING_TYPES[b.type].name.toLowerCase()}${b.residents ? ` — ${b.residents} residents need new homes` : ''}.`, 'info')
  }

  paintLevee(e) {
    const p = this.world.pick(e.clientX, e.clientY)
    if (!p) return
    // fill every cell between pointer samples so fast drags leave no gaps
    const from = this.lastPaint ?? p
    this.lastPaint = { i: p.i, j: p.j }
    const n = Math.max(Math.abs(p.i - from.i), Math.abs(p.j - from.j))
    for (let s = 0; s <= n && this.painting; s++) {
      const t = n ? s / n : 0
      this.paintLeveeCell(Math.round(from.i + (p.i - from.i) * t), Math.round(from.j + (p.j - from.j) * t))
    }
    if (this.leveePaintDirty) this.world.rebuildStatic()
  }

  /** One cell of a painting tool: a flood wall, a sea wall or mangroves. */
  paintLeveeCell(i, j) {
    const { city, tool } = this
    if (i < 0 || j < 0 || i >= GRID || j >= GRID || this.paintCheck(tool, i, j)) return
    const k = idx(i, j)
    if (!this.pay(this.toolCost(tool), tool)) {
      this.painting = false
      this.world.controls.enabled = true
      return
    }
    if (tool === 'levee') city.levee[k] = this.leveeHeight
    else if (tool === 'seawall') {
      city.levee[k] = SEAWALL_HEIGHT
      ;(city.seawall ??= new Uint8Array(GRID * GRID))[k] = 1
    } else if (tool === 'mangrove') {
      ;(city.mangrove ??= new Uint8Array(GRID * GRID))[k] = 1
      // a few low, dense trees standing in the water
      for (let q = 0; q < 2; q++) city.trees.push({ i, j, ox: Math.random() * 7 - 3.5, oz: Math.random() * 7 - 3.5, s: 0.55 + Math.random() * 0.2, kind: 0, mangrove: true })
    }
    this.leveePaintDirty = true
    this.version++
  }

  /** Flood wall height for the next cells painted (m). */
  setLeveeHeight(h) {
    this.leveeHeight = h
    this.emit()
  }

  /** The river cells across row j (a gate spans the channel bank to bank). */
  gateCells(j) {
    const out = []
    for (let i = 0; i < GRID; i++) {
      const k = idx(i, j)
      if (this.city.cellType[k] === CELL_RIVER && !this.city.sea[k]) out.push(k)
    }
    return out
  }

  /** Can the river gate go across row j? null if so. */
  gateCheck(i, j) {
    const { city } = this
    if (!city.coast) return 'Only a coastal city has a river mouth to gate'
    if (city.riverGate) return 'The river already has a gate (demolish it to move it)'
    const k = idx(i, j)
    if (city.cellType[k] !== CELL_RIVER || city.sea[k]) return 'Click on the river, near its mouth'
    if (city.coast.shoreMean - j > 25) return 'Too far upstream: put it within 250 m of the mouth'
    if (this.gateCells(j).some((q) => city.bridge[q])) return 'There is a bridge here'
    return null
  }

  buyUpgrade(key) {
    const U = UPGRADES[key]
    const lvl = typeof this.upgrades[key] === 'number' ? this.upgrades[key] : this.upgrades[key] ? 1 : 0
    if (U.max ? lvl >= U.max : lvl >= 1) return
    if (U.program) return this.runProgram(key)
    if (key === 'relocation') return this.relocate()
    const cost = U.cost(this.city, lvl)
    if (!this.pay(cost, key)) return
    if (U.max) this.upgrades[key] = lvl + 1
    else this.upgrades[key] = true
    if (key === 'dredge') {
      for (let k = 0; k < GRID * GRID; k++) if (this.city.cellType[k] === CELL_RIVER && !this.city.sea[k]) this.city.z[k] -= 1.5
      this.city.dredged = true
      this.world.updateTerrainHeights()
      this.refreshPreview()
    }
    if (key === 'floodway') {
      this.city.floodway = true
      if (this.overlay) this.applyColorMode()
    }
    this.notify(`${U.name} purchased (${cost.toFixed(1)} $M).`, 'good')
  }

  /** Carry out a city-wide program: the same measures on every building that qualifies. */
  runProgram(key) {
    const U = UPGRADES[key]
    const { targets, cost } = this.programPlan(key)
    if (!targets.length) return this.notify('No buildings need this.')
    if (!this.pay(cost, key)) return
    for (const b of targets) {
      for (const tool of U.program.tools ?? [U.program.tool]) {
        if (this.checkTool(tool, b) !== null) continue
        this.applyMeasure(tool, b)
        if (U.program.full) while (CONSTRUCTION[b.construction].next) this.applyMeasure(tool, b)
      }
    }
    this.upgrades[key] = true
    this.world.rebuildBuildings()
    this.applyColorMode()
    this.notify(`${U.name}: ${targets.length} buildings — ${cost.toFixed(1)} $M.`, 'good')
  }

  upgradeCost(key) {
    const U = UPGRADES[key]
    const lvl = typeof this.upgrades[key] === 'number' ? this.upgrades[key] : this.upgrades[key] ? 1 : 0
    if (U.program) {
      const { cost, targets } = this.programPlan(key)
      return { cost, owned: lvl >= 1, lvl, count: targets.length }
    }
    if (key === 'relocation') {
      const { cost, targets, people } = this.relocationPlan()
      return { cost, owned: lvl >= 1, lvl, count: targets.length, people }
    }
    return { cost: U.cost(this.city, lvl), owned: U.max ? lvl >= U.max : lvl >= 1, lvl }
  }

  /** The buildings a city-wide program would work on, and the city's share of the bill. */
  programPlan(key) {
    const P = UPGRADES[key].program
    const tools = P.tools ?? [P.tool]
    const targets = this.city.buildings.filter((b) => (!P.construction || b.construction === P.construction) && (!P.types || P.types.includes(b.type)) && tools.some((t) => this.checkTool(t, b) === null))
    let cost = 0
    for (const b of targets) {
      for (const t of tools) {
        if (this.checkTool(t, b) !== null) continue
        let steps = 1
        if (P.full) for (let c = CONSTRUCTION[b.construction].next; CONSTRUCTION[c]?.next; c = CONSTRUCTION[c].next) steps++
        cost += this.toolCost(t, b) * steps
      }
    }
    return { targets, cost: cost * P.share }
  }

  /**
   * Danger-zone relocation: the homes the forecast puts under more than 1 m of
   * river or sea water, and what it costs to clear them and resettle families
   * (cached until the city or the scenario changes).
   */
  relocationPlan() {
    const { city } = this
    let walls = 0
    for (let k = 0; k < GRID * GRID; k++) walls += city.levee[k]
    const key = JSON.stringify([this.settings.typhoon, this.settings.level, this.settings.coast, city.buildings.length, walls, !!city.floodway, !!city.dredged, !!city.riverGate])
    if (this.relocCache?.key !== key) {
      const fc = this.riverForecast()
      const sea = city.coast ? Math.round((this.level.forecast.sea?.peak ?? 0) * 10) / 10 : null
      const M = floodMap(city, Math.round(fc.stage * 10) / 10, this.level.forecast.rainTotal, sea)
      const targets = city.buildings.filter((b) => (b.type === 'house' || b.type === 'apartment') && b.residents > 0 && this.waterInside(b, M) > 1)
      let cost = 0
      let people = 0
      for (const b of targets) {
        people += b.residents
        cost += this.toolCost('demolish', b) + (b.residents / 4) * COSTS.relocateHousehold
      }
      this.relocCache = { key, plan: { targets, cost, people } }
    }
    return this.relocCache.plan
  }

  relocate() {
    const { targets, cost, people } = this.relocationPlan()
    if (!targets.length) return this.notify('No homes are in the danger zone.')
    if (!this.pay(cost, 'relocation')) return
    const { city } = this
    for (const b of targets) {
      city.buildings = city.buildings.filter((x) => x !== b)
      city.byId.delete(b.id)
      for (let j = b.y; j < b.y + b.d; j++) for (let i = b.x; i < b.x + b.w; i++) city.buildingAt[idx(i, j)] = -1
    }
    this.relocated += people
    city.resettled = (city.resettled ?? 0) + people
    this.upgrades.relocation = true
    this.relocCache = null
    if (this.selected != null && !city.byId.get(this.selected)) this.selected = null
    this.world.paintTerrain()
    this.world.rebuildBuildings()
    this.world.rebuildStatic()
    this.applyColorMode()
    this.notify(`${targets.length} homes cleared from the danger zone: ${people.toLocaleString()} people to resettle. Build new housing on safe ground for them.`, 'good')
  }

  /** Apply one building measure (a tool, or a city-wide program doing the same job). */
  applyMeasure(tool, b) {
    if (tool === 'retrofit') {
      b.origConstruction ??= b.construction
      b.construction = CONSTRUCTION[b.construction].next
      b.softFixed ||= 'retrofit' // a full retrofit braces the ground floor too
    }
    if (tool === 'isolate') {
      b.origConstruction ??= b.construction
      b.construction = 'isolated'
    }
    if (tool === 'softstorey') b.softFixed = 'brace'
    if (tool === 'anchor') b.facadeAnchored = true
    if (tool === 'elevate') b.elevated = 2
    if (tool === 'straps' || tool === 'fixings' || tool === 'shutters' || tool === 'rod') b[tool] = true
  }

  /** Measures a building has had, for the inspect panel. */
  measuresOf(b) {
    const out = []
    if (b.built) out.push('Newly built to modern code')
    if (b.origConstruction && b.construction !== 'isolated') out.push(`Retrofitted from ${CONSTRUCTION[b.origConstruction].short}`)
    if (b.construction === 'isolated') out.push(b.origConstruction ? `Base-isolated (was ${CONSTRUCTION[b.origConstruction].short})` : 'Base-isolated')
    if (b.softFixed && b.openFront) out.push(b.softFixed === 'brace' ? 'Soft storey braced' : 'Ground floor braced by retrofit')
    if (b.facadeAnchored) out.push('Facade & parapets anchored')
    if (b.cyclone) out.push('Cyclone shelter: raised floor, concrete roof, shutters')
    else if (b.elevated) out.push(`Raised ${b.elevated} m`)
    if (b.straps) out.push('Roof strapped to the walls')
    if (b.fixings) out.push('Roof sheets screwed at every purlin')
    if (b.shutters && !b.cyclone) out.push('Storm shutters (close them in the plan)')
    if (b.rod) out.push('Lightning rod')
    return out
  }

  refreshPreview() {
    this.preview = new FloodSim(this.city)
    this.preview.computeFlow()
    this.world.updateWater(this.preview)
    // where the water can reach has changed
    if (this.overlay) this.applyColorMode()
  }

  // --------------------------------------------------------------- colors
  applyColorMode() {
    const { settings } = this
    // a building tool in hand: show where it can go (green), where it is done (blue), where it can't (grey)
    // the land flood map belongs to the typhoon risk map, flood layer, before the storm
    const landMap = this.phase === 'prepare' && this.overlay && settings?.disaster === 'typhoon' && this.riskLayer === 'flood'
    this.floodMapData = landMap ? this.computeFloodMap() : null
    if (this.phase === 'prepare') this.world.setFloodMap(this.floodMapData)
    if (this.phase === 'prepare' && BUILDING_TOOLS.includes(this.tool)) {
      const tool = this.tool
      this.world.setColorFn((b) => (this.checkTool(tool, b) === null ? '#22c55e' : hasMeasure(tool, b) ? '#38bdf8' : '#3b4252'))
      return
    }
    if (!this.overlay || !settings) {
      this.world.setColorFn(null)
      return
    }
    if (this.phase === 'prepare') {
      if (settings.disaster === 'quake') {
        this.world.setColorFn((b) => {
          const r = this.quakeRisk(b)
          return heat(r.pComplete * 0.6 + r.pCollapse * 3)
        })
      } else if (landMap) {
        // the city greyed out; buildings the water gets into in the same colours as the land
        const M = this.floodMapData
        this.world.setColorFn((b) => {
          const c = depthColor(this.waterInside(b, M))
          return c ? `rgb(${c.join(',')})` : LENS_GREY
        })
      } else {
        // wind layer: the roof or structure the forecast gusts can take
        const gust = this.level.forecast.peakGust
        this.world.setColorFn((b) => {
          const w = windRisk(b, gust)
          return heat(Math.max(w.pCollapse, w.pRoof * 0.7, w.pGlass * 0.3))
        })
      }
    } else if (this.quake) {
      this.world.setColorFn((b) => {
        const s = this.quake.st.get(b.id)
        if (!s) return null
        if (s.burning) return '#7c2d12'
        if (s.collapsed || s.burnt) return '#7f1d1d'
        // structural integrity: green intact → red nearly used up
        return heat(Math.max(s.D / 0.9, s.ds >= 3 ? 0.6 : 0))
      })
    } else if (this.impact) {
      const im = this.impact
      const W = this.windDmg
      if (this.lens === 'flood') {
        // grey city; water inside a building in the depth colours
        this.world.setColorFn((b) => {
          const s = im.st.get(b.id)
          if (!s) return LENS_GREY
          if (s.collapsed) return '#5b1a1a'
          const c = depthColor(s.dIn)
          return c ? `rgb(${c.join(',')})` : LENS_GREY
        })
      } else if (this.lens === 'power') {
        this.world.setColorFn((b) => {
          if (im.st.get(b.id)?.collapsed) return '#5b1a1a'
          if (b.type === 'hospital' || b.type === 'fire') return '#34d399' // on their own generators
          return W?.powered(b.x, b.y) ? '#facc15' : '#334155'
        })
      } else {
        // damage: the worse of flood damage and what the wind did
        this.world.setColorFn((b) => {
          const s = im.st.get(b.id)
          if (!s) return null
          if (s.collapsed) return '#7f1d1d'
          const w = W?.st.get(b.id)
          const wind = !w ? 0 : w.roof ? 0.75 : w.cover ? 0.45 : w.glass ? 0.25 : 0
          return heat(Math.max(clamp(s.maxIn / 2.5, 0, 1), wind))
        })
      }
    }
  }

  /** Lens on the city during a typhoon: 'city' (plain), 'flood' (depth), 'damage', 'power'. */
  setLens(lens) {
    this.lens = lens
    this.overlay = lens !== 'city'
    this.lensT = -1
    this.applyColorMode()
    this.updateLens(0)
    this.emit()
  }

  /** Repaint the live depth layer and name tags, and recount the lens numbers (a few times a second). */
  updateLens(dt) {
    if (!this.flood || (this.phase !== 'sim' && this.phase !== 'results')) return
    this.lensT -= dt
    if (this.lensT > 0) return
    this.lensT = 0.3
    const f = this.flood
    const { city } = this
    this.world.setFloodMap(this.lens === 'flood' ? { depth: f.h, zg: f.zg } : null)
    this.world.setLabels(this.lens === 'city' ? [] : this.facilityLabels())
    let land = 0
    let wet = 0
    let deep = 0
    let roads = 0
    let roadsCut = 0
    for (let k = 0; k < GRID * GRID; k++) {
      if (city.cellType[k] === CELL_RIVER) continue
      land++
      const h = f.h[k]
      if (h > 0.1) wet++
      if (h > 0.6) deep++
      if (city.cellType[k] === CELL_ROAD) {
        roads++
        if (h > 0.3) roadsCut++
      }
    }
    let cutOff = 0
    for (const b of city.buildings) {
      const s = this.impact.st.get(b.id)
      if (s && !s.collapsed && s.dOut > 0.5) cutOff += s.present
    }
    this.lensStats = { flooded: wet / land, deep: deep / land, roadsCut: roads ? roadsCut / roads : 0, cutOff, noPower: 1 - (this.windDmg?.poweredShare() ?? 1) }
  }

  /** Tags for the places a city needs in a flood, with how they are doing. */
  facilityLabels() {
    const KINDS = { hospital: ['Hospital', '#10b981'], fire: ['Fire station', '#f97316'], shelter: ['Shelter', '#14b8a6'], school: ['School', '#3b82f6'], civic: ['City hall', '#8b5cf6'] }
    const count = {}
    const out = []
    for (const b of this.city.buildings) {
      const K = KINDS[b.type]
      const s = K && this.impact.st.get(b.id)
      if (!s) continue
      const n = (count[b.type] = (count[b.type] || 0) + 1)
      let badge = 'Dry'
      let tone = 'good'
      if (s.collapsed) [badge, tone] = ['Destroyed', 'bad']
      else if (s.dIn > 0.05) [badge, tone] = [`Flooded ${s.dIn.toFixed(1)} m`, 'bad']
      else if (s.dOut > 0.1) [badge, tone] = [`Cut off · ${s.dOut.toFixed(1)} m outside`, 'warn']
      else if (this.windDmg?.st.get(b.id)?.roof) [badge, tone] = ['Roof torn off', 'warn']
      if (b.type === 'hospital' && s.offline && !s.collapsed) badge += ' · closed'
      out.push({ key: `b${b.id}`, x: b.cx, y: b.base + b.elevated + b.height + 3, z: b.cz, name: `${K[0]} #${n}`, dot: K[1], badge, tone })
    }
    this.flood.pumps.forEach((p, q) => {
      const x = cellToWorld(p.i)
      const z = cellToWorld(p.j)
      const [badge, tone] = p.failed ? ['Flooded · stopped', 'bad'] : p.unpowered ? ['No power · stopped', 'bad'] : ['Pumping', 'good']
      out.push({ key: `p${q}`, x, y: this.world.groundAt(x, z) + 6, z, name: `Pump station #${q + 1}`, dot: '#0ea5e9', badge, tone })
    })
    return out
  }

  /** Forecast peak of the river for this scenario (cached until the scenario or the channel changes). */
  riverForecast() {
    const key = JSON.stringify([this.settings.typhoon, this.settings.level, this.settings.coast, !!this.city.dredged, !!this.city.floodway])
    if (this.riverFcCache?.key !== key) {
      const fc = this.level.forecast
      const r = forecastRiverPeak(buildStorm(this.level), catchmentRain, fc.startH, fc.endH + 12, { dredged: this.city.dredged, floodway: this.city.floodway })
      this.riverFcCache = { key, r }
    }
    return this.riverFcCache.r
  }

  /** The land flood map at the chosen river level (the forecast peak unless the player set one). */
  computeFloodMap() {
    const fc = this.riverForecast()
    const level = this.floodLevel ?? Math.round(fc.stage * 10) / 10
    // on the coast, the sea at its forecast peak (surge + tide) unless the player set one
    const seaFc = this.level.forecast.sea
    const sea = this.city.coast ? (this.seaLevelMap ?? Math.round((seaFc?.peak ?? 0) * 10) / 10) : null
    const M = floodMap(this.city, level, this.level.forecast.rainTotal, sea)
    let wet = 0
    let people = 0
    for (const b of this.city.buildings) {
      if (b.removed || this.waterInside(b, M) <= 0.05) continue
      wet++
      people += occupancyAt(b, this.settings.startHour)
    }
    return { ...M, forecast: fc, auto: this.floodLevel == null, buildingsWet: wet, peopleWet: people }
  }

  /** Water (m) standing above b's ground floor on a flood map. */
  waterInside(b, M) {
    let w = -Infinity
    for (let j = b.y; j < b.y + b.d; j++)
      for (let i = b.x; i < b.x + b.w; i++) {
        const k = idx(i, j)
        if (M.depth[k] > 0) w = Math.max(w, this.city.z[k] + M.depth[k])
      }
    return w - (b.floorZ + b.elevated)
  }

  /** Risk map layer for a typhoon: 'flood' (land and buildings) or 'wind'. */
  setRiskLayer(layer) {
    this.riskLayer = layer
    if (!this.overlay) this.overlay = true
    this.applyColorMode()
    this.emit()
  }

  /** River level for the flood map, m above the banks; null = the forecast peak. */
  setFloodLevel(level) {
    this.floodLevel = level
    this.applyColorMode()
    this.emit()
  }

  /** Sea level for the flood map of a coastal city, m above mean sea level; null = the forecast peak. */
  setSeaLevelMap(level) {
    this.seaLevelMap = level
    this.applyColorMode()
    this.emit()
  }

  quakeRisk(b) {
    const L = this.quakeEvent()
    const soil = this.city.soil[cellOfBuilding(b)]
    const Tm = groundPeriod(L.M, siteDistances(L.geo, 0, 0).rjb, soil, L.freq)
    const p = demand(b, soil, L.M, rockPgaAt(L, b.cx, b.cz), Tm)
    const med = mediansFor(b, L.M, 0)
    const probs = damageProbs(p, med)
    const sh = shapeOf(b)
    return { pga: p, soil, probs, pComplete: probs[3], pExtensive: probs[2], pCollapse: probs[3] * collapseProb(b, p, med), slender: sh.slender, shapeCap: sh.cap, T: buildingPeriod(b), Tm, res: resonance(b, Tm) }
  }

  // ----------------------------------------------------------- simulation
  startSimulation() {
    const { city, settings } = this
    this.prepSnapshot = {
      city: structuredClone(city),
      budget: this.budget,
      spent: this.spent,
      upgrades: { ...this.upgrades },
      relocated: this.relocated,
      actions: { ...this.actions },
      spentBy: { ...this.spentBy },
    }
    this.phase = 'sim'
    this.tool = 'inspect'
    this.paused = false
    this.speedIdx = settings.disaster === 'quake' ? 0 : 1
    this.simTime = 0
    this.acc = 0
    this.showDamage = []
    this.panicLog = null
    this.groundShowAt = 0
    this.log = []
    this.world.setHighlight(null)
    this.rng = new Rng((settings.seed ^ 0x5bd1e995) >>> 0)
    const stats = cityStats(city, settings.startHour)
    if (settings.disaster === 'typhoon') {
      // the "without" runs of the after-action report start from copies taken before the storm touches the city
      this.realSummary = null
      this.startShadows()
      const w = this.world
      const fx = {
        groundAt: (x, z) => w.groundAt(x, z),
        lamps: () => w.life.lamps,
        life: w.life,
        lightning: (x, y, z) => w.lightning(x, y, z),
        treesDown: () => (w.treesDirty = true),
        windChanged: () => this.syncWind(),
        tornado: (t) => {
          // slow down to watch it: a tornado crosses the city in a few minutes
          if (this.speedIdx > 0) {
            this.speedIdx = 0
            this.pushLog(t, 'Slowing the clock to 1 min/s so you can follow the tornado.', 'info')
          }
        },
      }
      const run = (this.run = new StormRun(city, this.level, { startHour: settings.startHour, seed: settings.seed, upgrades: this.upgrades, plan: this.plan, fx }))
      this.rng = run.rng
      this.typhoon = run.typhoon
      this.flood = run.flood
      this.impact = run.impact
      this.windDmg = run.windDmg
      this.hazards = run.hazards
      this.tyFire = run.tyFire
      this.gateShut = false
      this.population = run.population
      this.drainTyphoonLog()
    } else {
      // the scenario may put the whole district on one kind of ground (the prepared city is restored on retry)
      const SOILS = { rock: 0, stiff: 1, sand: 2 }
      if (SOILS[this.level.soil] !== undefined) {
        city.soil.fill(SOILS[this.level.soil])
        this.world.subsurface.build(city)
        this.world.subsurface.setQuake(this.world.subsurface.quake)
      }
      this.quake = new QuakeSim(city, this.level, { warning: this.upgrades.quakeWarning, gasShutoff: this.upgrades.gasShutoff, startHour: settings.startHour, rng: this.rng })
      // the same earthquake, run unseen on the city as it was generated: the "without preparations" in the results
      this.shadow = null
      if (this.baselineCity) {
        const base = structuredClone(this.baselineCity)
        if (SOILS[this.level.soil] !== undefined) base.soil.fill(SOILS[this.level.soil])
        this.shadow = new QuakeSim(base, this.level, { startHour: settings.startHour, rng: new Rng((settings.seed ^ 0x5bd1e995) >>> 0) })
      }
      this.population = this.quake.population
      this.pushLog(0, `A normal day in ${city.name}. ${stats.present.toLocaleString()} people are in the district…`, 'info')
    }
    // people on the streets and in cars are part of the population too
    this.world.life.buildFields()
    this.world.life.stats = { pedDead: 0, carDead: 0, carsCrushed: 0, swept: 0 }
    this.population += this.world.life.outdoorCount()
    this.streetLog = 0
    this.applyColorMode()
    this.emit()
  }

  pushLog(t, text, level) {
    this.log.push({ t, text, level })
    if (this.log.length > 200) this.log.shift()
  }

  setSpeed(i) {
    this.speedIdx = i
    this.paused = false
    this.emit()
  }

  togglePause() {
    this.paused = !this.paused
    this.emit()
  }

  frame(dt) {
    const w = this.world
    if (this.leveePaintDirty && !this.painting) {
      this.leveePaintDirty = false
      w.paintTerrain()
      w.buildTrees()
      if (this.overlay && this.phase === 'prepare') this.applyColorMode()
    }
    if (this.phase === 'sim' && !this.paused) {
      const want = dt * SPEEDS[this.speedIdx].mult
      if (this.flood) this.stepFlood(want)
      else if (this.quake) this.stepQuake(want)
      this.uiTimer = (this.uiTimer || 0) + dt
      if (this.uiTimer > 0.25) {
        this.uiTimer = 0
        this.emit()
      }
    }
    // the report's comparison is still catching up: show its progress
    if (this.phase === 'results' && this.shadows) {
      this.uiTimer = (this.uiTimer || 0) + dt
      if (this.uiTimer > 0.5) {
        this.uiTimer = 0
        this.emit()
      }
    }
    this.updateLens(dt)
    if (this.phase === 'sim' || this.phase === 'results') {
      const hour = this.settings.startHour + this.simTime / 3600
      const live = this.phase === 'sim' && this.typhoon
      const rain = live ? this.flood.rain : 0
      // the storm's wind, in world axes (x east, z south): it slants the rain
      const wind = live ? [this.typhoon.now.dir[0] * this.typhoon.now.wind, -this.typhoon.now.dir[1] * this.typhoon.now.wind] : [0, 0]
      let haze = 0
      if (this.quake?.mainDone) haze = clamp(this.quake.shocks[0].pga * 0.8, 0, 0.45) * Math.exp(-(this.simTime - this.quake.mainTime) / 7200)
      // the cloud shield spreads ~500 km from the centre; in the eye it opens to the sky
      const ty = this.typhoon?.now
      const cloud = live ? smoothstep(560, 180, ty.dist) * (ty.eye ? 0.25 : 1) : 0
      w.setEnvironment({ hour, rain, haze, wind, cloud })
      if (this.hazards) this.stormVisuals(live)
    }
    w.setLifeContext(this.lifeContext())
    // paused: freeze every moving thing (traffic, people, debris, fire, water, shaking)
    w.update(dt, this.phase === 'sim' && this.paused)
  }

  /**
   * The tornado on the ground, flashes in the clouds, and bolts striking the
   * land around the district (seen, not simulated: strikes in the district
   * come from StormHazards). At most a few per second, whatever the speed.
   */
  stormVisuals(live) {
    const H = this.hazards
    const w = this.world
    const pos = live ? H.tornadoAt(this.simTime) : null
    w.setTornado(pos && H.tornado ? { T: H.tornado, x: pos.x, z: pos.z } : null)
    const simDt = Math.max(0, this.simTime - (this.fxSimT ?? this.simTime))
    this.fxSimT = this.simTime
    if (!live || !H.rate) return
    // all flashes within ~10 km, and ground strikes 0.6–2 km out (~11 km²)
    if (Math.random() < Math.min(0.08, H.rate * 314 * (simDt / 3600))) w.lightning()
    if (Math.random() < Math.min(0.02, H.rate * CG_SHARE * 11 * (simDt / 3600))) {
      const a = Math.random() * Math.PI * 2
      const r = 650 + Math.random() * 1300
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      w.lightning(x, w.groundAt(x, z), z)
    }
  }

  /** Set when a plan action is taken (a PLAN_TRIGGERS key). */
  setPlan(action, trigger) {
    this.plan = { ...this.plan, [action]: trigger }
    this.emit()
  }

  /** Replace the plan with the suggested one, or reset to doing nothing until the streets flood. */
  usePlan(which) {
    this.plan = { ...(which === 'suggested' ? SUGGESTED_PLAN : DEFAULT_PLAN) }
    this.emit()
  }

  /** Draw the fires the storm has started: flames, and the charred trees left behind. */
  drawTyFire() {
    const st = this.impact.st
    const F = this.tyFire
    const w = this.world
    const burning = []
    for (const b of w.bList) {
      const s = st.get(b.id)
      const a = w.animFor(b)
      a.burning = s?.burning ? Math.max(0.05, s.fireI ?? 0) : 0
      a.burnt = !!s?.burnt
      if (s?.burning) burning.push(b)
    }
    w.burning = burning
    w.burningTrees = F.burningTrees()
    if (F.treesDirty) {
      F.treesDirty = false
      w.buildTrees()
    }
  }

  /** What the city's cars and pedestrians need to know about the disaster. */
  lifeContext() {
    const sim = this.flood || this.preview
    const city = this.city
    const ctx = { quake: false, quakeT: 0, flood: false, warned: false, rain: 0 }
    if (sim && city) {
      ctx.depthAt = (k) => {
        const h = sim.h[k]
        if (!city.bridge[k]) return h
        const j = Math.floor(k / GRID)
        const deck = this.world.deckAt(((k % GRID) + 0.5) * 10 - 500, (j + 0.5) * 10 - 500) ?? city.bankZ[j] + 0.7
        return Math.max(0, sim.zg[k] + h - deck)
      }
      ctx.flowAt = (i, j) => sim.flowAt(i, j)
    }
    if (this.phase !== 'sim' && this.phase !== 'results') return ctx
    if (this.quake?.mainDone) {
      ctx.quake = true
      ctx.quakeT = this.quake.time - this.quake.mainTime
    }
    if (this.flood) {
      ctx.flood = true
      // in a gale people get off the streets whether or not anyone told them to
      ctx.warned = this.impact.warned || (this.typhoon?.now.kmh10 ?? 0) >= 62
      ctx.rain = this.flood.rain
    }
    return ctx
  }

  /** Falling debris hit something in the street. */
  streetHit(hit) {
    if (this.phase !== 'sim') return
    this.streetLog = (this.streetLog || 0) + 1
    if (this.streetLog > 12) return
    const parts = []
    if (hit.crushed) parts.push(`crushed ${hit.crushed} car${hit.crushed > 1 ? 's' : ''}`)
    if (hit.killed) parts.push(`killed ${hit.killed} ${hit.killed > 1 ? 'people' : 'person'} in the street`)
    this.pushLog(this.simTime, `Falling debris ${parts.join(' and ')}.`, 'bad')
  }

  /** Debris or a falling tower struck a building. */
  buildingHit(bid, energy) {
    if (this.phase !== 'sim' || !this.quake) return
    const b = this.city.byId.get(bid)
    if (b) this.quake.applyImpact(b, energy)
  }

  stepFlood(want) {
    const f = this.flood
    const run = this.run
    const done = run.advance(want, 12)
    this.physicsLimited = done < want * 0.85
    this.simTime = f.time
    this.shadows?.sync(f.time)
    this.drainTyphoonLog()
    if (run.windTicked) {
      // park lamps, goals and signs stand ~3–5 m up, below the roof-height gust
      const W = this.windDmg.wind
      if (W.gust > 30) this.world.windProps(W.gust * 0.92, W.dir[0], -W.dir[1])
      this.syncWind()
    }
    if (run.fireDirty) {
      run.fireDirty = false
      this.drawTyFire()
    }
    const tick = run.ticked
    this.waterFrame = (this.waterFrame || 0) + 1
    if (this.waterFrame % 2 === 0) {
      f.computeFlow()
      this.world.updateWater(f)
    }
    if (tick) this.syncFlood()
    if (f.gate && f.gateClosed !== this.gateShut) {
      this.gateShut = f.gateClosed
      this.world.gateShut = f.gateClosed
      this.world.rebuildStatic()
      if (f.gateChanges <= 4) this.pushLog(this.simTime, f.gateClosed ? `The river barrier has shut against the surge. Its pumps are lifting river water over it (${GATE_PUMP} m³/s); the rest piles up behind it until the surge passes.` : 'The surge has passed and the river barrier is open: the river is draining to the sea again.', f.gateClosed ? 'warn' : 'info')
    }
  }

  drainTyphoonLog() {
    for (const e of this.typhoon.events.splice(0)) this.pushLog(e.t, e.text, e.level)
    for (const e of this.run.events.splice(0)) this.pushLog(e.t, e.text, e.level)
  }

  /** Show what the wind did: roofs, broken windows, flattened buildings, fallen trees, power cuts. */
  syncWind() {
    const { world, city, windDmg: W } = this
    let colors = false
    let power = false
    for (const e of W.events.splice(0)) {
      if (e.text) this.pushLog(e.t, e.text, e.level)
      else if (e.damage !== undefined) {
        const b = city.byId.get(e.damage)
        if (!b) continue
        world.setDamage(b, e.ds)
        const a = world.animFor(b)
        if (e.roof === 'lost') a.roofLost = true
        else if (e.roof === 'cover') a.roofCover = true
        if (e.roof) this.throwRoof(b, e.roof === 'lost' ? 6 : 3)
        colors = true
      } else if (e.collapse !== undefined) {
        const b = city.byId.get(e.collapse)
        if (b) world.collapse(b, Math.random() * 0.4, 'wind')
        if (b && roofKind(b.type) !== 'slab') this.throwRoof(b, 4)
      } else if (e.tree) world.treesDirty = true
      else if (e.power) power = true
    }
    if (power) {
      for (const b of world.bList) {
        // hospitals and fire stations run on their own generators
        const lit = b.type === 'hospital' || b.type === 'fire' || W.powered(b.x, b.y)
        world.animFor(b).dark = !lit
      }
      // (pumps without generators stop with their feeder: StormRun.powerPumps)
      // street lights and traffic signals go dark with their feeder
      world.life.setPower((x, z) => W.powered(clamp(Math.floor((x + 500) / 10), 0, GRID - 1), clamp(Math.floor((z + 500) / 10), 0, GRID - 1)))
      colors = true
    }
    if (colors) {
      if (this.overlay) this.applyColorMode()
      else world.refreshColors()
    }
  }

  /** Roof sheets and tiles torn off and carried downwind. */
  throwRoof(b, n) {
    const { world } = this
    const [wx, wz] = world.windVec ?? [0, 0]
    const col = b.roofColor ?? '#8a8f94'
    const top = b.base + b.elevated + b.height
    for (let q = 0; q < n; q++) {
      const x = b.cx + (Math.random() - 0.5) * b.fw * 0.8
      const z = b.cz + (Math.random() - 0.5) * b.fd * 0.8
      world.debris.spawn(x, top + 0.5, z, wx * 0.3, 2 + Math.random() * 4, wz * 0.3, 1, col, { dims: [1.2 + Math.random() * 1.2, 0.06, 0.6 + Math.random() * 0.4], windborne: true, src: b.id })
    }
  }

  syncFlood() {
    const { impact, world } = this
    for (const e of impact.events.splice(0)) {
      if (e.collapse !== undefined) {
        const b = this.city.byId.get(e.collapse)
        if (b) world.collapse(b, Math.random() * 0.5, 'flood')
      } else this.pushLog(e.t, e.text, e.level)
    }
    let colors = false
    for (const b of world.bList) {
      const s = impact.st.get(b.id)
      if (!s) continue
      const wet = Math.min(1, s.maxIn / 2.5)
      const a = world.animFor(b)
      if (Math.abs((a.wet || 0) - wet) > 0.05) {
        a.wet = wet
        colors = true
      }
    }
    if (impact.leveeDirty) {
      impact.leveeDirty = false
      world.rebuildStatic()
    }
    const failed = this.flood.pumps.filter((p) => p.failed).length
    if (failed !== this.pumpsFailed) {
      for (const p of this.flood.pumps) {
        const cp = this.city.pumps.find((q) => q.i === p.i && q.j === p.j)
        if (cp) cp.failed = p.failed
      }
      if (failed > (this.pumpsFailed || 0)) this.pushLog(this.flood.time, 'A pump station flooded and shut down.', 'bad')
      this.pumpsFailed = failed
      world.rebuildStatic()
    }
    const stage = this.flood.stage
    if (!this.overtopped && stage > 0) {
      this.overtopped = true
      this.pushLog(this.flood.time, 'The river has burst its banks!', 'bad')
    }
    if (colors) {
      if (this.overlay) this.applyColorMode()
      else world.refreshColors()
    }
  }

  /** Keep the unprepared shadow city's earthquake in step with the real one. */
  stepShadow(t) {
    const sh = this.shadow
    if (!sh) return
    while (sh.time < t) sh.update(60)
    // nobody draws it: drop what the renderer would have read
    sh.events.length = 0
    sh.pending.length = 0
    sh.moved.clear()
  }

  stepQuake(want) {
    const q = this.quake
    this.acc += want
    while (this.acc >= 60) {
      this.acc -= 60
      q.update(60)
      this.stepShadow(q.time)
    }
    this.simTime = q.time + this.acc
    for (const e of q.events.splice(0)) this.pushLog(e.t, e.text, e.level)
    const w = this.world
    const fall = (b, delay) => {
      const s = q.st.get(b.id)
      // a building already leaning on failed ground goes over that way; the world decides how the rest come down
      w.collapse(b, delay, 'quake', s?.toppled ? { lean: s.lean, leanAng: s.leanAng } : { tilt: s?.lean ?? 0, tiltAng: s?.leanAng ?? 0 })
    }
    // The sim resolves a shock instantly, but its shaking reaches the city a
    // little later on screen (in cut-away view only once the S-waves arrive).
    // Damage, tilt, fire and ground failure show when each building is hit.
    const hitAt = (b, t) => {
      const a = w.animFor(b)
      a.hitAt = Math.max(a.hitAt ?? 0, t)
    }
    const shown = (a) => !a.hitAt || w.realTime >= a.hitAt
    for (const v of q.pending.splice(0)) {
      if (v.impact || v.quiet) {
        for (const id of v.collapses) {
          const b = this.city.byId.get(id)
          if (!b) continue
          const d = 0.2 + Math.random() * 0.8
          hitAt(b, w.realTime + d)
          fall(b, d)
        }
        for (const id of v.damaged) {
          const b = this.city.byId.get(id)
          if (b) this.showDamage.push({ b, at: w.realTime + 0.3 })
        }
        continue
      }
      const bridges = (v.bridges || []).map((n) => this.city.bridgeSpans[n])
      if (v.M < 4.2 && !v.collapses.length) {
        // too weak to animate, but any damage it did still shows
        for (const id of v.damaged) {
          const b = this.city.byId.get(id)
          if (b) this.showDamage.push({ b, at: w.realTime })
        }
        for (const sp of bridges) this.showDamage.push({ bridge: sp, at: w.realTime })
        continue
      }
      const dur = clamp(v.main ? 2 + (v.M - 4) * 2.4 : 1 + (v.M - 4) * 1.2, 1, 18)
      const lag = w.addShake(v.pga, dur, v.M, v.main, v.field, v.tm)
      const t0 = w.realTime + lag
      this.groundShowAt = Math.max(this.groundShowAt ?? 0, t0 + dur * 0.4)
      for (const sp of bridges) this.showDamage.push({ bridge: sp, at: t0 + dur * (0.3 + Math.random() * 0.5) })
      for (const id of v.collapses) {
        const b = this.city.byId.get(id)
        if (!b) continue
        const d = lag + Math.random() * dur * 0.75
        hitAt(b, w.realTime + d)
        fall(b, d)
      }
      for (const id of v.damaged) {
        const b = this.city.byId.get(id)
        if (!b) continue
        const at = t0 + Math.random() * dur * 0.6
        hitAt(b, at)
        this.showDamage.push({ b, at })
      }
    }
    // damage states whose shaking has now arrived
    if (this.showDamage.length) {
      let changed = false
      this.showDamage = this.showDamage.filter((d) => {
        if (w.realTime < d.at) return true
        if (d.bridge) {
          w.bridgeDamaged(d.bridge)
          if (d.bridge.ds >= 3) w.life.closeBridge(d.bridge)
          return false
        }
        w.setDamage(d.b, q.st.get(d.b.id)?.ds ?? 0)
        changed = true
        return false
      })
      if (changed) w.refreshColors()
    }
    // foundations settling and tilting on failed ground
    for (const id of q.moved) {
      const b = this.city.byId.get(id)
      const s = q.st.get(id)
      if (!b || !s) continue
      const a = w.animFor(b)
      if (!shown(a)) continue // keep it until the shaking gets there
      a.settle = s.settle
      a.leanTx = s.lean * Math.sin(s.leanAng)
      a.leanTz = -s.lean * Math.cos(s.leanAng)
      a.active = true
      w.updateBuilding(b)
      q.moved.delete(id)
    }
    const G = q.ground
    if ((G.dirtyZ || G.dirtyFx || G.fxQueue.length) && w.realTime >= (this.groundShowAt ?? 0)) {
      // repainting the terrain is costly: at most every half second of real time
      const now = performance.now()
      if (!this.groundT || now - this.groundT > 500) {
        this.groundT = now
        w.updateGround(G)
        // landslide debris cuts the roads it crosses
        for (const sl of G.slides) {
          if (sl.blocked) continue
          sl.blocked = true
          for (const k of [...sl.cells, ...sl.dep.map((d) => d.k)]) if (w.life.road[k]) w.life.block(k)
        }
      }
    }
    this.colorTimer = (this.colorTimer || 0) + 1
    if (this.colorTimer % 20 === 0) {
      const burning = []
      for (const b of w.bList) {
        const s = q.st.get(b.id)
        if (!s) continue
        const a = w.animFor(b)
        // a fire breaks out only once the shaking has reached the building
        const lit = !!s.burning && w.realTime >= (a.hitAt ?? 0) + 1.5
        a.burning = lit ? Math.max(0.05, s.fireI ?? 0) : 0 // how fiercely it is burning right now
        a.burnt = s.burnt && shown(a)
        if (lit) burning.push(b)
      }
      w.burning = burning
      // trees on fire, and the charred ones left behind
      const F = q.fire
      w.burningTrees = w.realTime >= (this.groundShowAt ?? 0) ? F.burningTrees() : []
      if (F.treesDirty) {
        F.treesDirty = false
        w.buildTrees()
      }
      if (this.overlay) this.applyColorMode()
      else w.refreshColors()
      this.logPanic()
    }
  }

  /** Report how the people in the streets are reacting, as it changes. */
  logPanic() {
    const P = this.world.life.panicStats()
    if (P.outside < 10) return
    const st = (this.panicLog ??= { level: 0, abandoned: 0, stopped: false })
    const pct = (n) => Math.round((n / P.outside) * 100)
    const moving = P.fleeing + P.panicking
    let level = 0
    if (P.panicking / P.outside > 0.25) level = 3
    else if (moving / P.outside > 0.3) level = 2
    else if ((P.alarmed + moving) / P.outside > 0.4) level = 1
    if (level > st.level) {
      const text = [
        '',
        `People in the streets stop and brace themselves; ${pct(P.alarmed + moving)}% are frightened.`,
        `Frightened people are leaving the buildings behind for open ground (${pct(moving)}% of those outside).`,
        `Panic in the streets: ${pct(P.panicking)}% of people outside are running blindly${P.fallen ? `, and ${P.fallen} have been knocked off their feet` : ''}.`,
      ][level]
      this.pushLog(this.simTime, text, level >= 3 ? 'bad' : 'warn')
    } else if (st.level >= 2 && level === 0 && moving / P.outside < 0.05) this.pushLog(this.simTime, 'The streets are calming down; people are returning from open ground.', 'info')
    st.level = level === 0 && st.level >= 2 && moving / P.outside >= 0.05 ? st.level : level
    if (P.carsStopped >= Math.max(3, this.world.life.cars.length * 0.25) && !st.stopped) {
      st.stopped = true
      this.pushLog(this.simTime, `Drivers have pulled over and stopped (${P.carsStopped} vehicles with hazard lights on).`, 'warn')
    }
    if (P.carsAbandoned > 0 && P.carsAbandoned >= Math.max(1, st.abandoned * 2)) {
      st.abandoned = P.carsAbandoned
      this.pushLog(this.simTime, `${P.carsAbandoned} car${P.carsAbandoned > 1 ? 's have' : ' has'} been abandoned in the road as people flee on foot.`, 'warn')
    }
  }


  /** Has the player changed how people are warned and moved: the plan, or the warning upgrades? */
  planChanged() {
    return Object.keys(DEFAULT_PLAN).some((k) => this.plan[k] !== DEFAULT_PLAN[k]) || PEOPLE_UPGRADES.some((k) => this.upgrades[k])
  }

  /**
   * The after-action report's "without" runs (stormShadow.js), started with
   * the simulation: the same storm on the city as it was generated, with no
   * upgrades and the default plan; and, when the player both changed the plan
   * and built, the same with only their plan and warning upgrades.
   */
  startShadows() {
    this.stopShadows()
    if (!this.baselineCity || typeof Worker === 'undefined') return
    const planChanged = this.planChanged()
    const works = Object.keys(this.prepSnapshot.spentBy).some((k) => !PEOPLE_UPGRADES.includes(k))
    if (!planChanged && !works) return
    const opts = { startHour: this.settings.startHour, seed: this.settings.seed }
    const jobs = { none: { city: this.baselineCity, level: this.level, opts: { ...opts, upgrades: {}, plan: DEFAULT_PLAN } } }
    if (planChanged && works) {
      const upgrades = Object.fromEntries(PEOPLE_UPGRADES.map((k) => [k, this.upgrades[k]]))
      jobs.plan = { city: this.baselineCity, level: this.level, opts: { ...opts, upgrades, plan: this.plan } }
    }
    this.shadows = new ShadowRuns(jobs)
  }

  stopShadows() {
    this.shadows?.stop()
    this.shadows = null
  }

  endDisaster() {
    if (this.phase !== 'sim') return
    this.phase = 'results'
    this.paused = true
    this.results = this.computeResults()
    this.world.rain.update(0, 0, this.world.controls.target)
    // the typhoon's comparison arrives once the shadow runs have caught up with this one
    const sh = this.shadows
    if (this.run && sh) {
      const t = this.flood.time
      sh.report(t).then((S) => {
        if (this.shadows !== sh || this.phase !== 'results') return
        this.results = { ...this.results, report: this.stormReport(S) }
        this.stopShadows()
        this.emit()
      })
    }
    this.emit()
  }

  /**
   * The typhoon's after-action report (stormReport.js). S: the shadow runs'
   * summaries by name; undefined while they are still running, null if there are none.
   */
  stormReport(S) {
    const snap = this.prepSnapshot
    this.realSummary ??= this.run.summary()
    return typhoonReport({
      real: this.realSummary,
      none: S === undefined ? undefined : (S?.none ?? null),
      plan: S === undefined ? undefined : (S?.plan ?? null),
      outdoorDead: this.world.life.stats.pedDead + this.world.life.stats.carDead,
      spentBy: snap.spentBy,
      spent: snap.spent,
      planChanged: this.planChanged(),
      coast: !!this.city.coast,
      shoreRise: this.typhoon.shoreRise,
    })
  }

  retry(keepPrep) {
    if (keepPrep && this.prepSnapshot) {
      const s = this.prepSnapshot
      this.setupCity(structuredClone(s.city))
      this.budget = s.budget
      this.spent = s.spent
      this.upgrades = { ...s.upgrades }
      this.relocated = s.relocated
      this.actions = { ...s.actions }
      this.spentBy = { ...s.spentBy }
    } else {
      this.newGame(this.settings)
      return
    }
    this.overtopped = false
    this.pumpsFailed = 0
    this.notify('Preparations restored. Adjust and try again.')
  }

  backToMenu() {
    this.phase = 'menu'
    this.world.setFloodMap(null)
    this.world.setLabels([])
    this.stopShadows()
    this.flood = this.quake = this.impact = this.shadow = this.typhoon = this.windDmg = this.hazards = this.tyFire = this.run = null
    this.results = null
    this.loadDemo()
    this.emit()
  }

  // -------------------------------------------------------------- results
  currentTotals() {
    const T = this.impact ? this.impact.totals() : this.quake ? this.quake.totals() : null
    if (T) {
      const L = this.world.life.stats
      T.outdoorDead = L.pedDead + L.carDead
      T.carsCrushed = L.carsCrushed
      T.dead += T.outdoorDead
    }
    return T
  }

  computeResults() {
    const { city, settings } = this
    const T = this.currentTotals()
    const pop = this.population
    const dead = Math.round(T.dead)
    const rate = pop ? dead / pop : 0
    let grade = 'F'
    if (dead === 0) grade = 'A+'
    else if (rate < 0.0001) grade = 'A'
    else if (rate < 0.001) grade = 'B'
    else if (rate < 0.005) grade = 'C'
    else if (rate < 0.02) grade = 'D'
    const lessons = []
    const causes = []
    const L = this.level
    if (this.quake) {
      const q = this.quake
      const c = q.deathsByCause
      causes.push(
        { label: 'Building collapse', value: c.collapse },
        { label: 'Structural damage', value: c.damage },
        { label: 'Trapped, not rescued in time', value: c.trapped },
        { label: 'Untreated injuries', value: c.injuries },
        { label: 'Fire', value: c.fire },
        { label: 'Hit by debris outdoors', value: T.outdoorDead - (this.world.life.stats.bridgeDead || 0) },
        { label: 'Bridge collapse', value: this.world.life.stats.bridgeDead || 0 },
      )
      const cls = Object.entries(q.deathsByClass).sort((a, b) => b[1] - a[1])
      if (cls.length && cls[0][1] >= 1)
        lessons.push(`${Math.round((cls[0][1] / Math.max(1, T.dead)) * 100)}% of deaths were in ${CONSTRUCTION[cls[0][0]].name.toLowerCase()} buildings. Retrofitting or replacing them gives the biggest reduction.`)
      const softDown = city.buildings.filter((b) => softStoreyOf(b) && q.st.get(b.id)?.collapsed).length
      if (softDown) lessons.push(`${softDown} building${softDown > 1 ? 's' : ''} with an open shopfront ground floor (a soft storey) collapsed. Bracing just that floor costs a fraction of a full retrofit.`)
      const outdoor = T.outdoorDead - (this.world.life.stats.bridgeDead || 0)
      if (outdoor >= 1 && city.buildings.some((b) => sheddingFacade(b) && !b.facadeAnchored))
        lessons.push(`${Math.round(outdoor)} people outdoors were killed by falling debris. Anchoring masonry facades, parapets and glass on busy streets stops most of what falls (New Zealand ordered this after Christchurch 2011).`)
      if (c.trapped >= 1) lessons.push(`${Math.round(c.trapped)} people died trapped under rubble. More fire & rescue stations shorten search-and-rescue times.`)
      if (c.injuries >= 1) lessons.push(`${Math.round(c.injuries)} people died from injuries that weren't treated in time. Hospitals built to high seismic code stay open when they're needed most.`)
      if (c.fire >= 1) lessons.push(`Fires killed ${Math.round(c.fire)} people.${this.upgrades.gasShutoff ? '' : ' Seismic gas shut-off valves prevent most post-quake ignitions.'}`)
      if (!this.upgrades.quakeWarning && dead > 0) lessons.push('An earthquake early-warning system gives people seconds to drop, cover and hold on — cutting deaths and critical injuries.')
      const hosp = city.buildings.filter((b) => b.type === 'hospital')
      const downH = hosp.filter((b) => q.facilityFactor(b) === 0).length
      if (downH) lessons.push(`${downH} of ${hosp.length} hospitals were knocked out of service.`)
      if (q.lateCollapses >= 2) {
        // which buildings wore out: compare slender and squat ones that fell after surviving the main shock
        const late = city.buildings.filter((b) => q.st.get(b.id)?.collapsed && q.st.get(b.id).hits > 1)
        const tall = late.filter((b) => shapeOf(b).slender > 2).length
        lessons.push(
          `${q.lateCollapses} buildings survived the first shaking but collapsed later — worn down by aftershocks, fire or their own weight on damaged columns.${tall > late.length / 2 ? ' Most were tall, slender buildings, which lose strength fastest under repeated shaking.' : ''} Damaged buildings should be inspected and evacuated before the next shock.`,
        )
      }
      const G = q.ground.stats()
      if (G.liquefiedHa >= 0.5) lessons.push(`${G.liquefiedHa.toFixed(1)} ha of sandy riverside ground liquefied${q.leaning ? `, leaving ${q.leaning} building${q.leaning > 1 ? 's' : ''} leaning dangerously` : ''}. Deep foundations or ground improvement keep buildings upright on soft soil.`)
      if (G.slides) lessons.push(`${G.slides} landslide${G.slides > 1 ? 's' : ''} moved about ${(Math.round(G.slideVol / 1000) * 1000).toLocaleString()} m³ of hillside and cut roads. Steep slopes above homes need retaining walls or should be left unbuilt.`)
      if (L.M >= 9.5) lessons.push(`An M${L.M.toFixed(1)} earthquake is beyond what any current engineering can fully withstand. At this level the goal is saving as many lives as possible, not preventing damage.`)
      if (settings.startHour < 6) lessons.push('At night most people are at home — the safety of houses and apartments matters more than offices.')
    } else {
      const im = this.impact
      const c = im.deathsByCause
      causes.push(
        ...(city.coast ? [{ label: 'Storm surge', value: c.surge }] : []),
        { label: 'Drowned indoors', value: c.drowning },
        { label: 'Buildings swept away', value: c.collapse },
        { label: 'Caught while evacuating', value: c.evacuation },
        { label: 'Homes flattened by the wind', value: c.wind },
        { label: 'Roofs torn off, flying glass', value: c.roof },
        { label: 'Outdoors: water, debris', value: T.outdoorDead },
        ...(c.tornado >= 0.5 ? [{ label: 'Tornado', value: c.tornado }] : []),
        ...(c.fire >= 0.5 ? [{ label: 'Fires (lightning)', value: c.fire }] : []),
      )
      const seaPk = this.typhoon.peak.sea
      if (seaPk && seaPk.level >= 0.8) {
        const tide = Math.abs(seaPk.tide) >= 0.2 ? `, on a tide ${seaPk.tide > 0 ? `${seaPk.tide.toFixed(1)} m above` : `${(-seaPk.tide).toFixed(1)} m below`} normal` : ''
        lessons.push(`The sea rose ${seaPk.level.toFixed(1)} m above normal: ${seaPk.surge.toFixed(1)} m of storm surge${tide}. ${seaPk.level > this.typhoon.shoreRise ? 'It came over the beachfront and ran into the streets.' : 'It stayed below the beachfront this time.'}`)
        const other = { high: 'low', low: 'high', rising: 'falling', falling: 'rising' }[this.level.coast.tidePhase]
        if (this.level.coast.tide >= 0.3) lessons.push(`Timing matters: the same storm at ${other} tide would have changed the sea level by up to ${(2 * this.level.coast.tide).toFixed(1)} m. Surge forecasts always add the tide.`)
      }
      if (c.surge >= 1) lessons.push(`${Math.round(c.surge)} people were killed by the storm surge. Surge is the deadliest part of a typhoon (Haiyan, Nargis): the only safe place is out of its reach, so coastal evacuation has to be finished before the wind makes it impossible. Sea walls, mangrove belts and raised homes buy margin.`)
      if (c.drowning >= 1) lessons.push('Most drownings happened in low-rise homes in low-lying areas. Flood walls, elevating homes and earlier evacuation all reduce this.')
      if (c.evacuation >= 1) lessons.push(`${Math.round(c.evacuation)} people died wading through floodwater. ${this.upgrades.floodWarning ? 'Shelters closer to people help.' : 'An early-warning system gets people out before the streets flood.'}`)
      if (this.flood.stageMax > 0) lessons.push(`The river rose ${this.flood.stageMax.toFixed(1)} m above its banks. Continuous flood walls along the river, dredging and upstream storage help — but walls can fail if overtopped.`)
      if (!city.buildings.some((b) => b.type === 'shelter')) lessons.push('There were no evacuation shelters — evacuees had to leave the area on their own, which is slower.')
      const failedP = this.flood.pumps.filter((p) => p.failed).length
      if (failedP) lessons.push(`${failedP} pump station${failedP > 1 ? 's' : ''} flooded and failed. Put pumps on higher ground or protect them with walls.`)
      if (this.flood.cumRain > 0) lessons.push(`${Math.round(this.flood.cumRain)} mm of rain fell on the city in ${(this.simTime / 3600).toFixed(1)} hours, and ~${Math.round(this.flood.cumBasin)} mm on the hills upstream. The river peaks hours after the heaviest rain, as runoff from the catchment arrives.`)
      const P = this.typhoon.peak
      if (P.kmh10 >= 39) lessons.push(`Peak wind in the city: ${Math.round(P.kmh10)} km/h sustained (10-min) from the ${P.from}, gusting ~${Math.round(P.gust * 3.6)} km/h${P.signal ? `; the highest wind signal raised was No. ${P.signal}` : ''}.`)
      const W = this.windDmg
      const S = W.stats
      if (S.roof + S.collapsed > 0) {
        // which kind of building lost its roof or was flattened
        const by = {}
        for (const b of city.buildings) {
          const w = W.st.get(b.id)
          if (w && (w.roof || w.byWind)) by[b.construction] = (by[b.construction] || 0) + 1
        }
        const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0]
        lessons.push(
          `${S.roof} buildings lost their roofs and ${S.collapsed} were flattened; ${Math.round((top[1] / (S.roof + S.collapsed)) * 100)}% of them ${CONSTRUCTION[top[0]].name.toLowerCase()}. Roof-to-wall straps, more nails per sheet and storm shutters are the cheapest fixes; for the weakest homes, getting the family out to a shelter at Signal No. 3 is what saves them.`,
        )
      }
      if (c.wind + c.roof >= 1) lessons.push(`${Math.round(c.wind + c.roof)} people died in buildings that failed in the wind. Most were in light-material homes, as in Haiyan, where the wind and the surge both took the poorest-built homes first.`)
      if (S.glass >= 5) lessons.push(`${S.glass} buildings had windows blown in, many by flying roof sheets from upwind. Once a window goes, the roof is pushed off from inside as well as pulled from outside.`)
      if (S.trees >= 5) lessons.push(`${S.trees} trees came down${S.roads ? `, blocking ${S.roads} road sections` : ''}. Pruning and choosing wind-firm species along main roads and power lines keeps routes open for rescue.`)
      if (!W.gridUp || W.poweredShare() < 1) lessons.push(`${W.gridUp ? `${Math.round((1 - W.poweredShare()) * 100)}% of the city lost power` : 'The whole city lost power'}${this.flood.pumps.some((p) => p.unpowered) ? ', and pump stations without backup generators stopped when they were needed most' : ''}.`)
      if (S.missileGlass >= 5) lessons.push(`Flying roof sheets broke windows in ${S.missileGlass} buildings. A loose sheet takes off at ~35 km/h, then flies at almost the wind's speed for hundreds of metres and hits with several kilojoules: enough to cut through a door or a person. Fixing sheets to every purlin and shuttering windows breaks the chain.`)
      const Hz = this.hazards
      for (const T of Hz.tornadoes) lessons.push(`A${T.ef.n === 0 ? 'n' : ''} ${T.ef.name} tornado crossed the city (${T.ef.kmh} km/h)${T.damaged ? ` and damaged ${T.damaged} buildings in a track only ~${T.rc * 3} m wide` : ''}. Tornadoes in typhoons form in the outer rainbands of the front-right quadrant, often around landfall, with only minutes of warning: the safe place is an interior room on the lowest floor.`)
      const SR = this.run.storms
      if (SR.strikes) lessons.push(`Lightning struck the city ${SR.strikes} time${SR.strikes > 1 ? 's' : ''}${SR.fires ? ` and started ${SR.fires} fire${SR.fires > 1 ? 's' : ''}` : ''}. Most strikes went to the tallest roofs, trees and poles: lightning rods give them a safe path to ground. The heavy rain keeps most fires small.`)
      if (this.typhoon.flags.inEye) lessons.push('The eye passed over the city. The calm in the eye is the most dangerous moment to go outside: the back eyewall returns within the hour, from the opposite direction.')
      if (!this.upgrades.floodWarning && dead > 0) lessons.push('Pre-emptive evacuation tied to the PAGASA wind signals gets people out of low-lying and light-material homes before the water rises and the roofs go, rather than after.')
    }
    if (this.relocated > 0) lessons.push(`${this.relocated.toLocaleString()} residents displaced by demolition were never rehoused.`)
    if (!lessons.length) lessons.push('Excellent preparation — the city came through without loss of life.')
    return {
      grade,
      rate,
      pop,
      dead,
      injured: Math.round(T.injured),
      rescued: Math.round(T.rescued || 0),
      evacuated: Math.round(T.evacuated || 0),
      displaced: Math.round(T.displaced + this.relocated),
      trapped: Math.round(T.trapped || 0),
      damaged: T.damaged ?? T.flooded,
      destroyed: T.destroyed,
      buildings: city.buildings.length,
      loss: T.loss,
      spent: this.spent,
      budget: this.budget,
      hours: this.simTime / 3600,
      causes: causes.map((c) => ({ ...c, value: Math.round(c.value) })),
      lessons,
      prep: this.quake && this.shadow ? this.prepEffect(T, this.quake.deathsByCause) : null,
      report: this.run ? this.stormReport(this.shadows ? undefined : null) : null,
    }
  }

  /**
   * Expected outcome for one building in this scenario, averaged over many
   * quakes like it: deaths inside, collapse and destruction odds, and the
   * repair bill. Used for the preparation estimate and the with/without
   * comparison in the results.
   */
  expectedQuake(b) {
    const r = this.quakeRisk(b)
    const pres = occupancyAt(b, this.settings.startHour)
    const P = r.probs
    let ratio = 0
    for (let i = 0; i < 4; i++) ratio += (P[i] - (P[i + 1] ?? 0)) * LOSS_RATIO[i]
    return {
      pga: r.pga,
      deaths: pres * (r.pCollapse * 0.13 + (r.pComplete - r.pCollapse) * 0.004 + r.pExtensive * 0.0004),
      collapse: r.pCollapse,
      complete: r.pComplete,
      loss: b.value * ratio,
    }
  }

  /**
   * What the preparations bought: for each kind of measure, the deaths,
   * destroyed buildings and losses it is estimated to have prevented, against
   * the city as generated. Building measures are scored with the damage model
   * (taking each one away again); facade anchoring from the street deaths that
   * unanchored facades caused in this run; early warning and gas valves from
   * the factors they apply in the simulation.
   */
  prepEffect(T, c) {
    this.stepShadow(this.quake.time)
    const S = this.shadow.totals()
    const prepared = this.prepSnapshot.city.buildings
    const ids = new Set(prepared.map((b) => b.id))
    const rows = {}
    const row = (k, label) => (rows[k] ??= { key: k, label, count: 0, lives: 0, destroyed: 0, loss: 0, spent: 0 })
    const credit = (k, label, without, withIt) => {
      const r = row(k, label)
      r.count++
      r.lives += without.deaths - withIt.deaths
      r.destroyed += without.complete - withIt.complete
      r.loss += without.loss - withIt.loss
    }
    let structuralDeaths = 0
    for (const b of prepared) {
      const now = this.expectedQuake(b)
      structuralDeaths += now.deaths
      if (b.origConstruction) credit('structural', 'Retrofits & base isolation', this.expectedQuake({ ...b, construction: b.origConstruction, softFixed: b.softFixed === 'retrofit' ? false : b.softFixed }), now)
      if (b.softFixed === 'brace') credit('brace', 'Soft storeys braced', this.expectedQuake({ ...b, softFixed: false }), now)
    }
    // demolished, with the residents moved to new, code-compliant housing
    for (const b of this.baselineCity.buildings) if (!ids.has(b.id)) credit('demolish', 'Demolished & rehoused', this.expectedQuake(b), { deaths: 0, complete: 0, loss: 0 })
    // facades: street deaths per unanchored facade in this run, times the anchored ones, less what still fell
    const kills = this.world.facadeKills
    const shed = prepared.filter((b) => sheddingFacade(b))
    const anchored = shed.filter((b) => b.facadeAnchored)
    if (anchored.length) {
      const sum = (list) => list.reduce((s, b) => s + (kills.get(b.id) || 0), 0)
      const open = shed.length - anchored.length
      const perOpen = open ? sum(shed.filter((b) => !b.facadeAnchored)) / open : sum(anchored) / 0.15 / anchored.length
      const r = row('anchor', 'Facades & parapets anchored')
      r.count = anchored.length
      r.lives = Math.max(0, perOpen * anchored.length - sum(anchored))
    }
    if (this.upgrades.quakeWarning) {
      const r = row('warning', 'Earthquake early warning')
      r.count = 1
      r.lives = structuralDeaths * (1 / 0.8 - 1)
    }
    if (this.upgrades.gasShutoff) {
      const r = row('gas', 'Gas shut-off valves')
      r.count = 1
      r.lives = c.fire * (1 / 0.4 - 1)
    }
    for (const [k, v] of Object.entries(this.prepSnapshot.spentBy || {})) if (rows[SPEND_GROUP[k]]) rows[SPEND_GROUP[k]].spent += v
    const list = Object.values(rows).filter((r) => r.count > 0)
    // The totals come from the shadow run: the same quake on the city as generated
    // (it has no people in the street, so this run's outdoor deaths are added to
    // it, plus what the anchored facades are estimated to have stopped). The
    // per-measure estimates only split the difference between the measures.
    const facadeLives = rows.anchor?.lives ?? 0
    const without = { dead: S.dead + T.outdoorDead + facadeLives, destroyed: S.destroyed, loss: S.loss }
    const saved = { lives: without.dead - T.dead, destroyed: without.destroyed - T.destroyed, loss: without.loss - T.loss }
    const split = (field, total) => {
      const sum = list.reduce((s, r) => s + Math.max(0, r[field]), 0)
      for (const r of list) r[field] = sum > 0 && total > 0 ? (Math.max(0, r[field]) / sum) * total : 0
    }
    split('lives', saved.lives)
    split('destroyed', saved.destroyed)
    split('loss', saved.loss)
    const spent = this.prepSnapshot.spent
    return { rows: list.sort((a, b) => b.lives - a.lives), without, saved, spent, bcr: spent > 0 ? Math.max(0, saved.loss) / spent : 0 }
  }

  // ------------------------------------------------------------- snapshot
  buildingInfo(id) {
    const b = this.city?.byId.get(id)
    if (!b) return null
    const C = CONSTRUCTION[b.construction]
    const info = {
      id,
      type: VARIANT_NAMES[b.variant] ?? BUILDING_TYPES[b.type].name,
      typeKey: b.type,
      floors: b.floors,
      height: b.height,
      construction: C.name,
      era: CONSTRUCTION[b.origConstruction ?? b.construction].era,
      area: b.area,
      residents: b.residents,
      present: occupancyAt(b, this.settings?.startHour ?? 12),
      value: b.value,
      soil: soilName(this.city.soil[cellOfBuilding(b)]),
      aboveBank: b.floorZ + b.elevated - this.city.bankZ[b.y],
      elevated: b.elevated,
      beds: b.beds,
      capacity: b.capacity,
      openFront: !!b.openFront,
      softStorey: softStoreyOf(b),
      softFixed: !!b.softFixed,
      sheds: sheddingFacade(b),
      facadeAnchored: !!b.facadeAnchored,
      measures: this.measuresOf(b),
    }
    if (this.settings?.disaster === 'quake') info.quake = this.quakeRisk(b)
    if (this.phase === 'prepare' && this.settings?.disaster === 'quake')
      info.options = QUAKE_TOOLS.map((k) => {
        const T = TOOLS.find((t) => t.key === k)
        const why = this.checkTool(k, b)
        return { key: k, name: T.name, icon: T.icon, status: why === null ? 'ok' : hasMeasure(k, b) ? 'done' : 'na', note: why ?? this.toolCost(k, b) }
      })
    if (this.quake) {
      const s = this.quake.st.get(id)
      if (s) {
        const G = this.quake.ground
        const k = cellOfBuilding(b)
        const liq = G.liqCount[k]
        info.state = {
          ds: !s.collapsed && s.lean > 1 / 60 && dsFromD(s.D) < 3 ? 'Unsafe (leaning)' : DAMAGE_STATES[s.collapsed ? 4 : s.ds],
          collapsed: s.collapsed,
          toppled: !!s.toppled,
          integrity: s.collapsed ? 0 : clamp(1 - s.D, 0, 1),
          hits: s.hits,
          settle: s.settle,
          lean: s.lean,
          groundState: G.slid[k] === 1 ? 'Landslide scar' : G.slid[k] === 2 ? 'Buried by landslide' : liq ? `Liquefied${liq > 1 ? ` (${liq}×)` : ''}` : G.crack[k] > 0.3 ? 'Cracked' : null,
          dead: s.dead,
          trapped: s.trapped,
          injured: s.crit + s.minor,
          burning: !!s.burning,
          burnt: s.burnt,
          present: s.present,
        }
      }
    }
    if (this.settings?.disaster === 'typhoon') {
      const r = windRisk(b, this.level.forecast.peakGust)
      info.wind = { kind: r.kind, medians: r.medians, gust: r.gust, pGlass: r.pGlass, pCover: r.pCover, pRoof: r.pRoof, pCollapse: r.pCollapse }
    }
    if (this.impact) {
      const s = this.impact.st.get(id)
      if (s) info.state = { depthIn: s.dIn, depthOut: s.dOut, maxIn: s.maxIn, velocity: s.v, dead: s.dead, present: s.present, evacuated: s.evacuated, collapsed: s.collapsed }
      const w = this.windDmg?.st.get(id)
      if (s && w) {
        info.state.wind = w.byWind ? 'Flattened by the wind' : w.collapsed ? null : w.roof ? 'Roof torn off' : w.cover ? 'Roof sheets / tiles lost' : w.glass ? 'Windows broken' : 'Intact'
        info.state.gust = w.gust
        info.state.maxGust = w.maxGust
        info.state.powered = b.type === 'hospital' || b.type === 'fire' || this.windDmg.powered(b.x, b.y)
      }
    }
    return info
  }

  prepStats() {
    const { city, settings } = this
    const st = cityStats(city, settings.startHour)
    const out = { residents: st.residents, present: st.present, buildings: st.count }
    const byClass = {}
    for (const b of city.buildings) byClass[b.construction] = (byClass[b.construction] || 0) + 1
    out.byClass = byClass
    if (settings.disaster === 'quake') {
      let expCollapse = 0
      let expDeaths = 0
      let pgaSum = 0
      for (const b of city.buildings) {
        const e = this.expectedQuake(b)
        pgaSum += e.pga
        expCollapse += e.collapse
        expDeaths += e.deaths
      }
      out.pga = city.buildings.length ? pgaSum / city.buildings.length : 0
      out.rockPga = rockPgaAt(this.quakeEvent(), 0, 0)
      out.expCollapse = expCollapse
      out.expDeaths = expDeaths
    } else {
      let low = 0
      for (const b of city.buildings) if (b.floorZ + b.elevated - city.bankZ[b.y] < 2 && b.floors <= 3) low += occupancyAt(b, settings.startHour)
      out.lowLying = low
      out.drainage = CITY_TYPES[city.type].drainage + 15 * this.upgrades.drainage
      let levee = 0
      for (let k = 0; k < GRID * GRID; k++) if (city.levee[k] > 0) levee++
      out.leveeM = levee * 10
      out.pumps = city.pumps.length
      out.shelterCap = city.buildings.filter((b) => b.type === 'shelter').reduce((s, b) => s + b.capacity, 0)
      // expected wind damage at the forecast peak gust
      const gust = this.level.forecast.peakGust
      let roofs = 0
      let flattened = 0
      let lightPeople = 0
      for (const b of city.buildings) {
        const r = windRisk(b, gust)
        roofs += r.pRoof
        flattened += r.pCollapse
        if (r.pCollapse > 0.1) lightPeople += occupancyAt(b, settings.startHour)
      }
      out.expRoofs = roofs
      out.expFlattened = flattened
      out.windExposed = lightPeople
    }
    return out
  }

  snapshot() {
    const s = {
      phase: this.phase,
      version: this.version,
      notice: this.notice && performance.now() - this.notice.t < 4500 ? this.notice : null,
      showWorld: this.world.showWorld,
      tool: this.tool,
      overlay: this.overlay,
    }
    if (this.phase === 'menu') return s
    const { city } = this
    s.city = { name: city.name, type: city.type, typeName: CITY_TYPES[city.type].name, seed: city.seed }
    s.settings = this.settings
    s.level = this.level
    s.budget = this.budget
    s.spent = this.spent
    s.relocated = this.relocated
    s.upgrades = this.upgrades
    s.hover = this.hover
    s.selected = this.selected != null ? this.buildingInfo(this.selected) : null
    s.hoverInfo = this.hover?.bid != null && this.hover.bid !== this.selected ? this.buildingInfo(this.hover.bid) : null
    if (this.phase === 'prepare') s.prep = this.prepStats()
    s.riskLayer = this.riskLayer
    s.coastal = !!this.city.coast
    s.plan = this.plan
    s.planFired = this.run?.planFired ?? null
    s.leveeHeight = this.leveeHeight
    const M = this.floodMapData
    if (M) {
      const h = this.hover
      let cell = null
      if (h) {
        const k = idx(h.i, h.j)
        const coast = this.city.coast
        cell = { depth: M.depth[k], source: M.source[k], aboveBank: this.city.z[k] - this.city.bankZ[h.j], aboveSea: coast ? this.city.z[k] - coast.msl : null, river: this.city.cellType[k] === CELL_RIVER, sea: !!this.city.sea[k], wall: this.city.levee[k] > 0 }
      }
      s.floodMap = { level: M.level, auto: M.auto, sea: M.sea, seaAuto: this.seaLevelMap == null, forecast: { inflow: M.forecast.inflow, stage: M.forecast.stage, tPeak: M.forecast.tPeak, sea: this.level.forecast.sea }, areaHa: M.areaHa, maxDepth: M.maxDepth, buildingsWet: M.buildingsWet, peopleWet: M.peopleWet, cell }
    }
    if (this.phase === 'sim' || this.phase === 'results') {
      const t = this.simTime
      const hour = this.settings.startHour + t / 3600
      s.sim = {
        time: t,
        clock: `Day ${Math.floor(hour / 24) + 1}, ${String(Math.floor(hour % 24)).padStart(2, '0')}:${String(Math.floor((hour * 60) % 60)).padStart(2, '0')}`,
        elapsed: t,
        speedIdx: this.speedIdx,
        paused: this.paused,
        physicsLimited: this.physicsLimited,
        population: this.population,
        totals: this.currentTotals(),
        log: this.log.slice(-60),
      }
      if (this.flood) {
        const f = this.flood
        s.sim.flood = { rain: f.rain, cumRain: f.cumRain, basinRain: f.basinRain, stage: f.stage, inflow: f.inflow, warned: this.impact.warned, pumpsFailed: f.pumps.filter((p) => p.failed).length, alarm: this.upgrades.floodWarning ? this.run.alarm : null, diverted: f.floodway ? f.diverted : null, gate: f.gate ? f.gateClosed : null }
        const im = this.impact
        let sheltered = 0
        let cap = 0
        for (const b of im.shelters) {
          sheltered += im.st.get(b.id)?.present ?? 0
          cap += b.capacity
        }
        s.sim.shelters = { sheltered, cap, crowded: sheltered > cap, orders: Object.keys(im.orders), forced: im.forced }
        // the sea: m above mean sea level now, the most so far, and the beachfront it has to get over
        if (f.coast) s.sim.flood.sea = { rise: f.seaRise, max: f.seaMax, shore: this.typhoon.shoreRise, ...this.typhoon.now.sea }
      }
      if (this.typhoon) {
        const ty = this.typhoon
        s.sim.typhoon = { ...ty.now, signal: ty.signal, peak: { ...ty.peak }, passed: !!ty.flags.passed }
        const W = this.windDmg
        s.sim.wind = { ...W.stats, power: W.poweredShare(), gridUp: W.gridUp, pumpsOff: this.flood.pumps.filter((p) => p.unpowered).length }
        const Hz = this.hazards
        const T = Hz.tornado
        s.sim.storms = { strikes: this.run.storms.strikes, fires: this.run.storms.fires, flashRate: Hz.rate ?? 0, nearTornadoes: Hz.nearTornadoes, tornado: T ? { ef: T.ef.name, kmh: T.ef.kmh, down: T.down, damaged: T.damaged } : null, tornadoes: Hz.tornadoes.length }
        s.sim.lens = this.lens
        s.sim.lensStats = this.lensStats
        // the ground under the cursor
        const h = this.hover && { i: clamp(Math.floor(this.hover.i), 0, GRID - 1), j: clamp(Math.floor(this.hover.j), 0, GRID - 1) }
        if (h) {
          const f = this.flood
          const k = idx(h.i, h.j)
          const bid = this.city.buildingAt[k]
          const b = bid >= 0 ? this.city.byId.get(bid) : null
          const bridge = !!this.city.bridge[k]
          const kind = bridge ? 'Bridge' : this.city.sea[k] ? 'Sea' : this.city.cellType[k] === CELL_RIVER ? 'River' : b ? (VARIANT_NAMES[b.variant] ?? BUILDING_TYPES[b.type].name) : this.city.cellType[k] === CELL_ROAD ? 'Street' : this.city.cellType[k] === CELL_PARK ? 'Park' : 'Open ground'
          s.sim.lensCell = { i: h.i, j: h.j, kind, ground: this.city.z[k] - this.city.bankZ[h.j], depth: f.h[k], speed: f.velocityAt(h.i, h.j), powered: b && (b.type === 'hospital' || b.type === 'fire') ? 'Generator' : W.powered(h.i, h.j) ? 'On' : 'Off', inside: b ? this.impact.st.get(b.id)?.dIn ?? 0 : null }
        }
      }
      if (this.quake) {
        const q = this.quake
        s.sim.quake = { mainDone: q.mainDone, countdown: Math.max(0, q.mainTime - q.time), shocks: q.shocks.length, lastShock: q.shocks[q.shocks.length - 1] ?? null, maxAfter: Math.max(0, ...q.shocks.filter((x) => !x.main).map((x) => x.M)), fires: q.fires, ground: q.ground.stats(), panic: this.world.life.panicStats(), bridges: q.bridges.filter((b) => b?.ds >= 3).length, bridgesDown: q.bridges.filter((b) => b?.collapsed).length, wind: { speed: q.fire.wind.speed, from: compass(q.fire.wind.dir + Math.PI) }, treesBurning: q.fire.trees.filter((t) => t.fire > 0).length, treesBurnt: q.fire.trees.filter((t) => t.burnt).length }
      }
    }
    if (this.results) s.results = this.results
    // how far the typhoon report's comparison runs have got
    s.prepProgress = this.results?.report?.pending && this.shadows ? this.shadows.progress(this.flood.time) : null
    return s
  }
}

