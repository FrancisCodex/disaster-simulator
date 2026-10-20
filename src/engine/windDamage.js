// Typhoon wind damage to the district, evaluated every simulated minute.
//
// Buildings follow the HAZUS-Hurricane chain of components, each with a
// lognormal fragility on the 3-s gust at roof height (WIND in config.js):
//   windows / doors breached (by pressure or by flying debris)
//     → internal pressure: the roof is pushed from inside as well as sucked
//       from outside, so it fails at lower winds
//   roof cover peeled off (sheets, tiles)  → becomes flying debris
//   roof structure lifted off              → occupants exposed, walls unbraced
//   walls fail / the building is flattened.
// The local gust is the storm's 1-min wind × gust factor × a height factor
// (power law) × shelter from taller buildings upwind (or exposure across the
// river and parks). Repeated loading wears connections down, and when the
// wind turns (the back eyewall) a new face is loaded: the second half of an
// eye passage destroys what the first half loosened.
// Trees fall at lower gusts once the soil is soaked, block roads and bring
// down power lines; poles fail on their own above ~170 km/h, and the line
// that feeds the whole city above ~210 km/h. Unpowered pumps stop.

import { GRID, CELL_ROAD, CELL_RIVER, CELL_PARK, CELL_POND, CONSTRUCTION, BUILDING_TYPES, WIND, WIND_BETA, roofKind, METAL_ROOF, SLAB_COLLAPSE, TREE_WIND, POLE_WIND, GRID_WIND, STREET_POLE_WIND } from './config.js'
import { idx } from './cityGen.js'
import { normCdf, clamp, smoothstep } from './math.js'
import { fieldAt, GUST_LAND } from './typhoonPhysics.js'

export const FEEDER = 25 // cells per side of one distribution feeder's area (250 m)
const SECTORS = 8
const COMPONENTS = ['glass', 'cover', 'roof', 'collapse']
// dead / injured as a fraction of the people inside
// (wind failures build up over minutes: most people shelter in the strongest room or flee, unlike in an earthquake)
const ROOF_CASUALTY = [0.0005, 0.02]
const COLLAPSE_CASUALTY = { wood_old: [0.008, 0.15], wood_mod: [0.008, 0.15], urm: [0.03, 0.2] }
const COLLAPSE_CASUALTY_RC = [0.03, 0.2]

const pFail = (g, m, beta = WIND_BETA) => (m ? normCdf(Math.log(g / m) / beta) : 0)
/** 3-s gust profile: speed-up with height above open ground (exponent ~0.1). */
export const heightFactor = (z) => Math.pow(Math.max(z, 6) / 10, 0.1)

/** 50%-failure gusts (m/s) of a building's components, after preparations. */
export function windMedians(b) {
  const W = WIND[b.construction] ?? WIND.rc_mod
  const kind = roofKind(b.type)
  const m = { glass: W.glass, cover: W.cover, roof: W.roof, collapse: W.collapse }
  if (kind === 'metal') {
    m.cover = METAL_ROOF.cover
    m.roof = METAL_ROOF.roof
  } else if (kind === 'slab') {
    m.cover = null
    m.roof = null
    m.collapse *= SLAB_COLLAPSE
  }
  if (BUILDING_TYPES[b.type].windows === 0) m.glass = null
  return m
}

/** Chances of each failure at a given 3-s gust (m/s) at roof height. */
export function windRisk(b, gust) {
  const m = windMedians(b)
  const g = gust * heightFactor(b.height + b.elevated)
  const pGlass = pFail(g, m.glass)
  const pRoof = pFail(g, m.roof && m.roof * (1 - 0.12 * pGlass))
  return { kind: roofKind(b.type), medians: m, gust: g, pGlass, pCover: pFail(g, m.cover), pRoof, pCollapse: pFail(g, m.collapse * (1 - 0.1 * pRoof)) }
}

