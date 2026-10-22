// One typhoon on one city, without the renderer: the storm, the water, the
// wind, the thunderstorms, the city's plan, and what they do to people and
// buildings. The game drives it frame by frame and draws what it reports.
// The after-action report runs the same storm, with the same random seeds, on
// copies of the city in a worker (stormWorker.js), so that "without your
// preparations" is the same code as what the player watched.
//
// Visual side effects go through `fx` (all optional): groundAt(x, z), lamps()
// (street lights lightning can hit), life (the street agents WindDamage
// knocks poles onto), lightning(x, y, z), treesDown(), windChanged(),
// tornado(t). Headless, the ground comes from the city's heights and there
// are no street lights.
//
// Besides the totals, it records what the report needs: when each hazard
// reached the city and each link of the flood defences gave way, who had left
// each zone by then, the power supply hour by hour, and what the clean-up
// will face.

import { GRID, CELL, CELL_RIVER, CITY_TYPES, BUILDING_TYPES, RIVER_ALARMS } from './config.js'
import { PLAN_ACTIONS, PLAN_TRIGGERS, DEFAULT_PLAN, surgeBand, alarmLevel, triggerMet } from './evacPlan.js'
import { idx, cellToWorld } from './cityGen.js'
import { Rng, clamp, smoothstep, lerp } from './math.js'
import { FloodSim } from './floodSim.js'
import { FloodImpact } from './floodImpact.js'
import { TyphoonSim } from './typhoonSim.js'
import { signalAt } from './typhoonPhysics.js'
import { WindDamage } from './windDamage.js'
import { StormHazards, STRIKE_R } from './stormHazards.js'
import { FireSim } from './fireSim.js'

const HALF = (GRID * CELL) / 2

/** How high the beachfront of a coastal city stands (m above mean sea level): the median of the land within 60 m of the shore. */
export function shoreRise(city) {
  if (!city.coast) return Infinity
  const zs = []
  for (let i = 0; i < GRID; i++)
    for (let j = Math.floor(city.coast.shore[i]) - 6; j < city.coast.shore[i]; j++) {
      const k = idx(i, j)
      if (j >= 0 && !city.sea[k] && city.cellType[k] !== CELL_RIVER) zs.push(city.z[k] + city.levee[k])
    }
  zs.sort((a, b) => a - b)
  return zs.length ? zs[zs.length >> 1] - city.coast.msl : Infinity
}

/** Ground height at world (x, z) from the city's cell heights (bilinear, as the renderer's terrain). */
function cityGroundAt(city, x, z) {
  const fi = clamp((x + HALF) / CELL - 0.5, 0, GRID - 1.001)
  const fj = clamp((z + HALF) / CELL - 0.5, 0, GRID - 1.001)
  const i = Math.floor(fi)
  const j = Math.floor(fj)
  const Z = city.z
  const a = Z[idx(i, j)]
  const b = Z[idx(i + 1, j)]
  const c = Z[idx(i, j + 1)]
  const d = Z[idx(i + 1, j + 1)]
  return lerp(lerp(a, b, fi - i), lerp(c, d, fi - i), fj - j)
}

// the zones a plan can order out, and when the hazard has reached a home in each (see StormRun.record)
const ZONE_HIT = {
  coast: (s) => s.sea && s.dIn > 0.1, // seawater inside
  river: (s) => s.dIn > 0.3, // floodwater inside
  light: (s, w) => w?.roof || w?.byWind, // the roof gone, or the house flattened
}
// debris left behind, tonnes per m² of footprint: a lost roof (sheets, purlins, battens), and per m² of floor of a collapsed building
const ROOF_DEBRIS = 0.012
const WRECK_DEBRIS = { wood_old: 0.15, wood_mod: 0.2, urm: 0.9, rc_low: 1, rc_mod: 1, rc_high: 1, isolated: 1, steel: 0.5 }

