// Earthquake scenario: ground motion (attenuation + soil + duration),
// lognormal fragility curves, cumulative structural damage (each building
// keeps an integrity score that fatigue, ground failure, debris and fire wear
// down, so weakened buildings fail in later aftershocks or under their own
// weight), casualties, aftershocks (Reasenberg & Jones 1989), post-quake
// fires, search & rescue and hospital surge.

import { GRID, CELL, CONSTRUCTION, FRAGILITY_BETA, QUAKE_CASUALTY, QUAKE_CASUALTY_COLLAPSE, BUILDING_TYPES, DAMAGE_STATES } from './config.js'
import { occupancyAt, idx } from './cityGen.js'
import { GroundFailure } from './groundFailure.js'
import { FireSim } from './fireSim.js'
import { normCdf, clamp } from './math.js'
import { sourceParams, faultGeometry, siteDistances, rockPga, siteFactor, gmpeFor, MECHANISMS, SOIL_VS30 } from './quakePhysics.js'

/** World position (m) → district coordinates (km) used by the fault geometry. */
const km = (m) => m / 1000

/** Median rock PGA (g) at world position (x, z) in metres for an event with geometry. */
export function rockPgaAt(ev, x, z) {
  return rockPga(ev, siteDistances(ev.geo, km(x), km(z)))
}