export class WindDamage {
  constructor(city, impact, typhoon, { rng, life = null }) {
    this.city = city
    this.impact = impact
    impact.wind = this
    this.ty = typhoon
    this.rng = rng
    this.life = life
    this.time = 0
    this.events = []
    this.st = new Map()
    for (const b of city.buildings) {
      if (b.removed) continue
      this.st.set(b.id, { med: windMedians(b), kind: roofKind(b.type), p: { glass: 0, cover: 0, roof: 0, collapse: 0 }, dir: null, glass: false, cover: false, roof: false, collapsed: false, wear: 0, gust: 0, maxGust: 0, k: 1 + 0.08 * rng.normal(), shelter: new Float32Array(SECTORS).fill(NaN) })
    }
    // trees standing on open ground (the ones the renderer draws)
    this.trees = city.trees
      .filter((t) => city.buildingAt[idx(t.i, t.j)] < 0 && city.cellType[idx(t.i, t.j)] !== CELL_ROAD && city.cellType[idx(t.i, t.j)] !== CELL_POND && !t.fallen && !t.burnt)
      .map((t) => ({ t, med: TREE_WIND[t.kind] * (0.85 + 0.3 * rng.next()) * (1.1 - 0.2 * (t.s - 1)), k: 1 + 0.1 * rng.normal(), p: 0 }))
    const nz = Math.ceil(GRID / FEEDER)
    this.feeders = Array.from({ length: nz * nz }, () => ({ up: true, p: 0, cause: null }))
    this.gridUp = true
    this.gridP = 0
    this.stats = { glass: 0, cover: 0, roof: 0, collapsed: 0, trees: 0, roads: 0, poles: 0, deathsRoof: 0, deathsCollapse: 0 }
    this.pending = { glass: 0, cover: 0, roof: 0, collapsed: 0, trees: 0, roads: 0 }
    this.flags = {}
    this.lastLog = {}
    this.wind = { v: 0, dir: [0, 0], gust: 0 }
  }

  log(text, level = 'info') {
    this.events.push({ t: this.time, text, level })
  }

  feederOf(i, j) {
    const nz = Math.ceil(GRID / FEEDER)
    return Math.floor(j / FEEDER) * nz + Math.floor(i / FEEDER)
  }

  /** Is cell (i, j) supplied with power? */
  powered(i, j) {
    return this.gridUp && this.feeders[this.feederOf(i, j)].up
  }

  poweredShare() {
    if (!this.gridUp) return 0
    return this.feeders.filter((f) => f.up).length / this.feeders.length
  }

  /**
   * Shelter factor for wind from a sector: taller buildings 20–80 m upwind
   * slow the gusts; open ground (river, parks) upwind exposes the building.
   */
  shelterOf(b, s, sector) {
    const cached = s.shelter[sector]
    if (!Number.isNaN(cached)) return cached
    const { city } = this
    const ang = (sector / SECTORS) * Math.PI * 2 // direction the wind comes from, 0 = north
    const ui = Math.sin(ang)
    const uj = -Math.cos(ang) // north is −j
    const ci = b.x + b.w / 2
    const cj = b.y + b.d / 2
    let tall = 0
    let open = 0
    let n = 0
    for (let d = 2 + Math.max(b.w, b.d) / 2; d <= 9 + Math.max(b.w, b.d) / 2; d += 1) {
      const i = Math.round(ci + ui * d)
      const j = Math.round(cj + uj * d)
      if (i < 0 || j < 0 || i >= GRID || j >= GRID) {
        open++
        n++
        continue
      }
      const k = idx(i, j)
      n++
      const bid = city.buildingAt[k]
      if (bid >= 0 && bid !== b.id) {
        const o = city.byId.get(bid)
        if (o && !o.removed && !this.st.get(bid)?.collapsed) tall = Math.max(tall, o.height / Math.max(3, b.height))
      } else if (city.cellType[k] === CELL_RIVER || city.cellType[k] === CELL_PARK || city.cellType[k] === CELL_POND) open++
    }
    const f = tall >= 1 ? 0.72 : tall >= 0.6 ? 0.85 : open / Math.max(1, n) > 0.5 ? 1.08 : 1
    s.shelter[sector] = f
    return f
  }