export class StormRun {
  /**
   * city: the city (changed by the storm); level: the typhoon scenario.
   * upgrades: the city-wide upgrades bought (game.upgrades); plan: when each plan action is taken.
   */
  constructor(city, level, { startHour, seed, upgrades = {}, plan = DEFAULT_PLAN, fx = {} }) {
    this.city = city
    this.level = level
    this.U = upgrades
    this.plan = plan
    this.fx = fx
    this.events = []
    const U = upgrades
    const P = CITY_TYPES[city.type]
    this.rng = new Rng((seed ^ 0x5bd1e995) >>> 0)
    this.typhoon = new TyphoonSim(level, { place: city.name, shoreRise: shoreRise(city) })
    this.flood = new FloodSim(city, { storm: this.typhoon, drainage: P.drainage + 15 * (U.drainage || 0), tideGates: !!U.tideGates, generators: !!U.pumpGenerators })
    this.impact = new FloodImpact(city, this.flood, { warning: !!U.floodWarning, surgeWarning: !!U.surgeWarning, drills: !!U.drills, startHour, signal: () => this.typhoon.signal, surgeZone: this.typhoon.fc.sea?.peak ?? 0, rng: this.rng })
    this.windDmg = new WindDamage(city, this.impact, this.typhoon, { rng: new Rng((seed ^ 0x2545f491) >>> 0), life: fx.life ?? null, treeCare: !!U.treeCare, poles: U.poles || 0 })
    // lightning, tornadoes, and the fires lightning starts
    this.hazards = new StormHazards(this.typhoon, { rng: new Rng((seed ^ 0x3c6ef372) >>> 0), mode: level.tornado ?? 'natural', centre: { x: cellToWorld(city.center.i), z: cellToWorld(city.center.j) } })
    this.tyFire = new FireSim(city, new Rng((seed ^ 0x1b873593) >>> 0))
    this.storms = { strikes: 0, fires: 0, logged: 0 }
    this.windAcc = 0
    this.acc = 0
    this.alarm = 0
    this.population = this.impact.population
    // what the report needs (see record)
    this.marks = {} // simulation time (s) each hazard or failure was first seen
    this.zoneShare = {} // share of each zone that had left when the hazard reached its first home
    this.zonePeople = {} // people in each zone at the start
    this.zoneB = {}
    for (const z of Object.keys(ZONE_HIT)) {
      this.zoneB[z] = city.buildings.filter((b) => b.type !== 'shelter' && this.impact.st.has(b.id) && this.impact.zonesOf(b).includes(z))
      this.zonePeople[z] = this.zoneTally(z).start
    }
    this.steps = [] // the plan's steps as they were taken: { action, trig, t, head }
    this.powerTl = [] // share of the city with power, every hour
    // the plan: steps whose trigger had already come by the time the simulation starts were carried out then
    this.planFired = {}
    this.evalPlan(true)
    this.record()
  }

  get time() {
    return this.flood.time
  }

  log(t, text, level) {
    this.events.push({ t, text, level })
  }

  /**
   * Advance the flood solver by up to `seconds` within a CPU budget, then
   * everything on its clock: wind damage and thunderstorms every simulated
   * minute (the eyewall passes in under an hour), people, the plan and the
   * walls every five. Returns the simulated time done.
   */
  advance(seconds, budgetMs = 10) {
    const f = this.flood
    const done = f.advance(seconds, budgetMs)
    this.typhoon.update(f.time)
    this.windAcc += done
    const ticks = Math.floor(this.windAcc / 60)
    this.windTicked = ticks > 0
    if (ticks > 0) {
      this.windAcc -= ticks * 60
      for (let q = ticks - 1; q >= 0; q--) {
        const tm = f.time - this.windAcc - q * 60
        this.windDmg.update(tm, 1 / 60, { cumRain: f.cumRain })
        this.stepHazards(tm)
        this.powerPumps()
      }
    }
    this.acc += done
    this.ticked = false
    while (this.acc >= 300) {
      this.acc -= 300
      this.checkAlarms()
      this.evalPlan()
      this.impact.update(300 / 3600)
      this.impact.updateLevees(300 / 3600)
      this.record()
      this.ticked = true
    }
    return done
  }

