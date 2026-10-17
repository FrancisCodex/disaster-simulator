// Earthquake scenario: ground motion (attenuation + soil + duration),
// lognormal fragility curves, casualties, aftershocks (Reasenberg & Jones
// 1989), post-quake fires, search & rescue and hospital surge.

import { GRID, CELL, CONSTRUCTION, FRAGILITY_BETA, QUAKE_CASUALTY, QUAKE_CASUALTY_COLLAPSE, BUILDING_TYPES, DAMAGE_STATES } from './config.js'
import { occupancyAt, idx } from './cityGen.js'
import { normCdf, clamp } from './math.js'

// Campbell (1997)-style attenuation, mean horizontal PGA on rock (g).
export function pgaRock(M, R) {
  const f = 0.149 * Math.exp(0.647 * M)
  return Math.exp(-3.512 + 0.904 * M - 1.328 * Math.log(Math.sqrt(R * R + f * f)))
}
// Significant shaking duration grows quickly with magnitude.
export const shakingDuration = (M) => Math.pow(10, 0.5 * M - 2.2)
export const durationFactor = (M) => clamp(Math.pow(shakingDuration(M) / 15, 0.25), 0.6, 3)
export function soilAmp(soil, pga) {
  if (soil === 0) return 0.9
  if (soil === 1) return 1.15
  return Math.max(1.0, 1.6 - 0.8 * pga) // soft soils amplify weak motion, saturate under strong
}
const SOIL_NAMES = ['Rock', 'Stiff soil', 'Soft alluvium (liquefiable)']
export const soilName = (s) => SOIL_NAMES[s]

/** Effective damaging intensity (PGA-equivalent, g) at a building. */
export function demand(b, soil, M, R) {
  const rock = pgaRock(M, R)
  let p = rock * soilAmp(soil, rock) * durationFactor(M)
  if (M > 9.3) p *= 1 + (M - 9.3) * 0.8 // ground failure, metres of permanent offset
  if (b.floors >= 10) p *= 1 + 0.15 * Math.max(0, M - 7) * Math.min(1.2, 0.5 + (b.floors - 10) / 20) // long-period resonance
  if (soil === 2 && M >= 6 && p > 0.2) p *= 1.15 // liquefaction settlement
  return p
}

export function mediansFor(b, M, ds = 0) {
  const C = CONSTRUCTION[b.construction]
  const dmg = [1, 0.85, 0.65, 0.45, 0.45][ds]
  let iso = 1
  if (b.construction === 'isolated' && M > 8.5) iso = clamp(1 - (M - 8.5) * 0.45, 0.3, 1) // isolator displacement limits
  return C.medians.map((m) => m * dmg * iso)
}

/** Probability of reaching each damage state ≥1..4 */
export function damageProbs(p, med) {
  return med.map((m) => normCdf(Math.log(p / m) / FRAGILITY_BETA))
}

export function collapseProb(b, p, med) {
  const C = CONSTRUCTION[b.construction]
  const over = Math.max(1, p / med[3])
  const tall = b.floors > 15 ? 1.5 : 1
  return Math.min(0.9, C.collapse * Math.pow(over, 1.5) * tall)
}