  update(t, dtH, { cumRain = 0 } = {}) {
    this.time = t
    const tau = this.ty.tau(t)
    const f = fieldAt(this.ty.storm, tau)
    const V = f.wind
    const dir = f.dir
    this.wind = { v: V, dir, gust: V * GUST_LAND }
    if (V * GUST_LAND < 18) return this.flushLogs()
    const { rng } = this
    // the wind comes from the opposite of where it blows
    const from = Math.atan2(-dir[0], -dir[1])
    const sector = ((Math.round((from / (Math.PI * 2)) * SECTORS) % SECTORS) + SECTORS) % SECTORS

    for (const b of this.city.buildings) {
      const s = this.st.get(b.id)
      if (!s || s.collapsed || b.removed) continue
      if (this.impact.st.get(b.id)?.collapsed) {
        s.collapsed = true
        continue
      }
      // s.k: this building's own exposure (a corner plot, a gap between blocks); the minute-to-minute
      // scatter of gusts is already in the fragility's β, so it is not drawn again each minute
      const g = V * GUST_LAND * heightFactor(b.height + b.elevated) * this.shelterOf(b, s, sector) * s.k
      s.gust = g
      if (g > s.maxGust) s.maxGust = g
      // the wind has swung round: a new face of the building takes the load
      if (s.dir && s.dir[0] * dir[0] + s.dir[1] * dir[1] < -0.2) {
        for (const c of COMPONENTS) s.p[c] *= 0.5
        s.dir = null
      }
      if (g < 0.6 * Math.min(s.med.cover ?? 99, s.med.glass ?? 99, s.med.collapse)) continue
      if (!s.dir) s.dir = dir
      // connections work loose under sustained strong gusts
      if (s.med.roof && g > 0.75 * s.med.roof) s.wear += dtH
      const worn = 1 - 0.07 * clamp(s.wear / 2, 0, 1)
      const inside = s.glass ? 0.88 : 1
      const M = {
        glass: s.med.glass,
        cover: s.med.cover && s.med.cover * worn * inside,
        roof: s.med.roof && s.med.roof * worn * inside * (s.cover ? 0.95 : 1),
        collapse: s.med.collapse * (s.roof ? 0.9 : 1) * worn,
      }
      for (const c of COMPONENTS) {
        if (s[c === 'collapse' ? 'collapsed' : c] || !M[c]) continue
        if (c === 'roof' && s.kind === 'slab') continue
        const P = pFail(g, M[c])
        if (P <= s.p[c]) continue
        const draw = (P - s.p[c]) / (1 - s.p[c])
        s.p[c] = P
        if (rng.chance(draw)) {
          if (c === 'roof' && !s.cover) this.fail(b, s, 'cover', g)
          this.fail(b, s, c, g)
          if (c === 'collapse') break
        }
      }
    }
    this.updateTrees(V, dir, cumRain)
    this.updateStreet(V, dir)
    this.updatePower(V)
    return this.flushLogs()
  }

  fail(b, s, c, g) {
    const im = this.impact
    const is = im.st.get(b.id)
    if (c === 'glass') {
      s.glass = true
      this.stats.glass++
      this.pending.glass++
      if (is) is.injured += is.present * 0.002
      this.events.push({ t: this.time, damage: b.id, ds: 1 })
    } else if (c === 'cover') {
      s.cover = true
      this.stats.cover++
      this.pending.cover++
      this.debrisStrike(b, 1)
      this.events.push({ t: this.time, damage: b.id, ds: 1, roof: 'cover' })
    } else if (c === 'roof') {
      s.roof = true
      this.stats.roof++
      this.pending.roof++
      this.debrisStrike(b, 2)
      if (is) {
        const dead = is.present * ROOF_CASUALTY[0]
        im.kill(b, is, dead, 'roof')
        this.stats.deathsRoof += dead
        is.injured += is.present * ROOF_CASUALTY[1]
      }
      this.events.push({ t: this.time, damage: b.id, ds: 2, roof: 'lost' })
      if (b.type === 'hospital' && is && !is.offline) {
        is.offline = true
        this.log('The hospital has lost its roof: wards are being moved to the lower floors.', 'bad')
      }
    } else {
      s.collapsed = true
      s.byWind = true
      this.stats.collapsed++
      this.pending.collapsed++
      if (is && !is.collapsed) {
        is.collapsed = true
        const [fd, fi] = COLLAPSE_CASUALTY[b.construction] ?? COLLAPSE_CASUALTY_RC
        const dead = is.present * fd
        im.kill(b, is, dead, 'wind')
        this.stats.deathsCollapse += dead
        is.injured += is.present * fi
        if (b.type === 'hospital') is.offline = true
      }
      this.events.push({ t: this.time, collapse: b.id })
      if (b.type !== 'house' && (b.floors >= 3 || b.type === 'school' || b.type === 'shelter' || b.type === 'hospital')) this.log(`${BUILDING_TYPES[b.type].name} (${CONSTRUCTION[b.construction].short}) destroyed by gusts of ~${Math.round(g * 3.6)} km/h.`, 'bad')
      // walls and debris spill into the street; overhead lines come down with them
      if (this.life) this.life.blockAround(b)
      if (this.rng.chance(0.5)) this.feederFault(b.x, b.y, 'collapse')
    }
  }