  /** Pumps stop with the power on their feeder, unless they have a backup generator. */
  powerPumps() {
    const W = this.windDmg
    let cut = 0
    for (const p of this.flood.pumps) {
      const was = p.unpowered
      p.unpowered = !W.powered(p.i, p.j)
      if (p.unpowered && !was && p.active && !p.generator) cut++
    }
    if (cut) {
      this.marks.pumpDark ??= this.time
      this.log(this.time, `${cut} pump station${cut > 1 ? 's have' : ' has'} lost power and stopped.`, 'bad')
    }
  }

  // ------------------------------------------------------------------ the plan
  /** What the plan's triggers watch, right now. */
  planState() {
    const ty = this.typhoon
    const tau = ty.tau()
    return { tau, signal: ty.signal, surge: this.city.coast ? surgeBand(ty.fc.sea, tau) : 0, alarm: this.alarm, flooding: this.impact.flooding(), gauges: !!this.U.floodWarning }
  }

  /**
   * How many hours before the simulation began a trigger was already met
   * (orders given then have had time to work), at most a day.
   */
  triggerAge(key) {
    const T = PLAN_TRIGGERS[key]
    const ty = this.typhoon
    const tau = ty.tau()
    let age = 0
    if (T.kind === 'hours') age = tau - T.level
    else if (T.kind === 'surge') age = tau - (ty.fc.sea.surgeMaxTau - 48)
    else if (T.kind === 'signal') {
      // walk back until the signal was lower
      for (let a = 0.5; a <= 24; a += 0.5) {
        if (signalAt(ty.fc.timeline, tau - a) < T.level) break
        age = a
      }
    }
    return clamp(age, 0, 24)
  }

  /** Check the plan's triggers and carry out the steps that are due. start: at the start of the simulation. */
  evalPlan(start = false) {
    const st = this.planState()
    for (const [action, trig] of Object.entries(this.plan)) {
      if (this.planFired[action] || trig === 'never') continue
      if ((PLAN_ACTIONS[action].coastal || PLAN_TRIGGERS[trig]?.coastal) && !this.city.coast) continue
      if (!triggerMet(trig, st)) continue
      this.planFired[action] = true
      const head = start ? this.triggerAge(trig) : 0
      this.steps.push({ action, trig, t: this.time - head * 3600, head })
      this.planStep(action, trig, head)
    }
  }

  planStep(action, trig, head) {
    const im = this.impact
    const when = PLAN_TRIGGERS[trig].name
    const ago = head >= 1 ? ` (${Math.round(head)} h ago, before the storm got close)` : ''
    const t = this.time
    const late = trig === 'flooding'
    switch (action) {
      case 'closeSchools': {
        const n = im.closeSchools()
        this.log(t, `${when}${ago}: classes and work suspended. ~${Math.round(n).toLocaleString()} people sent home from schools and offices.`, 'info')
        break
      }
      case 'shutters': {
        const n = this.windDmg.closeShutters()
        if (n) this.log(t, `${when}${ago}: storm shutters closed on ${n} building${n > 1 ? 's' : ''}.`, 'info')
        break
      }
      case 'evacCoast':
      case 'evacRiver':
      case 'evacLight': {
        const zone = PLAN_ACTIONS[action].zone
        im.order(zone, head)
        const what = { coast: 'the coastal zone the surge could reach', river: 'low-lying and riverside areas', light: 'light-material homes' }[zone]
        const share = Math.round(im.compliance(zone) * 100)
        this.log(t, late ? `Emergency evacuation of ${what} — late: the water is already in the streets.` : `${when}${ago}: pre-emptive evacuation of ${what}. About ${share}% of residents are expected to go.`, late ? 'bad' : 'warn')
        break
      }
      case 'forced':
        im.force()
        this.log(t, `${when}${ago}: forced evacuation. Police and barangay officials are moving everyone still in the danger zones.`, 'warn')
        break
      case 'boats':
        im.boatsSafe = true
        this.log(t, `${when}${ago}: rescue boats moved from the fire stations to the shelters.`, 'info')
        break
    }
  }

