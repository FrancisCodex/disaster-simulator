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
  FLOOD_LEVELS,
  COSTS,
  UPGRADES,
  SPEEDS,
  LEVEE_HEIGHT,
  POND_DEPTH,
  DAMAGE_STATES,
} from './config.js'
import { generateCity, addBuilding, idx, occupancyAt, cityStats } from './cityGen.js'
import { Rng, clamp } from './math.js'
import { World } from './world.js'
import { FloodSim } from './floodSim.js'
import { FloodImpact } from './floodImpact.js'
import { QuakeSim, demand, mediansFor, damageProbs, collapseProb, cellOfBuilding, soilName, rockPgaAt, withGeometry, quakeAzimuth, shapeOf, dsFromD, compass } from './quakeSim.js'

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
  return { mech: 'strike', strike: 90, rupture: 'bilateral', ...ev, mode: q.mode ?? 'tier', bearing: q.bearing ?? null, variability: q.variability !== false, aftershocks: q.aftershocks !== false }
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
  { key: 'levee', name: 'Flood wall', group: 'Flood', icon: '🧱', desc: `Drag to paint a ${LEVEE_HEIGHT} m flood wall. Can fail if overtopped.`, size: [1, 1] },
  { key: 'pump', name: 'Pump station', group: 'Flood', icon: '⛽', desc: 'Pumps 10 m³/s of floodwater into the river. Fails if its site floods.', size: [1, 1] },
  { key: 'pond', name: 'Retention pond', group: 'Flood', icon: '💧', desc: `Excavates a ${POND_DEPTH} m deep basin that stores stormwater.`, size: [4, 4] },
  { key: 'elevate', name: 'Elevate', group: 'Flood', icon: '⬆️', desc: 'Raise a low-rise building 2 m on a new foundation.' },
  { key: 'retrofit', name: 'Retrofit', group: 'Quake', icon: '🔩', desc: 'Strengthen the structure one code level (e.g. masonry → reinforced concrete).' },
  { key: 'isolate', name: 'Base isolation', group: 'Quake', icon: '🛞', desc: 'Put the building on seismic isolators. Very effective, very expensive.' },
]