  /**
   * Sheets and tiles from b's roof fly downwind: each window within ~140 m in
   * their path has one chance of being hit (more pieces from a whole roof).
   */
  debrisStrike(src, pieces) {
    const [ux, un] = this.wind.dir
    if (this.wind.gust < 25) return
    for (const b of this.city.buildings) {
      if (b === src) continue
      const s = this.st.get(b.id)
      if (!s || s.glass || s.collapsed || !s.med.glass) continue
      const dx = b.cx - src.cx
      const dz = b.cz - src.cz
      const d = Math.hypot(dx, dz)
      // downwind (wind east = +x, north = −z)
      if (d > 140 || (dx * ux - dz * un) / d < 0.5) continue
      if (this.rng.chance(0.05 * pieces * (1 - d / 140))) this.fail(b, s, 'glass', this.wind.gust)
    }
  }

  updateTrees(V, dir, cumRain) {
    const { city, rng } = this
    // soaked soil loosens the roots
    const soak = 1 - 0.12 * smoothstep(60, 250, cumRain)
    const g0 = V * GUST_LAND
    for (const tr of this.trees) {
      if (tr.t.fallen) continue
      const g = g0 * tr.k
      const P = pFail(g, tr.med * soak, 0.25)
      if (P <= tr.p) continue
      const draw = (P - tr.p) / (1 - tr.p)
      tr.p = P
      if (!rng.chance(draw)) continue
      // it falls downwind (world x east, z south)
      const wx = dir[0]
      const wz = -dir[1]
      tr.t.fallen = { ax: wx, az: wz, th: 1.3 + rng.float(0, 0.25) }
      this.stats.trees++
      this.pending.trees++
      this.events.push({ t: this.time, tree: true })
      // what it lands on: the road, a power line, a roof
      const reach = Math.max(1, Math.round(tr.t.s * 1.2))
      for (let d = 0; d <= reach; d++) {
        const i = clamp(Math.round(tr.t.i + wx * d), 0, GRID - 1)
        const j = clamp(Math.round(tr.t.j + wz * d), 0, GRID - 1)
        const k = idx(i, j)
        if (city.cellType[k] === CELL_ROAD) {
          if (this.life && !this.life.blocked[k]) {
            this.life.block(k)
            this.stats.roads++
            this.pending.roads++
          }
          if (rng.chance(0.35)) this.feederFault(i, j, 'trees')
          break
        }
        const bid = city.buildingAt[k]
        if (bid >= 0) {
          const b = city.byId.get(bid)
          const s = this.st.get(bid)
          if (b && s && !s.collapsed) {
            if (s.med.glass && !s.glass && rng.chance(0.5)) this.fail(b, s, 'glass', g0)
            if (s.med.cover && !s.cover && rng.chance(0.4)) this.fail(b, s, 'cover', g0)
          }
          break
        }
      }
    }
  }

  /** Street lights and traffic signals bend over at the base and fall downwind. */
  updateStreet(V, dir) {
    const life = this.life
    if (!life?.lamps) return
    if (!this.poles) {
      const mk = (list, kind, med) => list.map((o, q) => ({ kind, q, x: o.x, z: o.z, med: med * (0.85 + 0.3 * this.rng.next()), k: 1 + 0.08 * this.rng.normal(), p: 0, down: false }))
      this.poles = [...mk(life.lamps, 'lamp', STREET_POLE_WIND[0]), ...mk(life.signals || [], 'signal', STREET_POLE_WIND[1])]
    }
    const g0 = V * GUST_LAND * heightFactor(8)
    if (g0 < 30) return
    const wx = dir[0]
    const wz = -dir[1]
    let n = 0
    for (const p of this.poles) {
      if (p.down) continue
      const P = pFail(g0 * p.k, p.med)
      if (P <= p.p) continue
      const draw = (P - p.p) / (1 - p.p)
      p.p = P
      if (!this.rng.chance(draw)) continue
      p.down = true
      if (!life.knockPole(p, wx + 0.15 * this.rng.normal(), wz + 0.15 * this.rng.normal())) continue
      n++
      this.stats.poles++
      // a column across the carriageway closes it; some carry the overhead supply
      const i = clamp(Math.floor((p.x + wx * 4 + 500) / 10), 0, GRID - 1)
      const j = clamp(Math.floor((p.z + wz * 4 + 500) / 10), 0, GRID - 1)
      const k = idx(i, j)
      if (this.city.cellType[k] === CELL_ROAD && !life.blocked[k] && this.rng.chance(0.3)) {
        life.block(k)
        this.stats.roads++
        this.pending.roads++
      }
      if (this.rng.chance(0.1)) this.feederFault(i, j, 'poles')
    }
    if (n && !this.flags.poles) {
      this.flags.poles = true
      this.log('Street lights and traffic signals are coming down. Live wires and falling poles make the streets deadly.', 'warn')
    }
  }