  /** River alarm levels at the gauge (only announced if the city has gauges). */
  checkAlarms() {
    const a = alarmLevel(this.flood.stage, RIVER_ALARMS)
    if (a <= this.alarm) return
    this.alarm = a
    if (!this.U.floodWarning) return
    const text = ['', 'River alarm 1 at the gauge: warning — the river is rising toward its banks.', 'River alarm 2: prepare to evacuate low-lying areas.', 'River alarm 3: critical level — the river is about to overtop.'][a]
    this.log(this.time, text, a >= 2 ? 'bad' : 'warn')
  }

  // ------------------------------------------------------------ thunderstorms
  /** Every simulated minute: lightning in the district, tornadoes, and the fires they start. */
  stepHazards(t) {
    const H = this.hazards
    const fx = this.fx
    const events = H.update(t, 60, { groundAt: (x, z) => (fx.groundAt ? fx.groundAt(x, z) : cityGroundAt(this.city, x, z)), cands: (x, z) => this.strikeCandidates(x, z) })
    for (const e of events.splice(0)) {
      if (e.strike) this.lightningStrike(e.strike)
      else this.log(e.t, e.text, e.level)
    }
    if (H.tornado && !H.tornado.seen) {
      H.tornado.seen = true
      fx.tornado?.(t)
    }
    if (H.gusts) {
      const n = this.windDmg.tornadoLoad(
        (b) => H.gustAt(b.cx, b.cz, Math.max(b.fw, b.fd) / 2),
        (tr) => H.gustAt(cellToWorld(tr.i) + tr.ox, cellToWorld(tr.j) + tr.oz),
        1 / 60,
      )
      H.gusts.T.damaged += n
    }
    this.stepTyFire(1 / 60)
  }

  /** What a lightning leader over (x0, z0) could attach to: roofs, trees and poles (see strikePoint). */
  strikeCandidates(x0, z0) {
    const { city } = this
    const R = STRIKE_R + 40
    const out = []
    for (const b of city.buildings) {
      if (b.removed || Math.abs(b.cx - x0) > R + b.fw || Math.abs(b.cz - z0) > R + b.fd) continue
      if (this.windDmg.st.get(b.id)?.collapsed || this.impact.st.get(b.id)?.collapsed) continue
      out.push({ kind: 'building', ref: b, x: b.cx, z: b.cz, y: b.base + b.elevated + b.height, r: Math.min(b.fw, b.fd) / 2 })
    }
    for (const t of city.trees) {
      if (t.fallen || t.burnt) continue
      const x = cellToWorld(t.i) + t.ox
      const z = cellToWorld(t.j) + t.oz
      if (Math.abs(x - x0) > R || Math.abs(z - z0) > R) continue
      out.push({ kind: 'tree', ref: t, x, z, y: cityGroundAt(city, x, z) + 5 + 5 * t.s, r: 2 })
    }
    for (const p of this.fx.lamps?.() ?? []) {
      if (p.fallen || Math.abs(p.x - x0) > R || Math.abs(p.z - z0) > R) continue
      out.push({ kind: 'pole', ref: p, x: p.x, z: p.z, y: p.y + 7.5, r: 0.3 })
    }
    return out
  }