const NEW_BUILD = {
  house: { floors: 2, construction: 'wood_mod' },
  apartment: { floors: 6, construction: 'rc_high' },
  hospital: { floors: 5, construction: 'rc_high' },
  fire: { floors: 2, construction: 'rc_high' },
  shelter: { floors: 2, construction: 'rc_high' },
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
      // swap in the detailed models, but never in the middle of a disaster
      if (!this.city || this.phase === 'sim' || this.phase === 'results') return
      this.world.life.build(this.city, this.phase === 'menu' ? 17.5 : this.settings.startHour)
    }
    this.bindInput()
    try {
      this.world.useModels = localStorage.getItem('metrorisk.models') !== 'simple'
    } catch {
      /* storage unavailable: keep the default */
    }
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
    const city = generateCity(settings.cityType, settings.seed)
    this.setupCity(city)
    this.budget = CITY_TYPES[city.type].budget
    this.spent = 0
    this.upgrades = { floodWarning: false, drainage: 0, dredge: false, quakeWarning: false, gasShutoff: false }
    this.relocated = 0
    this.actions = {}
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
    this.log = []
    this.results = null
    this.flood = this.quake = this.impact = null
    this.world.controls.autoRotate = false
    this.world.buildCity(city, this.settings.startHour)
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

  /** Vehicles & people: detailed Quaternius models or the built-in procedural ones. */
  setModelStyle(detailed) {
    this.world.useModels = detailed
    this.world.life.models = detailed ? (this.world.modelAssets ?? null) : null
    try {
      localStorage.setItem('metrorisk.models', detailed ? 'detailed' : 'simple')
    } catch {
      /* not persisted */
    }
    if (this.city && this.phase !== 'sim' && this.phase !== 'results') this.world.life.build(this.city, this.phase === 'menu' ? 17.5 : this.settings.startHour)
    else this.notify('Model style will apply to the next city.')
    this.emit()
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
    return this.settings.disaster === 'quake' ? this.quakeEvent() : FLOOD_LEVELS[this.settings.level]
  }

  notify(text, kind = 'info') {
    this.notice = { text, kind, t: performance.now() }
    this.emit()
  }

  setTool(t) {
    this.tool = t
    this.world.setHighlight(null)
    this.emit()
  }

  select(id) {
    this.selected = id
    this.emit()
  }

  toggleOverlay() {
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
      if (this.phase === 'prepare' && this.tool === 'levee' && e.button === 0) {
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
      case 'elevate':
        return b ? (b.fw * b.fd * COSTS.elevateM2) / 1e6 : 0
      case 'levee':
        return COSTS.leveeCell
      case 'pump':
        return COSTS.pump
      case 'pond':
        return COSTS.pond
      case 'park':
        return COSTS.park
      default: {
        if (!NEW_BUILD[tool] || !fp) return 0
        const T = BUILDING_TYPES[tool]
        let floors = NEW_BUILD[tool].floors
        if (tool === 'apartment' && P.key === 'rural') floors = 3
        const area = (fp.w * 10 - 5) * (fp.d * 10 - 5) * floors
        return (area * T.costM2) / 1e6
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
    if (tool === 'elevate') {
      if (b.elevated) return 'Already elevated'
      if (b.floors > 3) return 'Only low-rise buildings (≤3 floors) can be raised'
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
    if (['inspect', 'demolish', 'retrofit', 'isolate', 'elevate'].includes(tool)) {
      if (b) {
        reason = tool === 'inspect' || tool === 'demolish' ? null : this.checkTool(tool, b)
        cost = this.toolCost(tool, b)
        hl = { x: b.x, y: b.y, w: b.w, d: b.d, h: b.height + b.elevated + 1, base: b.base, color: tool === 'inspect' ? 0x93c5fd : reason ? 0xef4444 : tool === 'demolish' ? 0xf97316 : 0x4ade80 }
      } else if (tool === 'demolish') {
        const k = idx(p.i, p.j)
        if (city.levee[k] > 0 || city.pumps.some((q) => q.i === p.i && q.j === p.j)) hl = { x: p.i, y: p.j, w: 1, d: 1, h: 5, color: 0xf97316 }
      }
    } else {
      const fp = this.footprint(tool, p.i, p.j)
      const k = idx(p.i, p.j)
      let ok
      if (tool === 'levee') ok = city.cellType[k] !== CELL_RIVER && city.buildingAt[k] < 0 && !city.bridge[k] && !city.levee[k]
      else if (tool === 'pump') ok = this.areaFree(fp.x, fp.y, 1, 1, { allowRoad: true })
      else ok = this.areaFree(fp.x, fp.y, fp.w, fp.d)
      cost = this.toolCost(tool, null, fp)
      reason = ok ? null : 'Blocked — needs empty land'
      hl = { ...fp, h: tool === 'levee' ? LEVEE_HEIGHT : 6, color: ok ? 0x4ade80 : 0xef4444 }
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
    if (['retrofit', 'isolate', 'elevate'].includes(tool)) {
      if (!b) return
      const why = this.checkTool(tool, b)
      if (why) return this.notify(why, 'bad')
      const cost = this.toolCost(tool, b)
      if (!this.pay(cost, tool)) return
      if (tool === 'retrofit') b.construction = CONSTRUCTION[b.construction].next
      if (tool === 'isolate') b.construction = 'isolated'
      if (tool === 'elevate') {
        b.elevated = 2
        this.world.rebuildStatic()
      }
      this.world.rebuildBuildings()
      this.applyColorMode()
      this.selected = b.id
      this.notify(`${TOOLS.find((t) => t.key === tool).name}: ${BUILDING_TYPES[b.type].name} — ${cost.toFixed(2)} $M`, 'good')
      return
    }
    const fp = this.footprint(tool, p.i, p.j)
    if (tool === 'levee') return
    if (tool === 'pump') {
      if (!this.areaFree(fp.x, fp.y, 1, 1, { allowRoad: true })) return this.notify('A pump needs an empty cell or road.', 'bad')
      if (!this.pay(COSTS.pump, 'pump')) return
      city.pumps.push({ i: fp.x, j: fp.y })
      this.world.rebuildStatic()
      this.notify('Pump station built (10 m³/s).', 'good')
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
      const nb = addBuilding(city, rng, { type: tool, ...fp, floors, construction: NEW_BUILD[tool].construction })
      if (nb.residents) this.relocated = Math.max(0, this.relocated - nb.residents)
      this.world.paintTerrain()
      this.world.buildTrees()
      this.world.rebuildBuildings()
      this.applyColorMode()
      this.selected = nb.id
      this.notify(`${BUILDING_TYPES[tool].name} built — ${cost.toFixed(2)} $M`, 'good')
    }
  }

  demolish(b, p) {
    const { city } = this
    const k = idx(p.i, p.j)
    if (!b) {
      if (city.levee[k] > 0) {
        city.levee[k] = 0
        this.world.rebuildStatic()
        this.world.paintTerrain()
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

  paintLeveeCell(i, j) {
    const p = { i, j }
    const { city } = this
    const k = idx(p.i, p.j)
    if (city.levee[k] > 0 || city.cellType[k] === CELL_RIVER || city.buildingAt[k] >= 0 || city.bridge[k]) return
    if (city.pumps.some((q) => q.i === p.i && q.j === p.j)) return
    if (!this.pay(COSTS.leveeCell, 'levee')) {
      this.painting = false
      this.world.controls.enabled = true
      return
    }
    city.levee[k] = LEVEE_HEIGHT
    this.leveePaintDirty = true
    this.version++
  }

  buyUpgrade(key) {
    const U = UPGRADES[key]
    const lvl = typeof this.upgrades[key] === 'number' ? this.upgrades[key] : this.upgrades[key] ? 1 : 0
    if (U.max ? lvl >= U.max : lvl >= 1) return
    const cost = U.cost(this.city, lvl)
    if (!this.pay(cost, key)) return
    if (U.max) this.upgrades[key] = lvl + 1
    else this.upgrades[key] = true
    if (key === 'dredge') {
      for (let k = 0; k < GRID * GRID; k++) if (this.city.cellType[k] === CELL_RIVER) this.city.z[k] -= 1.5
      this.city.dredged = true
      this.world.updateTerrainHeights()
      this.refreshPreview()
    }
    this.notify(`${U.name} purchased (${cost.toFixed(1)} $M).`, 'good')
  }

  upgradeCost(key) {
    const U = UPGRADES[key]
    const lvl = typeof this.upgrades[key] === 'number' ? this.upgrades[key] : this.upgrades[key] ? 1 : 0
    return { cost: U.cost(this.city, lvl), owned: U.max ? lvl >= U.max : lvl >= 1, lvl }
  }

  refreshPreview() {
    this.preview = new FloodSim(this.city)
    this.preview.computeFlow()
    this.world.updateWater(this.preview)
  }

  // --------------------------------------------------------------- colors
  applyColorMode() {
    const { settings } = this
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
      } else {
        this.world.setColorFn((b) => {
          const e = b.floorZ + b.elevated - this.city.bankZ[b.y]
          return heat(1 - clamp((e - 0.5) / 4, 0, 1))
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
      this.world.setColorFn((b) => {
        const s = this.impact.st.get(b.id)
        if (!s) return null
        if (s.collapsed) return '#7f1d1d'
        return heat(clamp(s.maxIn / 2.5, 0, 1))
      })
    }
  }

  quakeRisk(b) {
    const L = this.quakeEvent()
    const soil = this.city.soil[cellOfBuilding(b)]
    const p = demand(b, soil, L.M, rockPgaAt(L, b.cx, b.cz))
    const med = mediansFor(b, L.M, 0)
    const probs = damageProbs(p, med)
    const sh = shapeOf(b)
    return { pga: p, soil, pComplete: probs[3], pExtensive: probs[2], pCollapse: probs[3] * collapseProb(b, p, med), slender: sh.slender, shapeCap: sh.cap }
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
    const P = CITY_TYPES[city.type]
    const stats = cityStats(city, settings.startHour)
    if (settings.disaster === 'flood') {
      this.flood = new FloodSim(city, { peak: this.level.peak, drainage: P.drainage + 15 * this.upgrades.drainage })
      this.impact = new FloodImpact(city, this.flood, { warning: this.upgrades.floodWarning, startHour: settings.startHour, levelIndex: settings.level, rng: this.rng })
      this.population = this.impact.population
      this.pushLog(0, `${this.level.name} begins over ${city.name}. Forecast peak ${this.level.peak} mm/h.`, 'warn')
    } else {
      this.quake = new QuakeSim(city, this.level, { warning: this.upgrades.quakeWarning, gasShutoff: this.upgrades.gasShutoff, startHour: settings.startHour, rng: this.rng })
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
    if (this.phase === 'sim' || this.phase === 'results') {
      const hour = this.settings.startHour + this.simTime / 3600
      const rain = this.flood && this.phase === 'sim' ? this.flood.rain : this.flood ? 0 : 0
      let haze = 0
      if (this.quake?.mainDone) haze = clamp(this.quake.shocks[0].pga * 0.8, 0, 0.45) * Math.exp(-(this.simTime - this.quake.mainTime) / 7200)
      w.setEnvironment({ hour, rain, haze })
    }
    w.setLifeContext(this.lifeContext())
    // paused: freeze every moving thing (traffic, people, debris, fire, water, shaking)
    w.update(dt, this.phase === 'sim' && this.paused)
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
      ctx.warned = this.impact.warned
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
    const done = f.advance(want, 12)
    this.physicsLimited = done < want * 0.85
    this.simTime = f.time
    this.acc += done
    let tick = false
    while (this.acc >= 300) {
      this.acc -= 300
      this.impact.update(300 / 3600)
      this.impact.updateLevees(300 / 3600)
      tick = true
    }
    this.waterFrame = (this.waterFrame || 0) + 1
    if (this.waterFrame % 2 === 0) {
      f.computeFlow()
      this.world.updateWater(f)
    }
    if (tick) this.syncFlood()
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

  stepQuake(want) {
    const q = this.quake
    this.acc += want
    while (this.acc >= 60) {
      this.acc -= 60
      q.update(60)
    }
    this.simTime = q.time + this.acc
    for (const e of q.events.splice(0)) this.pushLog(e.t, e.text, e.level)
    const w = this.world
    const fall = (b, delay) => {
      const s = q.st.get(b.id)
      w.collapse(b, delay, 'quake', s?.toppled ? { lean: s.lean, leanAng: s.leanAng } : undefined)
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
      const lag = w.addShake(v.pga, dur, v.M, v.main, v.field)
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


  endDisaster() {
    if (this.phase !== 'sim') return
    this.phase = 'results'
    this.paused = true
    this.results = this.computeResults()
    this.world.rain.update(0, 0, this.world.controls.target)
    this.emit()
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
    this.flood = this.quake = this.impact = null
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
      causes.push({ label: 'Drowned indoors', value: c.drowning }, { label: 'Buildings swept away', value: c.collapse }, { label: 'Caught while evacuating', value: c.evacuation }, { label: 'Swept away outdoors', value: T.outdoorDead })
      if (c.drowning >= 1) lessons.push('Most drownings happened in low-rise homes in low-lying areas. Flood walls, elevating homes and earlier evacuation all reduce this.')
      if (c.evacuation >= 1) lessons.push(`${Math.round(c.evacuation)} people died wading through floodwater. ${this.upgrades.floodWarning ? 'Shelters closer to people help.' : 'An early-warning system gets people out before the streets flood.'}`)
      if (this.flood.stageMax > 0) lessons.push(`The river rose ${this.flood.stageMax.toFixed(1)} m above its banks. Continuous flood walls along the river, dredging and upstream storage help — but walls can fail if overtopped.`)
      if (!city.buildings.some((b) => b.type === 'shelter')) lessons.push('There were no evacuation shelters — evacuees had to leave the area on their own, which is slower.')
      const failedP = this.flood.pumps.filter((p) => p.failed).length
      if (failedP) lessons.push(`${failedP} pump station${failedP > 1 ? 's' : ''} flooded and failed. Put pumps on higher ground or protect them with walls.`)
      if (this.flood.cumRain > 0) lessons.push(`${Math.round(this.flood.cumRain)} mm of rain fell in ${(this.simTime / 3600).toFixed(1)} hours.`)
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
    }
  }

  // ------------------------------------------------------------- snapshot
  buildingInfo(id) {
    const b = this.city?.byId.get(id)
    if (!b) return null
    const C = CONSTRUCTION[b.construction]
    const info = {
      id,
      type: BUILDING_TYPES[b.type].name,
      typeKey: b.type,
      floors: b.floors,
      height: b.height,
      construction: C.name,
      era: C.era,
      area: b.area,
      residents: b.residents,
      present: occupancyAt(b, this.settings?.startHour ?? 12),
      value: b.value,
      soil: soilName(this.city.soil[cellOfBuilding(b)]),
      aboveBank: b.floorZ + b.elevated - this.city.bankZ[b.y],
      elevated: b.elevated,
      beds: b.beds,
      capacity: b.capacity,
    }
    if (this.settings?.disaster === 'quake') info.quake = this.quakeRisk(b)
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
    if (this.impact) {
      const s = this.impact.st.get(id)
      if (s) info.state = { depthIn: s.dIn, depthOut: s.dOut, maxIn: s.maxIn, velocity: s.v, dead: s.dead, present: s.present, evacuated: s.evacuated, collapsed: s.collapsed }
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
        const r = this.quakeRisk(b)
        pgaSum += r.pga
        expCollapse += r.pCollapse
        const pres = occupancyAt(b, settings.startHour)
        expDeaths += pres * (r.pCollapse * 0.13 + (r.pComplete - r.pCollapse) * 0.004 + r.pExtensive * 0.0004)
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
    }
    return out
  }

  snapshot() {
    const s = {
      phase: this.phase,
      version: this.version,
      notice: this.notice && performance.now() - this.notice.t < 4500 ? this.notice : null,
      showWorld: this.world.showWorld,
      detailedModels: this.world.useModels !== false,
      modelsReady: !!this.world.modelAssets,
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
        s.sim.flood = { rain: f.rain, cumRain: f.cumRain, stage: f.stage, inflow: f.inflow, warned: this.impact.warned, pumpsFailed: f.pumps.filter((p) => p.failed).length }
      }
      if (this.quake) {
        const q = this.quake
        s.sim.quake = { mainDone: q.mainDone, countdown: Math.max(0, q.mainTime - q.time), shocks: q.shocks.length, lastShock: q.shocks[q.shocks.length - 1] ?? null, maxAfter: Math.max(0, ...q.shocks.filter((x) => !x.main).map((x) => x.M)), fires: q.fires, ground: q.ground.stats(), panic: this.world.life.panicStats(), bridges: q.bridges.filter((b) => b?.ds >= 3).length, bridgesDown: q.bridges.filter((b) => b?.collapsed).length, wind: { speed: q.fire.wind.speed, from: compass(q.fire.wind.dir + Math.PI) }, treesBurning: q.fire.trees.filter((t) => t.fire > 0).length, treesBurnt: q.fire.trees.filter((t) => t.burnt).length }
      }
    }
    if (this.results) s.results = this.results
    return s
  }
}