  feederFault(i, j, cause) {
    const fd = this.feeders[this.feederOf(clamp(i, 0, GRID - 1), clamp(j, 0, GRID - 1))]
    if (!fd.up) return
    fd.up = false
    fd.cause = cause
    this.events.push({ t: this.time, power: true })
    if (this.gridUp) {
      const where = this.compassArea(i, j)
      const why = cause === 'trees' ? 'falling trees brought down the lines' : cause === 'collapse' ? 'a collapsing building took the lines down' : 'power poles snapped'
      this.log(`Power cut in the ${where} of the city: ${why}.`, 'warn')
    }
  }

  updatePower(V) {
    const { rng } = this
    const g = V * GUST_LAND * 1.05 // poles stand ~10 m tall in the open along streets
    for (let q = 0; q < this.feeders.length; q++) {
      const fd = this.feeders[q]
      if (!fd.up) continue
      const P = pFail(g, POLE_WIND, 0.25)
      if (P <= fd.p) continue
      const draw = (P - fd.p) / (1 - fd.p)
      fd.p = P
      const nz = Math.ceil(GRID / FEEDER)
      if (rng.chance(draw)) this.feederFault((q % nz) * FEEDER + FEEDER / 2, Math.floor(q / nz) * FEEDER + FEEDER / 2, 'poles')
    }
    if (this.gridUp) {
      const P = pFail(g, GRID_WIND, 0.2)
      if (P > this.gridP) {
        const draw = (P - this.gridP) / (1 - this.gridP)
        this.gridP = P
        if (rng.chance(draw)) {
          this.gridUp = false
          this.events.push({ t: this.time, power: true })
          this.log('Blackout: the transmission line feeding the city has failed. Every pump, street light and lift without a generator stops.', 'bad')
        }
      }
    }
  }

  compassArea(i, j) {
    const n = j < GRID / 3 ? 'north' : j > (2 * GRID) / 3 ? 'south' : ''
    const e = i < GRID / 3 ? 'west' : i > (2 * GRID) / 3 ? 'east' : ''
    return n && e ? `${n}-${e}` : n || e || 'centre'
  }

  /** Aggregated log lines, at most every 20 simulated minutes per kind. */
  flushLogs() {
    const P = this.pending
    const S = this.stats
    const due = (k) => this.time - (this.lastLog[k] ?? -1e9) > 1200
    if (P.cover + P.roof > 0 && due('roof')) {
      this.log(
        this.flags.roof
          ? `More roofs torn away: ${S.roof} buildings have lost their roofs, ${S.cover} more their roof sheets or tiles.`
          : 'The first roofs are peeling off: sheet and tile roofs on older homes go first, and the sheets fly downwind.',
        S.roof >= 10 ? 'bad' : 'warn',
      )
      this.flags.roof = true
      this.lastLog.roof = this.time
      P.cover = P.roof = 0
    }
    if (P.glass > 0 && due('glass')) {
      if (!this.flags.glass) this.log('Windows are breaking. Once a window goes, the wind pressurises the building from inside and the roof is pushed off from below.', 'warn')
      this.flags.glass = true
      this.lastLog.glass = this.time
      P.glass = 0
    }
    if (P.collapsed > 0 && due('collapse')) {
      this.log(`${S.collapsed} building${S.collapsed > 1 ? 's have' : ' has'} been flattened by the wind.`, 'bad')
      this.lastLog.collapse = this.time
      P.collapsed = 0
    }
    if (P.trees > 0 && due('trees')) {
      this.log(`${S.trees} tree${S.trees > 1 ? 's' : ''} down${S.roads ? `, blocking ${S.roads} stretch${S.roads > 1 ? 'es' : ''} of road` : ''}.`, 'warn')
      this.lastLog.trees = this.time
      P.trees = P.roads = 0
    }
    return this.events
  }
}