  /** A cloud-to-ground strike in the district: what it hit and what that did. */
  lightningStrike(hit) {
    const { rng } = this.hazards
    const S = this.storms
    S.strikes++
    this.fx.lightning?.(hit.x, hit.y, hit.z)
    const rain = this.flood.rain
    let text = null
    if (hit.kind === 'building') {
      const b = hit.ref
      const s = this.impact.st.get(b.id)
      const name = BUILDING_TYPES[b.type].name.toLowerCase()
      // the current finds the wiring and the roof timbers; concrete with steel inside mostly takes it to ground
      const pFire = b.construction === 'wood_old' || b.construction === 'wood_mod' ? 0.3 : b.construction === 'urm' ? 0.12 : 0.04
      if (b.rod) text = `Lightning struck the lightning rod on ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name} and went safely to ground.`
      else if (s && !s.burning && !s.burnt && rng.chance(pFire)) {
        this.tyIgnite(b, s, 'lightning')
        text = null
      } else text = `Lightning struck ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}${b.floors >= 6 ? ` (${b.floors} floors), the tallest thing around` : ''}.${rng.chance(0.25) ? ' Its electrics are fried.' : ''}`
      if (!b.rod && rng.chance(0.2)) this.windDmg.feederFault(b.x, b.y, 'lightning')
    } else if (hit.kind === 'tree') {
      const tr = this.tyFire.trees.find((o) => o.t === hit.ref)
      // a soaked tree rarely burns: the bolt splits it instead
      if (tr && !tr.fire && !tr.burnt && rng.chance(0.35 * (1 - 0.7 * smoothstep(3, 25, rain)))) {
        this.tyFire.lightTree(tr)
        text = 'Lightning set a tree on fire.'
      } else {
        text = 'Lightning split a tree.'
        if (rng.chance(0.4) && !hit.ref.fallen) {
          hit.ref.fallen = { ax: Math.random() - 0.5, az: Math.random() - 0.5, th: 1.35 }
          this.fx.treesDown?.()
        }
      }
    } else if (hit.kind === 'pole') {
      text = 'Lightning hit a street light and blew the transformer on its line.'
      this.windDmg.feederFault(Math.floor((hit.x + HALF) / CELL), Math.floor((hit.z + HALF) / CELL), 'lightning')
    }
    this.fx.windChanged?.()
    if (text && S.logged < 6) {
      S.logged++
      this.log(this.time, text, 'warn')
    }
  }

  /** A building catches fire (lightning, radiant heat, embers, a burning tree); most people get out. */
  tyIgnite(b, s, how) {
    if (s.burning || s.burnt) return
    this.tyFire.ignite(b, s)
    this.storms.fires++
    const out = s.present * 0.85
    s.present -= out
    s.evacuated += out
    this.impact.placeEvacuees(out, this.impact.shelters)
    if (this.storms.fires > 8) return
    const name = BUILDING_TYPES[b.type].name.toLowerCase()
    const a = /^[aeiou]/.test(name) ? 'an' : 'a'
    const text = {
      lightning: `Lightning set ${a} ${name} on fire.`,
      radiant: `Fire spread to ${a} ${name} next door.`,
      embers: `Wind-blown embers set ${a} ${name} on fire.`,
      tree: `A burning tree set ${a} ${name} on fire.`,
    }[how] ?? `Fire broke out in ${a} ${name}.`
    this.log(this.time, `${text} ${this.flood.rain > 5 ? 'The rain is helping to hold it back.' : 'Fire crews cannot get out in this wind.'}`, 'bad')
  }

  /** Fires during a typhoon: the rain soaks them and crews can't go out, so most go out by themselves. Sets fireDirty when there is fire to draw. */
  stepTyFire(dtH) {
    const F = this.tyFire
    const st = this.impact.st
    const rain = this.flood.rain
    const now = this.typhoon.now
    // the wind leans the flames and carries embers — but wet embers rarely light anything
    F.wind = { dir: Math.atan2(-now.dir[1], now.dir[0]), speed: Math.min(15, now.wind * 0.5) * (1 - 0.85 * smoothstep(1, 12, rain)) }
    let any = false
    for (const s of st.values()) if (s.burning) any = true
    if (!any && !F.trees.some((t) => t.fire)) return
    const ext = () => 0.4 + rain / 5
    const was = new Set()
    for (const [id, s] of st) if (s.burning) was.add(id)
    F.step(dtH, st, ext, (o, os, how) => this.tyIgnite(o, os, how))
    for (const id of was) {
      const s = st.get(id)
      if (s.burning || !s.burnt) continue
      const b = this.city.byId.get(id)
      this.impact.kill(b, s, s.present * 0.05, 'fire')
      this.log(this.time, `A ${BUILDING_TYPES[b.type].name.toLowerCase()} has burnt out.`, 'bad')
    }
    this.fireDirty = true
  }