/** Attach rupture size and fault geometry to an event {M, depth, dist, az, mech, strike, rupture}. */
export function withGeometry(ev) {
  const src = sourceParams(ev)
  return { ...ev, src, geo: faultGeometry(ev, src) }
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

/**
 * Fundamental period of a building (s): the approximate period of ASCE 7
 * (§12.8.2.1), T = Ct·hⁿ, for its structural system. Stiff masonry and
 * wood-frame houses ring at a tenth of a second or so; a 100 m concrete tower
 * sways back and forth every ~3 s.
 */
export function buildingPeriod(b) {
  const h = Math.max(3, b.height)
  switch (b.construction) {
    case 'steel':
      return 0.0724 * h ** 0.8
    case 'isolated':
      return Math.max(2, 0.0466 * h ** 0.9) // the isolators stretch the period out
    case 'urm':
    case 'wood_old':
    case 'wood':
      return 0.0488 * h ** 0.75
    default:
      return 0.0466 * h ** 0.9 // reinforced-concrete frame
  }
}

// the shaking the fragility curves were fitted to: a moderate event at a few tens of km
const T_REF = 0.45

/**
 * Predominant (mean) period of the ground motion (s), after Rathje et al.
 * (1998): bigger and more distant earthquakes shake more slowly, and soft
 * soils lengthen it further. freq (Hz) overrides it (the scenario slider).
 */
export function groundPeriod(M, rjb, soil, freq = null) {
  if (freq) return 1 / freq
  const Mm = Math.min(M, 7.25)
  let T = 0.411 + 0.0837 * (Mm - 6) + 0.00208 * rjb + 0.12 * Math.max(0, M - 7.25)
  T *= [0.85, 1.15, 1.6][soil] ?? 1
  return clamp(T, 0.08, 3)
}

/**
 * Spectral acceleration of a 5 %-damped building of period T, relative to
 * peak ground acceleration, in shaking of predominant period Tm: buildings
 * whose own period lies near the ground's resonate (up to ~2.5× PGA); much
 * stiffer ones just ride the ground, much softer ones are left behind by it.
 */
export function spectralShape(T, Tm) {
  const x = Math.log(T / Tm)
  const peak = 2.5 * Math.exp(-(x * x) / (2 * 0.55 * 0.55))
  const floor = T < Tm ? 1 : Math.pow(Tm / T, 0.9)
  return Math.max(floor, peak)
}

/**
 * How much harder (or easier) this shaking is on building b than the shaking
 * its fragility curves were calibrated with: short, stiff buildings suffer in
 * fast, jerky shaking; tall ones in slow, rolling shaking.
 */
export function resonance(b, Tm) {
  const T = buildingPeriod(b)
  return clamp(Math.pow(spectralShape(T, Tm) / spectralShape(T, T_REF), 0.8), 0.5, 1.5)
}

/**
 * Effective damaging intensity (PGA-equivalent, g) at a building, from the
 * median rock PGA there. This is a structural demand index, not the measured
 * PGA: soft soils amplify the longer-period motion that damages buildings even
 * where they de-amplify peak acceleration, long shaking does more damage, and
 * buildings in resonance with the ground take more of it (Tm: the ground's
 * predominant period; without it, a crude long-period term for tall ones).
 */
export function demand(b, soil, M, rock, Tm = null) {
  let p = rock * soilAmp(soil, rock) * durationFactor(M)
  if (M > 9.3) p *= 1 + (M - 9.3) * 0.8 // ground failure, metres of permanent offset
  if (Tm) p *= resonance(b, Tm)
  else if (b.floors >= 10) p *= 1 + 0.15 * Math.max(0, M - 7) * Math.min(1.2, 0.5 + (b.floors - 10) / 20) // long-period resonance
  if (soil === 2 && M >= 6 && p > 0.2) p *= 1.15 // liquefaction settlement
  return p
}

/**
 * Geometry. Tall, slender frames carry large overturning moments, P-Δ
 * (gravity acting through the lateral drift) and higher-mode demands; squat,
 * wide buildings have more redundant frame lines and drift less for the same
 * shaking. cap scales the fragility medians, coll the collapse odds.
 */
export function shapeOf(b) {
  const H = b.height
  const B = Math.max(4, Math.min(b.fw, b.fd))
  const slender = H / B
  const redundancy = clamp(0.94 + 0.05 * Math.log2(Math.max(25, b.fw * b.fd) / 150), 0.9, 1.08)
  const cap = clamp(1.1 - 0.05 * Math.max(0, slender - 1), 0.75, 1.1) * redundancy
  const coll = clamp(0.8 + 0.12 * (slender - 1), 0.7, 2)
  // rigid-body tipping angle; a leaning building overturns well before it
  const tip = Math.atan(B / H)
  return { H, B, slender, cap, coll, tip }
}

// Cumulative damage index D: 0 intact, ≈0.8 complete damage, 1 structural failure.
// Lower bounds of D for each damage state, and the state implied by D.
export const DS_FLOOR = [0, 0.03, 0.12, 0.35, 0.6]
export const D_FAIL = 1
const D_MAX = 1.5
export const dsFromD = (D) => (D >= DS_FLOOR[4] ? 4 : D >= DS_FLOOR[3] ? 3 : D >= DS_FLOOR[2] ? 2 : D >= DS_FLOOR[1] ? 1 : 0)
/**
 * Strength and stiffness left after damage (cracked concrete, buckled bars,
 * loosened masonry). Squat buildings shed load to undamaged walls and frame
 * lines; slender ones have few load paths and lose strength faster.
 */
export const residual = (D, sh) => Math.max(0.3, 1 - 0.6 * D * (sh ? clamp(0.4 + 0.3 * sh.slender, 0.55, 1.4) : 1))

export function mediansFor(b, M, D = 0) {
  const C = CONSTRUCTION[b.construction]
  let iso = 1
  if (b.construction === 'isolated' && M > 8.5) iso = clamp(1 - (M - 8.5) * 0.45, 0.3, 1) // isolator displacement limits
  const sh = shapeOf(b)
  const k = residual(D, sh) * iso * sh.cap
  return C.medians.map((m) => m * k)
}

/** Probability of reaching each damage state ≥1..4 */
export function damageProbs(p, med) {
  return med.map((m) => normCdf(Math.log(p / m) / FRAGILITY_BETA))
}

export function collapseProb(b, p, med, D = 0) {
  const C = CONSTRUCTION[b.construction]
  const over = Math.max(1, p / med[3])
  const worn = 1 + 1.5 * Math.max(0, D - 0.6)
  return Math.min(0.95, C.collapse * Math.pow(over, 1.5) * shapeOf(b).coll * worn)
}

/**
 * Low-cycle fatigue (Miner's rule on a Park–Ang style index): every shock
 * that drives the frame past yield uses up some of its hysteretic capacity.
 * Long shaking means more large cycles; slender frames see more of them.
 */
export function fatigueDamage(b, p, med, M) {
  const y = med[0] * 0.6
  if (p <= y) return 0
  const r = Math.min(1.5, (p - y) / Math.max(0.05, med[3] - y))
  const cycles = clamp(Math.sqrt(shakingDuration(M) / 25), 0.35, 2.2)
  const pDelta = clamp(0.6 + 0.3 * shapeOf(b).slender, 0.6, 2.5)
  return 0.2 * CONSTRUCTION[b.construction].fatigue * cycles * r * r * pDelta
}

export function cellOfBuilding(b) {
  return idx(b.x + Math.floor(b.w / 2), b.y + Math.floor(b.d / 2))
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
/** Compass direction of the epicentre (az: +x east, +z south, as in the cut-away view). */
export const compass = (az) => DIRS[(Math.round(((Math.atan2(Math.cos(az), -Math.sin(az)) / (Math.PI * 2)) * 8) % 8) + 8) % 8]
/** Bearing (deg, clockwise from north) → az; null keeps the seed's random direction. */
export const quakeAzimuth = (ev, randomAz) => (ev.bearing == null ? randomAz : Math.atan2(-Math.cos((ev.bearing * Math.PI) / 180), Math.sin((ev.bearing * Math.PI) / 180)))

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
    // the random draw always happens so the scenario's map seed fixes the epicentre direction
    const az = quakeAzimuth(level, rng.float(0, Math.PI * 2))
    this.main = withGeometry({ mech: 'strike', strike: 90, rupture: 'bilateral', ...level, az, main: true })
    this.gmpe = gmpeFor(this.main)
    this.variability = level.variability !== false
    this.aftershocksOn = level.aftershocks !== false
    this.shocks = []
    this.events = []
    this.pending = [] // visual shock events for the renderer
    this.st = new Map()
    this.population = 0
    for (const b of city.buildings) {
      if (b.removed) continue
      const present = occupancyAt(b, startHour)
      this.population += present
      this.st.set(b.id, {
        present,
        ds: 0,
        D: 0, // cumulative damage index (integrity = 1 − D)
        hits: 0, // shocks that did structural damage
        settle: 0, // m of foundation settlement
        lean: 0, // rad of permanent tilt
        leanAng: rng.float(0, Math.PI * 2),
        collapsed: false,
        dead: 0,
        trapped: 0,
        crit: 0,
        minor: 0,
        burning: 0,
        burnt: false,
        outside: 0,
      })
    }
    // saturated sand everywhere (the scenario's ground setting) liquefies far from the river too
    this.ground = new GroundFailure(city, rng, { wet: level.soil === 'sand' })
    this.bridges = []
    this.moved = new Set() // buildings whose settlement or tilt changed (for the renderer)
    this.lateCollapses = 0 // stood through the main shock, fell later
    this.leaning = 0
    this.weakLogged = 0
    this.untreated = 0
    this.treated = 0
    this.rescued = 0
    this.bedsUsed = 0
    this.deathsByCause = { collapse: 0, damage: 0, trapped: 0, injuries: 0, fire: 0 }
    this.deathsByClass = {}
    this.waterOk = 1
    this.fires = 0
    this.fire = new FireSim(city, rng)
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
      const m = this.main
      const r = this.applyShock(m)
      const mech = (MECHANISMS[m.mech] ?? MECHANISMS.strike).name.toLowerCase()
      this.log(
        `M${m.M.toFixed(1)} ${mech} earthquake${m.title ? ` (${m.title})` : ''} — epicentre ${m.dist.toFixed(0)} km ${compass(m.az)}, ${m.depth} km deep. A ${m.src.L.toFixed(0)} km × ${m.src.W.toFixed(0)} km rupture slipped ~${m.src.slip.toFixed(1)} m, passing ${r.rjb.toFixed(0)} km from the city. Ground shaking ≈ ${r.pga.toFixed(2)} g for ~${Math.round(shakingDuration(m.M))} s.`,
        'bad',
      )
      if (r.pga > 0.4) {
        this.waterOk = 0.5
        this.log('Water mains ruptured — fire-fighting pressure reduced by half.', 'warn')
      }
      this.reportShock(r)
      this.reportGround(r.ground)
    }
    if (this.mainDone) {
      this.sampleAftershocks(t0 - this.mainTime, t1 - this.mainTime)
      this.dynamics(dt / 3600)
    }
  }

  reportShock(r) {
    if (r.collapses)
      this.log(
        `${r.collapses} building${r.collapses > 1 ? 's' : ''} collapsed${r.weakFell ? ` (${r.weakFell === r.collapses ? 'all' : r.weakFell} already weakened by earlier shaking)` : ''}, ${r.heavy} more heavily damaged.`,
        'bad',
      )
    else if (r.heavy) this.log(`${r.heavy} buildings heavily damaged; no collapses.`, 'warn')
    else if (r.any) this.log(`${r.any} buildings with light damage.`, 'info')
    for (const b of r.notable) this.log(`${BUILDING_TYPES[b.type].name} collapsed (${b.floors} floors, ${CONSTRUCTION[b.construction].short}).`, 'bad')
  }

  sampleAftershocks(a, b) {
    if (b <= 0 || !this.aftershocksOn) return
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
      const shock = this.aftershockSource(M)
      const r = this.applyShock(shock)
      if (M >= 5 || r.collapses) {
        this.log(`M${M.toFixed(1)} aftershock (${shock.dist.toFixed(0)} km ${compass(shock.az)}, ${shock.depth.toFixed(0)} km deep, ≈${r.pga.toFixed(2)} g).`, M >= 6 ? 'bad' : 'warn')
        this.reportShock(r)
        this.reportGround(r.ground)
      }
    }
  }

  /**
   * Aftershocks cluster on and around the main rupture (most within one
   * rupture width of it), on faults of the same type and orientation.
   */
  aftershockSource(M) {
    const { rng } = this
    const m = this.main
    const G = m.geo
    const a = G.u0 + (G.u1 - G.u0) * rng.next() + rng.normal() * 0.1 * m.src.L
    const b = G.v0 + (G.v1 - G.v0) * rng.next() + rng.normal() * (0.15 * m.src.W + 3)
    const ex = G.ex + a * G.u[0] + b * G.v[0]
    const ey = G.ey + a * G.u[1] + b * G.v[1]
    const regime = (MECHANISMS[m.mech] ?? MECHANISMS.strike).regime
    const depth = clamp(m.depth + rng.normal() * 5, 2, regime === 'crustal' ? 22 : regime === 'interface' ? 55 : 300)
    const ev = { M, depth, mech: m.mech, dip: m.dip, dist: Math.hypot(ex, ey), az: Math.atan2(ey, ex), main: false }
    const src = sourceParams(ev)
    const proj = src.W * Math.cos((src.dip * Math.PI) / 180)
    ev.src = src
    ev.geo = { ex, ey, u: G.u, v: G.v, u0: -src.L / 2, u1: src.L / 2, v0: -proj / 2, v1: proj / 2, ztor: src.ztor, zbot: src.zbot }
    return ev
  }

  /** Bridge decks on neighbouring rows (the two halves of an avenue) are one bridge. */
  bridgeGroups() {
    if (this._bridgeGroups) return this._bridgeGroups
    const spans = this.city.bridgeSpans || []
    const groups = []
    spans.forEach((sp, n) => {
      const g = groups.find((gr) => gr.some((m) => Math.abs(spans[m].j - sp.j) === 1 && spans[m].i0 <= sp.i1 && sp.i0 <= spans[m].i1))
      if (g) g.push(n)
      else groups.push([n])
    })
    const names = groups.map((g) => {
      const j = g.reduce((s, n) => s + spans[n].j, 0) / g.length
      return j < GRID * 0.4 ? 'northern' : j > GRID * 0.6 ? 'southern' : 'central'
    })
    // two bridges on the same side of town get told apart by order
    const label = names.map((nm, q) => (names.filter((x) => x === nm).length > 1 ? `${nm} bridge #${names.slice(0, q + 1).filter((x) => x === nm).length}` : `${nm} bridge`))
    this._bridgeGroups = groups.map((g, q) => ({ spans: g, name: label[q] }))
    return this._bridgeGroups
  }

  /**
   * Bridges: HAZUS-style fragility for a conventionally designed multi-span
   * girder bridge (medians in spectral acceleration at 1 s, which grows
   * relative to PGA for larger, longer-period earthquakes), weakened by earlier
   * damage, plus unseating when liquefied banks spread and pull the abutments
   * apart (Niigata 1964, Kobe 1995). Returns the spans whose state changed.
   */
  bridgeShock(shock, field) {
    const { city, rng } = this
    const spans = city.bridgeSpans || []
    const changed = []
    const sa1 = clamp(0.35 + 0.15 * (shock.M - 5), 0.3, 1)
    const med = [0.25, 0.35, 0.45, 0.7]
    const G = this.ground
    this.bridgeGroups().forEach((grp, n) => {
      const s = (this.bridges[n] ??= { ds: 0, D: 0, collapsed: false, spread: 0, name: grp.name })
      if (s.collapsed) return
      let a = 0
      let spread = 0
      for (const m of grp.spans) {
        const sp = spans[m]
        for (let i = sp.i0; i <= sp.i1; i++) a = Math.max(a, field[idx(i, sp.j)])
        // the banks under the abutments spreading toward the river
        for (const i of [sp.i0, sp.i0 + 1, sp.i1 - 1, sp.i1]) spread = Math.max(spread, G.spread[idx(i, sp.j)])
      }
      const sa = a * sa1 * (this.variability ? Math.exp(rng.normal() * 0.3) : 1)
      const res = residual(s.D)
      const u = rng.next()
      let ds = 0
      for (let k = 3; k >= 0; k--)
        if (u < normCdf(Math.log(sa / (med[k] * res)) / 0.6)) {
          ds = k + 1
          break
        }
      const dSpread = spread - s.spread
      s.spread = spread
      // abutments pushed toward the channel: bearings and joints first, then the girders lose their seats
      if (spread > 0.2) ds = Math.max(ds, 2)
      if (spread > 0.5) ds = Math.max(ds, 3)
      const D0 = s.D
      s.D = Math.max(s.D + 0.25 * Math.max(0, (sa - med[0] * res) / (med[3] - med[0])) ** 2 + dSpread * 0.4, DS_FLOOR[ds])
      const newDs = Math.max(s.ds, ds, dsFromD(s.D))
      let collapse = false
      if (newDs === 4 && (s.ds < 4 || s.D - D0 > 0.1)) collapse = rng.chance(spread > 1 ? 0.8 : 0.4)
      if (newDs === s.ds && !collapse) return
      s.ds = newDs
      s.collapsed = collapse
      const dropAt = 0.25 + rng.next() * 0.45 // which span falls
      for (const m of grp.spans) {
        spans[m].ds = newDs
        spans[m].collapsed = collapse
        if (collapse) spans[m].dropAt = dropAt
        changed.push(m)
      }
      const sp = spans[grp.spans[0]]
      const len = (sp.i1 - sp.i0) * CELL
      const what = `the ${grp.name} (${len.toFixed(0)} m)`
      if (collapse) this.log(`A span of ${what} collapsed into the river${spread > 1 ? ' — the liquefied banks spread and pulled its supports apart' : ''}. The crossing is cut.`, 'bad')
      else if (newDs >= 3) this.log(`${what[0].toUpperCase()}${what.slice(1)} is badly damaged${spread > 0.5 ? ' (its abutments moved with the spreading banks)' : ''} and has been closed.`, 'warn')
      else if (newDs === 2) this.log(`${what[0].toUpperCase()}${what.slice(1)} has cracked bearings and joints; traffic slowed for inspection.`, 'info')
    })
    return changed
  }


  applyShock(shock) {
    const { city, rng } = this
    let pgaSum = 0
    let n = 0
    let collapses = 0
    let weakFell = 0
    let heavy = 0
    let any = 0
    const notable = []
    const vis = { M: shock.M, main: shock.main, pga: 0, collapses: [], damaged: [] }
    // ground-motion variability: one between-event term for the whole shock,
    // plus site-to-site scatter (switched off for a deterministic median run)
    const eventTerm = this.variability ? Math.exp(rng.normal() * this.gmpe.tau) : 1
    const within = this.variability ? 0.25 : 0
    // the ground fails first: liquefaction, lateral spreading, landslides —
    // driven by the actual surface PGA (rock PGA × the BA08 Vs30 site term)
    const half = (GRID * CELL) / 2
    let pgaGround = 0
    let nGround = 0
    const surfacePga = (k) => {
      const i = k % GRID
      const j = (k - i) / GRID
      const r = rockPgaAt(shock, (i + 0.5) * CELL - half, (j + 0.5) * CELL - half) * eventTerm
      return r * siteFactor(SOIL_VS30[city.soil[k]], r)
    }
    // surface PGA everywhere: what people feel, and what the ground and bridges take
    const field = new Float32Array(GRID * GRID)
    const g = this.ground.shock(shock.M, (k) => {
      const a = surfacePga(k)
      field[k] = a
      pgaGround += a
      nGround++
      return a
    })
    for (let k = 0; k < field.length; k++) if (!field[k]) field[k] = surfacePga(k) // river channel
    vis.field = field
    vis.bridges = this.bridgeShock(shock, field)
    const buried = this.slideTargets(g.slides)
    // how fast the ground shakes, on each kind of soil
    const rjb0 = siteDistances(shock.geo, 0, 0).rjb
    const tm = [0, 1, 2].map((s) => groundPeriod(shock.M, rjb0, s, this.level.freq))
    vis.tm = tm[Math.round(city.soil.reduce((a, s) => a + s, 0) / city.soil.length)]
    for (const b of city.buildings) {
      if (b.removed) continue
      const s = this.st.get(b.id)
      if (!s || s.collapsed) continue
      const soil = city.soil[cellOfBuilding(b)]
      const p = demand(b, soil, shock.M, rockPgaAt(shock, b.cx, b.cz) * eventTerm, tm[soil]) * Math.exp(rng.normal() * within)
      pgaSum += p / (b.floors >= 10 ? 1.3 : 1)
      n++
      const sh = shapeOf(b)
      // a damaged frame has less strength left for this shock
      const med = mediansFor(b, shock.M, s.D)
      const probs = damageProbs(p, med)
      const u = rng.next()
      let dsS = 0
      for (let k = 3; k >= 0; k--)
        if (u < probs[k]) {
          dsS = k + 1
          break
        }
      const D0 = s.D
      let dD = fatigueDamage(b, p, med, shock.M) * Math.exp(rng.normal() * 0.3)
      dD += this.groundEffect(b, s, sh) + (buried.get(b.id) || 0)
      s.D = Math.min(D_MAX, Math.max(s.D + dD, DS_FLOOR[dsS]))
      if (s.D - D0 > 0.01) s.hits++
      // leaning more than 1/60 makes a building unsafe to occupy (Japanese
      // post-quake guideline) even when its frame is still sound
      const ds = Math.max(s.ds, dsS, dsFromD(s.D), s.lean > 1 / 60 ? 3 : 0)
      let collapsed = false
      if (ds === 4) {
        // a building already wrecked by earlier shaking only risks collapse
        // in proportion to how much further this shock pushed it
        const share = s.ds < 4 ? 1 : Math.min(1, (s.D - D0) / 0.35)
        const pExhausted = D0 >= DS_FLOOR[3] ? clamp((s.D - D_FAIL * 0.85) / 0.6, 0, 1) : 0 // capacity used up by earlier shocks
        collapsed = rng.chance(Math.max(collapseProb(b, p, med, s.D), pExhausted) * share)
      }
      if (s.lean > sh.tip * 0.4 && sh.slender > 1.3) {
        // the centre of mass has moved far enough out over the failing foundation
        collapsed = true
        s.toppled = true
      }
      if (!collapsed && ds <= s.ds) {
        if (s.D - D0 > 0.02 || this.moved.has(b.id)) vis.damaged.push(b.id)
        continue
      }
      const old = s.ds
      s.ds = collapsed ? 4 : ds
      if (collapsed) {
        s.collapsed = true
        this.onCollapse(b, s)
        collapses++
        if (!shock.main) this.lateCollapses++
        if (D0 > 0.3) weakFell++
        if (b.floors >= 4 || BUILDING_TYPES[b.type].facility) notable.push(b)
      } else if (s.ds >= 3) heavy++
      else any++
      this.casualties(b, s, old, s.ds, collapsed)
      if (s.ds >= 3) this.maybeIgnite(b, s, s.ds)
      if (collapsed) vis.collapses.push(b.id)
      else vis.damaged.push(b.id)
      if ((shock.main && s.ds >= 2) || s.ds >= 3) {
        // people leave damaged buildings once the shaking stops; red-tagged ones stay empty
        s.outside += s.present
        s.present = 0
      }
    }
    if (notable.length > 6) notable.length = 6
    vis.pga = n ? pgaSum / n : 0 // structural demand: drives the visual shaking
    const pga = nGround ? pgaGround / nGround : 0 // mean surface PGA across the district
    const rjb = siteDistances(shock.geo, 0, 0).rjb
    this.shocks.push({ M: shock.M, depth: shock.depth, dist: shock.dist, az: shock.az, main: shock.main, t: this.time, pga, demand: vis.pga, rjb })
    this.pending.push(vis)
    return { pga, rjb, collapses, weakFell, heavy, any, notable, ground: g }
  }

  /**
   * Settlement, tilt and loss of support from the ground under a building
   * during this shock. Returns the damage-index increment.
   */
  groundEffect(b, s, sh) {
    const f = this.ground.footprint(b)
    if (f.mean < 0.003 && f.spread < 0.01 && !f.slid) return 0
    // heavier buildings punch further into liquefied sand, unless they stand on piles
    // driven down to firm ground (high-rises): those barely settle or tilt, though
    // the ground around them sinks (Kobe 1995, Christchurch 2011)
    const piled = b.floors >= 10 || b.construction === 'isolated'
    const bearing = clamp(0.6 + 0.07 * b.floors, 0.6, 2.5) * (piled ? 0.15 : 1)
    const dSettle = f.mean * bearing
    // uneven settlement tilts the building; once it leans, its weight acting
    // through the offset centre of mass pushes it over further
    const diff = f.diff + dSettle * (0.05 + 0.2 * this.rng.next())
    let dLean = (diff / sh.B) * (0.3 + 0.5 * sh.slender) * (1 + 4 * s.lean * sh.slender) * (piled ? 0.15 : 1)
    if (f.spread > 0) {
      // spreading ground moves toward the river, and the building leans with it
      if (s.lean < 0.002) s.leanAng = (this.city.riverCenter[b.y] > b.x + b.w / 2 ? 0 : Math.PI) + (this.rng.next() - 0.5) * 0.6
      dLean += f.spread * 0.01 * sh.slender * (piled ? 0.3 : 1)
    }
    s.settle += dSettle
    s.lean = Math.min(1.3, s.lean + dLean)
    if (dSettle > 0.005 || dLean > 0.0005) this.moved.add(b.id)
    if (s.lean > 1 / 60 && !s.leanLogged) {
      s.leanLogged = true
      this.leaning++
      if (this.leaning <= 6) this.log(`${BUILDING_TYPES[b.type].name} (${b.floors} floors) is leaning ${((s.lean * 180) / Math.PI).toFixed(1)}° on liquefied ground — evacuated.`, 'warn')
    }
    let dD = 0.08 * dSettle + 2.5 * dLean + 0.1 * f.spread // foundation and frame distortion
    if (f.slid) dD += 0.3 + 0.9 * f.slid // the ground under it slid away
    return dD
  }

  /** Buildings buried or struck by landslide debris: id → damage increment. */
  slideTargets(slides) {
    const out = new Map()
    const { city } = this
    for (const sl of slides) {
      const hit = new Set()
      for (const { k, d } of sl.dep) {
        const id = city.buildingAt[k]
        if (id < 0) continue
        const b = city.byId.get(id)
        if (!b || b.removed) continue
        out.set(id, (out.get(id) || 0) + (d * 0.5) / Math.pow(b.floors, 0.7))
        hit.add(id)
      }
      for (const k of sl.cells) if (city.buildingAt[k] >= 0) hit.add(city.buildingAt[k])
      sl.hit = hit.size
    }
    return out
  }

  reportGround(g) {
    const G = this.ground
    if (g.newLiq >= (this.liqLogged ? 40 : 3)) {
      const first = !this.liqLogged
      this.liqLogged = true
      const ha = ((g.newLiq * CELL * CELL) / 1e4).toFixed(1)
      this.log(first ? `Liquefaction: the sandy ground near the river turned to quicksand over ${ha} ha — sand boils erupt and the ground settles.` : `The ground liquefied again over ${ha} ha.`, first ? 'bad' : 'warn')
    }
    for (const sl of g.slides) {
      if (G.slides.length > 10) break
      const vol = Math.round(sl.vol / 100) * 100
      this.log(`Landslide: about ${vol.toLocaleString()} m³ of hillside gave way${sl.hit ? `, hitting ${sl.hit} building${sl.hit > 1 ? 's' : ''}` : ''}.`, sl.hit ? 'bad' : 'warn')
    }
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

  /**
   * Heavy debris, a falling block or a toppling tower struck building b.
   * energy in joules; resistance scales with the building's mass and strength.
   */
  applyImpact(b, energy) {
    const s = b && this.st.get(b.id)
    if (!s || s.collapsed) return null
    const C = CONSTRUCTION[b.construction]
    const x = energy / (b.area * 450 * C.medians[3] * residual(s.D, shapeOf(b)))
    const dsI = x > 0.45 ? 4 : x > 0.15 ? 3 : x > 0.04 ? 2 : 0
    s.D = Math.min(D_MAX, Math.max(s.D + Math.min(1.2, x * 1.6), DS_FLOOR[dsI]))
    const ds = Math.max(s.ds, dsFromD(s.D))
    const collapsed = ds === 4 && this.rng.chance(clamp(0.25 + x * 0.3 + Math.max(0, s.D - D_FAIL), 0, 0.95))
    if (ds <= s.ds && !collapsed) return null
    const old = s.ds
    s.ds = collapsed ? 4 : ds
    if (collapsed) {
      s.collapsed = true
      this.onCollapse(b, s)
    }
    this.casualties(b, s, old, s.ds, collapsed)
    if (s.ds >= 3) this.maybeIgnite(b, s, s.ds)
    this.pending.push({ impact: true, M: 0, pga: 0, main: false, collapses: collapsed ? [b.id] : [], damaged: collapsed ? [] : [b.id] })
    this.impacts = (this.impacts || 0) + 1
    if ((collapsed || s.ds >= 3) && this.impacts <= 15) {
      const name = BUILDING_TYPES[b.type].name.toLowerCase()
      this.log(`Falling debris ${collapsed ? 'brought down' : 'smashed into'} ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name} (${b.floors} floors).`, collapsed ? 'bad' : 'warn')
    }
    return { ds: s.ds, collapsed }
  }

  /** A weakened building gives way between shocks (gravity, fire, its own lean). */
  quietCollapse(b, s, why) {
    const old = s.ds
    s.ds = 4
    s.collapsed = true
    this.onCollapse(b, s)
    this.lateCollapses++
    if (why === 'fire') this.fireCollapses = (this.fireCollapses || 0) + 1
    this.casualties(b, s, old, 4, true)
    this.pending.push({ quiet: true, M: 0, pga: 0, main: false, collapses: [b.id], damaged: [] })
    this.quietCount = (this.quietCount || 0) + 1
    if (this.quietCount <= 12) {
      const name = BUILDING_TYPES[b.type].name
      const h = Math.max(0, (this.time - this.mainTime) / 3600)
      const when = h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${(h / 24).toFixed(1)} days`
      const text =
        why === 'fire'
          ? `${name} (${b.floors} floors) collapsed after its fire-weakened structure gave way.`
          : `${name} (${b.floors} floors), weakened by ${s.hits} shock${s.hits === 1 ? '' : 's'}, collapsed ${when} after the main earthquake.`
      this.log(text, 'bad')
    }
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

  /** how: 'quake' (broken gas lines, toppled stoves), 'radiant', 'embers', 'tree', 'debris' */
  ignite(b, s, how = 'quake') {
    if (s.burning || s.burnt) return
    this.fire.ignite(b, s)
    this.fires++
    if (this.fires === 1) {
      const W = this.fire.wind
      this.log(`Wind ${W.speed.toFixed(1)} m/s from the ${compass(W.dir + Math.PI)}: embers will be carried ${compass(W.dir)}.`, 'info')
    }
    if (this.fires > 14) return
    const name = BUILDING_TYPES[b.type].name.toLowerCase()
    const a = /^[aeiou]/.test(name) ? 'an' : 'a'
    const text = {
      quake: `Fire broke out in ${a} ${name}.`,
      radiant: `Fire spread to ${a} ${name} next door — the heat from the blaze set it alight.`,
      embers: `Wind-blown embers set ${a} ${name} on fire.`,
      tree: `Burning trees set ${a} ${name} on fire.`,
      debris: `Burning debris from a collapse set ${a} ${name} on fire.`,
    }[how]
    this.log(text, 'warn')
  }

  /** A building came down: if it was burning, its burning debris is flung around it. */
  onCollapse(b, s) {
    if (!s.burning || s.fireI < 0.2) return
    this.fire.collapseBrands(b, this.st, (o, os) => this.ignite(o, os, 'debris'))
  }

  facilityFactor(b) {
    const s = this.st.get(b.id)
    if (!s || s.collapsed || s.burning || s.burnt) return 0
    return s.ds <= 2 ? 1 : s.ds === 3 ? 0.4 : 0
  }

  dynamics(dtH) {
    const { city, rng } = this
    const hoursSince = Math.max(0, (this.time - this.mainTime) / 3600)

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

    // ---- ground: excess pore pressure bleeds away between shocks
    this.ground.update(dtH)

    // ---- damaged structures between shocks: fire softens them, gravity works on
    // cracked columns and on any lean, and some give way hours or days later
    for (const b of city.buildings) {
      const s = this.st.get(b.id)
      if (!s || s.collapsed || b.removed) continue
      if (s.burning) {
        // the hotter the fire, the faster it eats the structure (timber burns, steel softens, concrete spalls)
        s.D += CONSTRUCTION[b.construction].fireLoss * dtH * (b.floors >= 10 ? 1.2 : 1) * Math.max(0.2, s.fireI ?? 1)
        s.ds = Math.max(s.ds, dsFromD(s.D))
      }
      if (s.burning && s.D >= D_FAIL * 1.2) {
        this.quietCollapse(b, s, 'fire')
        continue
      }
      if (s.D > 0.6) {
        const lam = 0.004 * ((s.D - 0.6) / 0.4) ** 2 * shapeOf(b).coll * (1 + 25 * s.lean)
        if (rng.chance(1 - Math.exp(-lam * dtH))) this.quietCollapse(b, s, 'gravity')
      }
    }

    // ---- fires: burn, spread by radiant heat, embers and burning trees, burn out
    const ext = (b) => {
      // firefighting from the stations still able to respond (until crews are modelled on the map)
      let inRange = 0
      for (const st of stations) if (Math.hypot(st.b.x - b.x, st.b.y - b.y) < 50) inRange += st.f
      return Math.min(0.85, 0.3 * Math.min(inRange, 2.5) * this.waterOk)
    }
    const wasBurning = new Set()
    for (const [id, s] of this.st) if (s.burning) wasBurning.add(id)
    this.fire.step(dtH, this.st, ext, (o, os, how) => this.ignite(o, os, how))
    for (const id of wasBurning) {
      const s = this.st.get(id)
      if (s.burning) continue
      if (s.burnt) {
        s.ds = 4
        s.D = Math.max(s.D, DS_FLOOR[4])
        this.burnouts = (this.burnouts || 0) + 1
        if (this.burnouts <= 4) this.log(`The fire in a ${BUILDING_TYPES[this.city.byId.get(id).type].name.toLowerCase()} has burnt itself out — nothing left to burn.`, 'info')
      } else if (s.extinguished && s.ds < 3) s.ds = 3
    }
    for (const b of city.buildings) {
      const s = this.st.get(b.id)
      if (!s || !s.burning) continue
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
    let standing = 0
    let integSum = 0
    let weakened = 0
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
      if (!s.collapsed) {
        standing++
        integSum += 1 - Math.min(1, s.D)
        if (s.D >= DS_FLOOR[3]) weakened++
      }
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
      integrity: standing ? integSum / standing : 0,
      weakened,
      lateCollapses: this.lateCollapses,
      leaning: this.leaning,
      ...this.ground.stats(),
    }
  }
}

export { DAMAGE_STATES, CELL }