export function cellOfBuilding(b) {
  return idx(b.x + Math.floor(b.w / 2), b.y + Math.floor(b.d / 2))
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export class QuakeSim {
  constructor(city, level, { warning = false, gasShutoff = false, startHour = 8, rng }) {
    this.city = city
    this.level = level
    this.rng = rng
    this.warning = warning
    this.gasShutoff = gasShutoff
    this.time = 0
    this.mainTime = 25
    this.mainDone = false
    const az = rng.float(0, Math.PI * 2)
    this.main = { M: level.M, dist: level.dist, depth: level.depth, az, R: Math.hypot(level.dist, level.depth), main: true }
    this.ruptureLen = Math.min(1200, Math.pow(10, -2.44 + 0.59 * level.M))
    this.shocks = []
    this.events = []
    this.pending = [] // visual shock events for the renderer
    this.st = new Map()
    this.population = 0
    for (const b of city.buildings) {
      if (b.removed) continue
      const present = occupancyAt(b, startHour)
      this.population += present
      this.st.set(b.id, { present, ds: 0, collapsed: false, dead: 0, trapped: 0, crit: 0, minor: 0, burning: 0, burnt: false, outside: 0 })
    }
    this.untreated = 0
    this.treated = 0
    this.rescued = 0
    this.bedsUsed = 0
    this.deathsByCause = { collapse: 0, damage: 0, trapped: 0, injuries: 0, fire: 0 }
    this.deathsByClass = {}
    this.waterOk = 1
    this.fires = 0
    this.neighbors = null
  }

  log(text, level = 'info') {
    this.events.push({ t: this.time, text, level })
  }

  update(dt) {
    const t0 = this.time
    const t1 = t0 + dt
    this.time = t1
    if (!this.mainDone && t1 >= this.mainTime) {
      this.mainDone = true
      const dir = DIRS[Math.round((this.main.az / (Math.PI * 2)) * 8) % 8]
      const r = this.applyShock(this.main)
      this.log(
        `M${this.main.M.toFixed(1)} earthquake — epicentre ${this.main.dist} km ${dir}, depth ${this.main.depth} km. Shaking ≈ ${r.pga.toFixed(2)} g in the city for ~${Math.round(shakingDuration(this.main.M))} s.`,
        'bad',
      )
      if (r.pga > 0.5) {
        this.waterOk = 0.5
        this.log('Water mains ruptured — fire-fighting pressure reduced by half.', 'warn')
      }
      this.reportShock(r)
    }
    if (this.mainDone) {
      this.sampleAftershocks(t0 - this.mainTime, t1 - this.mainTime)
      this.dynamics(dt / 3600)
    }
  }

  reportShock(r) {
    if (r.collapses) this.log(`${r.collapses} building${r.collapses > 1 ? 's' : ''} collapsed, ${r.heavy} more heavily damaged.`, 'bad')
    else if (r.heavy) this.log(`${r.heavy} buildings heavily damaged; no collapses.`, 'warn')
    else if (r.any) this.log(`${r.any} buildings with light damage.`, 'info')
    for (const b of r.notable) this.log(`${BUILDING_TYPES[b.type].name} collapsed (${b.floors} floors, ${CONSTRUCTION[b.construction].short}).`, 'bad')
  }

  sampleAftershocks(a, b) {
    if (b <= 0) return
    const Mm = this.main.M
    const Mmin = Math.max(4, Mm - 3)
    if (Mmin > Mm - 0.5) return
    const day = 86400
    const ta = Math.max(0, a) / day
    const tb = b / day
    const c = 0.05
    const p = 1.08
    const A = Math.pow(10, -1.67 + 0.91 * (Mm - Mmin))
    const integral = (Math.pow(tb + c, 1 - p) - Math.pow(ta + c, 1 - p)) / (1 - p)
    const n = this.rng.poisson(A * integral)
    const bGR = 0.91
    const Mmax = Mm - 0.3
    for (let q = 0; q < n; q++) {
      const u = this.rng.next()
      const M = Mmin - Math.log10(1 - u * (1 - Math.pow(10, -bGR * (Mmax - Mmin)))) / bGR
      const along = (this.rng.next() - 0.5) * this.ruptureLen
      const dist = Math.max(4, Math.abs(this.main.dist + along * 0.6))
      const shock = { M, dist, depth: 10, R: Math.hypot(dist, 10), main: false }
      const r = this.applyShock(shock)
      if (M >= 5 || r.collapses) {
        this.log(`M${M.toFixed(1)} aftershock (${dist.toFixed(0)} km away, ≈${r.pga.toFixed(2)} g).`, M >= 6 ? 'bad' : 'warn')
        this.reportShock(r)
      }
    }
  }

  applyShock(shock) {
    const { city, rng } = this
    let pgaSum = 0
    let n = 0
    let collapses = 0
    let heavy = 0
    let any = 0
    const notable = []
    const vis = { M: shock.M, main: shock.main, pga: 0, collapses: [], damaged: [] }
    for (const b of city.buildings) {
      if (b.removed) continue
      const s = this.st.get(b.id)
      if (!s || s.collapsed) continue
      const soil = city.soil[cellOfBuilding(b)]
      const p = demand(b, soil, shock.M, shock.R) * Math.exp(rng.normal() * 0.25)
      pgaSum += p / (b.floors >= 10 ? 1.3 : 1)
      n++
      const med = mediansFor(b, shock.M, s.ds)
      const probs = damageProbs(p, med)
      const u = rng.next()
      let ds = 0
      for (let k = 3; k >= 0; k--)
        if (u < probs[k]) {
          ds = k + 1
          break
        }
      if (ds <= s.ds) continue
      const old = s.ds
      s.ds = ds
      let collapsed = false
      if (ds === 4 && rng.chance(collapseProb(b, p, med))) {
        collapsed = true
        s.collapsed = true
        collapses++
        if (b.floors >= 4 || BUILDING_TYPES[b.type].facility) notable.push(b)
      } else if (ds >= 3) heavy++
      else any++
      this.casualties(b, s, old, ds, collapsed)
      if (ds >= 3) this.maybeIgnite(b, s, ds)
      if (collapsed) vis.collapses.push(b.id)
      else vis.damaged.push(b.id)
      if (shock.main && ds >= 2) {
        // people leave damaged buildings once the shaking stops
        s.outside += s.present
        s.present = 0
      }
    }
    if (notable.length > 6) notable.length = 6
    vis.pga = n ? pgaSum / n : 0
    this.shocks.push({ ...shock, t: this.time, pga: vis.pga })
    this.pending.push(vis)
    return { pga: vis.pga, collapses, heavy, any, notable }
  }

  casualties(b, s, oldDs, ds, collapsed) {
    const rates = collapsed ? QUAKE_CASUALTY_COLLAPSE : QUAKE_CASUALTY[ds].map((r, i) => Math.max(0, r - QUAKE_CASUALTY[oldDs][i]))
    const ew = this.warning ? 0.8 : 1
    const P = s.present
    if (P <= 0) return
    const dead = P * rates[0] * ew
    const trapped = P * rates[1] * (this.warning ? 0.9 : 1)
    const crit = P * rates[2] * ew
    const minor = P * rates[3]
    s.present = Math.max(0, P - dead - trapped - crit - minor)
    s.trapped += trapped
    s.minor += minor
    this.untreated += crit
    s.crit += crit
    this.addDeaths(b, s, dead, collapsed ? 'collapse' : 'damage')
  }

  addDeaths(b, s, n, cause) {
    if (n <= 0) return
    s.dead += n
    this.deathsByCause[cause] += n
    this.deathsByClass[b.construction] = (this.deathsByClass[b.construction] || 0) + n
  }

  maybeIgnite(b, s, ds) {
    if (s.burning || s.burnt) return
    const C = CONSTRUCTION[b.construction]
    let p = 0.012 * (ds === 4 ? 1.8 : 1) * (C.fire > 0.2 ? 1.5 : 1) * (this.gasShutoff ? 0.4 : 1)
    p *= Math.min(3, 0.5 + b.area / 4000)
    if (this.rng.chance(p)) this.ignite(b, s)
  }

  ignite(b, s) {
    s.burning = 0.001
    this.fires++
    if (this.fires <= 12) this.log(`Fire broke out in a ${BUILDING_TYPES[b.type].name.toLowerCase()}.`, 'warn')
  }

  buildNeighbors() {
    const { city } = this
    const grid = city.buildingAt
    this.neighbors = new Map()
    for (const b of city.buildings) {
      if (b.removed) continue
      const set = new Set()
      for (let j = b.y - 2; j < b.y + b.d + 2; j++)
        for (let i = b.x - 2; i < b.x + b.w + 2; i++) {
          if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue
          const id = grid[idx(i, j)]
          if (id >= 0 && id !== b.id) set.add(id)
        }
      this.neighbors.set(b.id, [...set])
    }
  }

  facilityFactor(b) {
    const s = this.st.get(b.id)
    if (!s || s.collapsed || s.burning || s.burnt) return 0
    return s.ds <= 2 ? 1 : s.ds === 3 ? 0.4 : 0
  }

  dynamics(dtH) {
    const { city, rng } = this
    const hoursSince = Math.max(0, (this.time - this.mainTime) / 3600)
    if (!this.neighbors) this.buildNeighbors()

    // ---- facilities
    const stations = []
    let hospThroughput = 0
    let beds = 0
    for (const b of city.buildings) {
      if (b.removed) continue
      if (b.type === 'fire') {
        const f = this.facilityFactor(b)
        if (f > 0) stations.push({ b, f })
      } else if (b.type === 'hospital') {
        const f = this.facilityFactor(b)
        hospThroughput += 25 * f
        beds += b.beds * 0.6 * f
      }
    }

    // ---- trapped victims: survival declines with time, rescue pulls them out
    let totalTrapped = 0
    for (const s of this.st.values()) totalTrapped += s.trapped
    if (totalTrapped > 0.01) {
      const community = totalTrapped * (hoursSince < 12 ? 0.05 : 0.015)
      let usar = 0
      for (const st of stations) usar += 6 * st.f
      let rescueCap = (community + usar) * dtH
      const lambda = Math.min(0.12, 0.015 + 0.0012 * hoursSince)
      const frac = Math.min(1, rescueCap / totalTrapped)
      for (const [id, s] of this.st) {
        if (s.trapped <= 0) continue
        const b = city.byId.get(id)
        const die = s.trapped * (1 - Math.exp(-lambda * dtH))
        s.trapped -= die
        this.addDeaths(b, s, die, 'trapped')
        const res = s.trapped * frac
        s.trapped -= res
        this.rescued += res
        this.untreated += res * 0.4
        s.crit += res * 0.4
        s.minor += res * 0.6
      }
    }

    // ---- critically injured: hospital surge capacity
    if (this.untreated > 0.01) {
      const room = Math.max(0, beds - this.bedsUsed)
      const admit = Math.min(this.untreated, hospThroughput * dtH, room)
      this.untreated -= admit
      this.treated += admit
      this.bedsUsed += admit
      this.addDeathsGlobal(admit * 0.03)
      const lam = hoursSince < 6 ? 0.02 : 0.045
      const die = this.untreated * (1 - Math.exp(-lam * dtH))
      this.untreated -= die
      this.addDeathsGlobal(die)
    }

    // ---- fires
    for (const b of city.buildings) {
      const s = this.st.get(b.id)
      if (!s || !s.burning) continue
      s.burning += dtH
      if (s.trapped > 0 && s.burning > 0.3) {
        const n = s.trapped
        s.trapped = 0
        this.addDeaths(b, s, n, 'fire')
      }
      if (s.present > 0) {
        this.addDeaths(b, s, s.present * 0.01, 'fire')
        s.outside += s.present * 0.99
        s.present = 0
      }
      // suppression
      let inRange = 0
      for (const st of stations) if (Math.hypot(st.b.x - b.x, st.b.y - b.y) < 50) inRange += st.f
      const ext = Math.min(0.85, 0.3 * Math.min(inRange, 2.5) * this.waterOk)
      if (rng.chance(clamp(ext * dtH, 0, 1))) {
        s.burning = 0
        if (s.ds < 3) s.ds = 3
        continue
      }
      // spread
      for (const nid of this.neighbors.get(b.id) || []) {
        const nb = city.byId.get(nid)
        const ns = this.st.get(nid)
        if (!nb || !ns || ns.burning || ns.burnt) continue
        const p = CONSTRUCTION[nb.construction].fire * (1 - ext * 0.7)
        if (rng.chance(clamp(p * dtH, 0, 1))) this.ignite(nb, ns)
      }
      if (s.burning > 3) {
        s.burning = 0
        s.burnt = true
        s.ds = 4
      }
    }
  }

  addDeathsGlobal(n) {
    if (n <= 0) return
    this.deathsByCause.injuries += n
    this.globalDead = (this.globalDead || 0) + n
  }

  totals() {
    let dead = this.globalDead || 0
    let trapped = 0
    let minor = 0
    let crit = 0
    let damaged = 0
    let destroyed = 0
    let loss = 0
    let displaced = 0
    let burning = 0
    const byDs = [0, 0, 0, 0, 0]
    for (const b of this.city.buildings) {
      const s = this.st.get(b.id)
      if (!s) continue
      dead += s.dead
      trapped += s.trapped
      minor += s.minor
      crit += s.crit
      byDs[s.ds]++
      if (s.ds >= 2) damaged++
      if (s.collapsed || s.burnt || s.ds === 4) destroyed++
      if (s.ds >= 3 || s.burnt) displaced += b.residents
      if (s.burning) burning++
      loss += b.value * [0, 0.02, 0.1, 0.5, 1][s.collapsed || s.burnt ? 4 : s.ds]
    }
    return {
      dead,
      trapped,
      injured: minor + crit,
      critUntreated: this.untreated,
      treated: this.treated,
      rescued: this.rescued,
      damaged,
      destroyed,
      loss,
      displaced,
      burning,
      byDs,
    }
  }
}

export { DAMAGE_STATES, CELL }