  // ----------------------------------------------------------------- the record
  /** Who in a zone (FloodImpact.zonesOf) had left under an order, against how many were there. */
  zoneTally(zone) {
    let start = 0
    let gone = 0
    for (const b of this.zoneB[zone]) {
      const s = this.impact.st.get(b.id)
      start += s.start
      gone += s.gone
    }
    return { start, gone }
  }

  /** Every five simulated minutes: note when each hazard arrived and each defence first gave way. */
  record() {
    const M = this.marks
    const t = this.time
    const ty = this.typhoon
    const f = this.flood
    const mark = (k, cond) => {
      if (cond && M[k] == null) M[k] = t
    }
    mark('gale', ty.now.kmh10 >= 62)
    mark('stormForce', ty.now.kmh10 >= 89)
    mark('seaAshore', !!this.city.coast && (ty.now.sea?.level ?? -9) > ty.shoreRise)
    mark('flooding', this.impact.flooding())
    mark('homesFlooded', this.city.buildings.some((b) => b.type !== 'shelter' && (this.impact.st.get(b.id)?.dIn ?? 0) > 0.3))
    mark('overtop', f.stage > 0)
    // the drains backing up: the river or the sea over their outfalls while it is still raining hard
    mark('drains', (f.drainEff ?? 1) < 0.5 && f.rain > 10)
    mark('breach', this.impact.lastBreachLog != null)
    mark('pumpDrowned', f.pumps.some((p) => p.failed))
    mark('gateShut', !!f.gateClosed)
    // the share of each zone that had got out by the time the hazard reached its first home
    for (const [z, hit] of Object.entries(ZONE_HIT)) {
      if (M[z] != null || !this.zoneB[z].some((b) => hit(this.impact.st.get(b.id), this.windDmg.st.get(b.id)))) continue
      M[z] = t
      const T = this.zoneTally(z)
      this.zoneShare[z] = T.start > 0 ? T.gone / T.start : null
    }
    if (t >= this.powerTl.length * 3600) this.powerTl.push(this.windDmg.poweredShare())
  }

  /**
   * Losses by the hazard that did most of the damage to each building:
   * wind (roofs, windows, flattened), coast (seawater) or water (rain and river).
   */
  lossSplit() {
    const out = { wind: 0, water: 0, coast: 0 }
    const W = this.windDmg
    for (const b of this.city.buildings) {
      const s = this.impact.st.get(b.id)
      if (!s) continue
      const w = W.st.get(b.id)
      const windF = !w ? 0 : w.byWind ? 1 : w.roof ? 0.3 : w.cover ? 0.1 : w.glass ? 0.04 : 0
      const share = Math.min(1, Math.ceil(s.maxIn / b.floorH) / b.floors)
      const waterF = s.collapsed && !w?.byWind ? 1 : Math.min(1, 0.33 * Math.sqrt(s.maxIn)) * share
      const f = s.burnt ? 1 : Math.max(windF, waterF)
      if (f <= 0) continue
      out[windF >= waterF ? 'wind' : s.sea ? 'coast' : 'water'] += b.value * f
    }
    return out
  }

  /** What the storm left: the numbers the after-action report compares. Plain data (it crosses from the worker). */
  summary() {
    const { city, impact: im, windDmg: W, flood: f, typhoon: ty } = this
    const T = im.totals()
    let wetCells = 0
    for (let k = 0; k < GRID * GRID; k++) if (!city.sea?.[k] && city.cellType[k] !== CELL_RIVER && f.maxH[k] > 0.3) wetCells++
    let seaBuildings = 0
    let uninhabitable = { roof: 0, flood: 0, destroyed: 0 }
    let debris = 0
    let shelterCap = 0
    const lossByClass = {}
    for (const b of city.buildings) {
      const s = im.st.get(b.id)
      if (!s) continue
      if (b.type === 'shelter') shelterCap += b.capacity || 0
      const w = W.st.get(b.id)
      if (s.sea && s.maxIn > 0.3) seaBuildings++
      const people = b.residents || 0
      if (s.collapsed || s.burnt || w?.byWind) uninhabitable.destroyed += people
      else if (w?.roof) uninhabitable.roof += people
      else if (s.maxIn > 0.5) uninhabitable.flood += people
      const foot = b.fw * b.fd
      if (s.collapsed || s.burnt || w?.byWind) debris += foot * b.floors * (WRECK_DEBRIS[b.construction] ?? 0.6)
      else if (w?.roof) debris += foot * ROOF_DEBRIS
      else if (w?.cover) debris += foot * ROOF_DEBRIS * 0.3
      const windF = !w ? 0 : w.byWind ? 1 : w.roof ? 0.3 : w.cover ? 0.1 : w.glass ? 0.04 : 0
      const share = Math.min(1, Math.ceil(s.maxIn / b.floorH) / b.floors)
      const lf = s.collapsed || s.burnt ? 1 : Math.max(windF, Math.min(1, 0.33 * Math.sqrt(s.maxIn)) * share)
      if (lf > 0) lossByClass[b.construction] = (lossByClass[b.construction] || 0) + b.value * lf
    }
    // fallen trees: ~1 t of wood and branches each
    debris += W.stats.trees
    const S = W.stats
    return {
      time: this.time,
      dead: T.dead,
      injured: T.injured,
      flooded: T.flooded,
      destroyed: T.destroyed,
      loss: T.loss,
      displaced: T.displaced,
      evacuated: T.evacuated,
      rescued: T.rescued,
      causes: { ...im.deathsByCause },
      deadShelter: im.deathsByType.shelter || 0,
      lossSplit: this.lossSplit(),
      lossByClass,
      wind: { roof: S.roof, cover: S.cover, glass: S.glass, collapsed: S.collapsed, trees: S.trees, roads: W.treeBlocked.size, poles: S.poles, missiles: S.missiles, missileGlass: S.missileGlass },
      power: { now: W.poweredShare(), min: Math.min(1, ...this.powerTl, W.poweredShare()), gridUp: W.gridUp, tl: [...this.powerTl], feedersDown: W.feeders.filter((q) => !q.up).length, feeders: W.feeders.length },
      water: {
        stageMax: f.stageMax,
        seaMax: f.coast ? f.seaMax : null,
        haFlooded: (wetCells * CELL * CELL) / 1e4,
        seaBuildings,
        pumps: f.pumps.length,
        pumpsDrowned: f.pumps.filter((p) => p.failed).length,
        pumpsDark: f.pumps.filter((p) => p.unpowered && !p.generator && !p.failed).length,
        diverted: f.floodway ? f.divertedVol : 0,
        cumRain: f.cumRain,
      },
      marks: { ...this.marks },
      zoneShare: { ...this.zoneShare },
      zonePeople: { ...this.zonePeople },
      steps: this.steps.map((s) => ({ ...s })),
      warned: im.warnTime,
      waded: im.waded || 0,
      crowdHours: im.crowdHours,
      shelterCap,
      uninhabitable,
      debris,
      strikes: this.storms.strikes,
      fires: this.storms.fires,
      peakGust: ty.peak.gust,
      startH: ty.startH,
      poles: this.U.poles || 0,
      resettled: city.resettled || 0,
    }
  }
}
