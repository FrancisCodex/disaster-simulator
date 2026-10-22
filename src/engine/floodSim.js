// 2-D flood hydraulics: the "local inertial" shallow-water scheme used by
// LISFLOOD-FP (Bates et al., 2010). Mass-conserving, with Manning friction,
// rainfall, infiltration, storm drains, pumps, an upstream river hydrograph
// and a free-outflow downstream boundary. Rain comes from a TyphoonSim: on the
// district for the grid, and over the upstream catchment for the river.
// A coastal city's downstream boundary is the sea instead: its edge cells are
// held at the sea level of the moment (mean sea level + tide + storm surge),
// and the surge comes ashore through the same momentum equations, up the
// streets and up the river.

import { GRID, CELL, G, CELL_ROAD, CELL_RIVER, CELL_PARK, CELL_POND, PUMP_RATE } from './config.js'
import { clamp } from './math.js'

const CATCHMENT_M2 = 450e6 // upstream catchment draining through the city's river (Marikina: ~535 km²)
const UPLAND_RAIN = 1.25 // hills upstream wring more rain out of the storm than the lowland city gets
const BASE_FLOW = 110 // m³/s — a sizeable lowland river
const RIVER_SLOPE = 0.001

// Peak river level (m above the banks, averaged along the district) against
// peak inflow (m³/s), from full runs of this solver on generated cities.
const STAGE_TABLE = [
  [300, -3.0],
  [445, -2.6],
  [640, -1.7],
  [1060, 0.35],
  [1470, 1.25],
  [1920, 2.25],
  [2460, 2.8],
  [3820, 3.85],
  [6000, 5.0],
]

/**
 * Forecast of the river's flood wave for a storm (a buildStorm() storm,
 * with τ0 / τ1 the hours to simulate): the same lagged-runoff hydrograph the
 * solver uses, so the peak inflow is exact; the level it reaches comes from
 * STAGE_TABLE (dredging lowers it by about a metre).
 */
// The upstream floodway (an upgrade): flow above q0 is diverted, up to cap more (m³/s)
export const FLOODWAY = { q0: 400, cap: 1000 }
// The river gate (a coastal upgrade): it shuts once the sea is this far above normal (m), and pumps this much (m³/s) while shut
export const GATE_SURGE = 1.2
export const GATE_PUMP = 400
export const divertFlow = (q) => q - clamp(q - FLOODWAY.q0, 0, FLOODWAY.cap)

export function forecastRiverPeak(storm, catchmentRain, tau0, tau1, { dredged = false, floodway = false } = {}) {
  const dt = 300
  let lag = 0
  let cum = 0
  let peak = BASE_FLOW
  let tPeak = tau0
  for (let tau = tau0; tau <= tau1; tau += dt / 3600) {
    const basin = catchmentRain(storm, tau) * UPLAND_RAIN
    cum += (basin * dt) / 3600
    lag += ((basin - lag) * dt) / (2.5 * 3600)
    const runoffC = 0.25 + 0.55 * (cum / (cum + 100))
    let q = BASE_FLOW + (CATCHMENT_M2 * runoffC * lag) / 3.6e6
    if (floodway) q = divertFlow(q)
    if (q > peak) {
      peak = q
      tPeak = tau
    }
  }
  return { inflow: peak, tPeak, basinRain: cum, stage: stageFor(peak) - (dredged ? 1 : 0) }
}

export function stageFor(q) {
  const T = STAGE_TABLE
  if (q <= T[0][0]) return T[0][1]
  for (let n = 1; n < T.length; n++) {
    if (q > T[n][0]) continue
    const [q0, s0] = T[n - 1]
    const [q1, s1] = T[n]
    return s0 + ((s1 - s0) * Math.log(q / q0)) / Math.log(q1 / q0)
  }
  return T[T.length - 1][1]
}

export class FloodSim {
  /** tideGates: flap gates on the drain outfalls; generators: every pump has a backup generator. */
  constructor(city, { storm = null, drainage = 20, tideGates = false, generators = false } = {}) {
    const N = GRID
    this.city = city
    this.N = N
    this.dx = CELL
    this.storm = storm
    this.catchment = CATCHMENT_M2
    this.drainage = drainage // mm/h
    this.zg = new Float32Array(N * N)
    this.h = new Float32Array(N * N)
    this.maxH = new Float32Array(N * N)
    this.qx = new Float32Array((N - 1) * N)
    this.qy = new Float32Array(N * (N - 1))
    this.nn = new Float32Array(N * N)
    this.cls = new Uint8Array(N * N) // 0 pervious, 1 urban, 2 river
    this.river = []
    this.upstream = []
    for (let k = 0; k < N * N; k++) {
      const t = city.cellType[k]
      const built = city.buildingAt[k] >= 0
      this.nn[k] = built ? 0.1 : t === CELL_ROAD ? 0.016 : t === CELL_RIVER ? 0.03 : t === CELL_PARK ? 0.05 : 0.035
      // a mangrove forest's roots and trunks drag on the water flowing through it
      if (city.mangrove?.[k]) this.nn[k] = 0.12
      this.cls[k] = t === CELL_RIVER ? 2 : built || t === CELL_ROAD ? 1 : 0
      if (t === CELL_RIVER) {
        this.river.push(k)
        if (k < N * 2) this.upstream.push(k)
      }
      if (t === CELL_POND) this.cls[k] = 0
    }
    this.refreshGround()
    this.coast = city.coast ?? null
    // The open sea is held at the sea level of the moment (the bulk surge model
    // already gives it): sea cells on the grid's edge, and all more than 30 m off
    // the beach. Only a band of water along the shore is solved, which keeps the
    // sea from tripling the work per step.
    this.seaEdge = []
    this.fixed = new Uint8Array(N * N)
    if (this.coast) {
      for (let k = 0; k < N * N; k++) {
        const i = k % N
        const j = (k - i) / N
        // (mangroves are always solved: their drag is the point of them)
        if (city.sea[k] && (i === 0 || i === N - 1 || j === N - 1 || (this.coast.shore[i] - (j + 0.5) < -3 && !city.mangrove?.[k]))) {
          this.seaEdge.push(k)
          this.fixed[k] = 1
        }
      }
    }
    this.seaZ = this.coast ? this.coast.msl : 0
    this.seaRise = 0 // m above mean sea level
    this.seaMax = 0
    // where seawater has got to: the sea itself, then every wet cell the sea has flowed into
    this.salt = this.coast ? Uint8Array.from(city.sea) : null
    this.pumps = city.pumps.map((p) => ({ ...p, rate: p.rate ?? PUMP_RATE, generator: generators, active: true, removed: 0 }))
    this.tideGates = tideGates
    this.floodway = !!city.floodway
    this.diverted = 0 // m³/s taken away by the floodway right now
    this.divertedVol = 0
    // the river gate at the mouth (a coastal upgrade): a flap that shuts when the sea stands above the river
    this.gate = city.riverGate ?? null
    this.gateClosed = false
    this.gateChanges = 0
    this.gatePumped = 0
    // flap culverts through the sea wall: water behind it drains out whenever it stands higher than the sea side
    this.flaps = []
    if (city.seawall)
      for (let k = N; k < N * (N - 1); k++)
        if (city.seawall[k] && city.levee[k] > 0 && !city.levee[k - N] && !city.levee[k + N]) this.flaps.push([k - N, k + N])
    this.time = 0
    this.rain = 0
    this.cumRain = 0
    this.basinRain = 0 // mm/h over the upstream catchment
    this.cumBasin = 0
    this.rainLag = 0
    this.inflow = BASE_FLOW
    this.drainedVol = 0
    this.stage = -3
    this.stageMax = -3
    this.hmax = 1
    this.dt = 1
    this.totalRainVol = 0
    // start with a river at base flow
    for (const k of this.river) {
      const j = Math.floor(k / N)
      this.h[k] = Math.max(0, city.bankZ[j] - 4.6 - this.zg[k])
    }
    // and the sea in everything open to it below its level
    if (this.coast) {
      const sea = this.seaLevel(0)
      const q = [...this.seaEdge]
      const seen = new Uint8Array(N * N)
      for (const k of q) seen[k] = 1
      while (q.length) {
        const k = q.pop()
        this.h[k] = Math.max(this.h[k], sea - this.zg[k])
        const i = k % N
        for (const kk of [i > 0 ? k - 1 : -1, i < N - 1 ? k + 1 : -1, k - N, k + N]) {
          if (kk < 0 || kk >= N * N || seen[kk] || this.zg[kk] >= sea) continue
          seen[kk] = 1
          q.push(kk)
        }
      }
    }
    this.raining = false
    for (let s = 0; s < 1500; s++) this.step(Math.min(this.stableDt(), 3))
    this.time = 0
    this.maxH.fill(0)
    this.raining = true
  }

  refreshGround() {
    const { city, zg } = this
    for (let k = 0; k < zg.length; k++) zg[k] = city.z[k] + city.levee[k]
  }

  rainRate(t) {
    return this.storm ? this.storm.rainAt(t) : 0
  }

  /** Sea level (absolute, m) at simulation time t: mean sea level + tide + surge. */
  seaLevel(t) {
    return this.coast.msl + (this.storm?.seaAt ? this.storm.seaAt(t).level : 0)
  }

  stableDt() {
    return clamp((0.7 * this.dx) / Math.sqrt(G * Math.max(this.hmax, 0.05)), 0.2, 8)
  }

  /** Advance up to `seconds` of simulated time within a CPU budget. */
  advance(seconds, budgetMs = 10) {
    const t0 = performance.now()
    let done = 0
    while (done < seconds) {
      const dt = Math.min(this.stableDt(), seconds - done)
      this.step(dt)
      done += dt
      if (performance.now() - t0 > budgetMs) break
    }
    return done
  }

  step(dt) {
    const { N, dx, zg, h, qx, qy, nn, cls, fixed } = this
    const gdt = G * dt
    const cap = (0.25 * dx) / dt

    // ---- hydrology (rates in m/s)
    const rainMmH = this.raining ? this.rainRate(this.time) : 0
    this.rain = rainMmH
    const r = (rainMmH / 3.6e6) * dt
    this.cumRain += (rainMmH * dt) / 3600
    const th = this.time / 3600
    const infil = this.raining ? ((6 + 24 * Math.exp(-th / 1.5)) / 3.6e6) * dt : 0
    // storm drains back up when the river is near its banks, and on the coast
    // when the sea covers their outfalls (high tide, surge)
    // (flap gates on the outfalls stop the backflow: the drains keep working until the river is right at them)
    let drainEff = clamp(-this.stage / (this.tideGates ? 0.4 : 1.2), 0, 1)
    if (this.coast) {
      this.seaZ = this.seaLevel(this.raining ? this.time : 0)
      this.seaRise = this.seaZ - this.coast.msl
      if (this.raining && this.seaRise > this.seaMax) this.seaMax = this.seaRise
      drainEff *= clamp((this.tideGates ? 2 : 1.5) - this.seaRise, 0, 1)
      if (this.gate) this.operateGate(dt)
    }
    const drain = (this.drainage / 3.6e6) * dt * drainEff
    // upstream hydrograph: lagged runoff of the rain falling on the catchment
    const basin = this.raining && this.storm ? this.storm.catchmentAt(this.time) * UPLAND_RAIN : 0
    this.basinRain = basin
    this.cumBasin += (basin * dt) / 3600
    const tau = 2.5 * 3600
    this.rainLag += ((basin - this.rainLag) * dt) / tau
    const runoffC = 0.25 + 0.55 * (this.cumBasin / (this.cumBasin + 100))
    this.inflow = BASE_FLOW + (this.catchment * runoffC * this.rainLag) / 3.6e6
    if (this.floodway) {
      const q = this.inflow
      this.inflow = divertFlow(q)
      this.diverted = q - this.inflow
      this.divertedVol += this.diverted * dt
    }

    // ---- momentum: x faces
    for (let j = 0; j < N; j++) {
      const row = j * N
      const frow = j * (N - 1)
      for (let i = 0; i < N - 1; i++) {
        const a = row + i
        const b = a + 1
        // nothing moves between two cells of open sea held at the sea level
        if (fixed[a] & fixed[b]) {
          qx[frow + i] = 0
          continue
        }
        const za = zg[a]
        const zb = zg[b]
        const ea = za + h[a]
        const eb = zb + h[b]
        const hf = (ea > eb ? ea : eb) - (za > zb ? za : zb)
        const f = frow + i
        if (hf <= 1e-3) {
          qx[f] = 0
          continue
        }
        let q = qx[f]
        const n = (nn[a] + nn[b]) * 0.5
        q = (q - (gdt * hf * (eb - ea)) / dx) / (1 + (gdt * n * n * (q < 0 ? -q : q)) / (hf * hf * Math.cbrt(hf)))
        const vmax = Math.sqrt(G * hf) * hf
        if (q > vmax) q = vmax
        else if (q < -vmax) q = -vmax
        if (q > 0) {
          const c = cap * h[a]
          if (q > c) q = c
        } else {
          const c = cap * h[b]
          if (-q > c) q = -c
        }
        qx[f] = q
      }
    }
    // ---- momentum: y faces
    for (let j = 0; j < N - 1; j++) {
      const row = j * N
      for (let i = 0; i < N; i++) {
        const a = row + i
        const b = a + N
        if (fixed[a] & fixed[b]) {
          qy[a] = 0
          continue
        }
        const za = zg[a]
        const zb = zg[b]
        const ea = za + h[a]
        const eb = zb + h[b]
        const hf = (ea > eb ? ea : eb) - (za > zb ? za : zb)
        if (hf <= 1e-3) {
          qy[a] = 0
          continue
        }
        let q = qy[a]
        const n = (nn[a] + nn[b]) * 0.5
        q = (q - (gdt * hf * (eb - ea)) / dx) / (1 + (gdt * n * n * (q < 0 ? -q : q)) / (hf * hf * Math.cbrt(hf)))
        const vmax = Math.sqrt(G * hf) * hf
        if (q > vmax) q = vmax
        else if (q < -vmax) q = -vmax
        if (q > 0) {
          const c = cap * h[a]
          if (q > c) q = c
        } else {
          const c = cap * h[b]
          if (-q > c) q = -c
        }
        qy[a] = q
      }
    }

    // ---- continuity + sources/sinks
    let hmax = 0
    let drained = 0
    const k1 = dt / dx
    for (let j = 0; j < N; j++) {
      const row = j * N
      const frow = j * (N - 1)
      for (let i = 0; i < N; i++) {
        const k = row + i
        let net = 0
        if (i > 0) net += qx[frow + i - 1]
        if (i < N - 1) net -= qx[frow + i]
        if (j > 0) net += qy[k - N]
        if (j < N - 1) net -= qy[k]
        let hn = h[k] + net * k1 + r
        const c = cls[k]
        if (c === 0) {
          hn -= hn < infil ? hn : infil
        } else if (c === 1 && drain > 0) {
          const d = hn < drain ? hn : drain
          hn -= d
          drained += d
        }
        if (hn < 0) hn = 0
        h[k] = hn
        if (hn > hmax) hmax = hn
      }
    }
    this.hmax = hmax
    const cellA = dx * dx
    let toRiver = drained * cellA

    // ---- pumps (fail when their own site floods)
    for (const p of this.pumps) {
      if (!p.active || (p.unpowered && !p.generator)) continue
      const pk = p.j * N + p.i
      if (h[pk] > 1.2) {
        p.active = false
        p.failed = true
        continue
      }
      let wet = 0
      for (let dj = -4; dj <= 4; dj++)
        for (let di = -4; di <= 4; di++) {
          const ii = p.i + di
          const jj = p.j + dj
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue
          const kk = jj * N + ii
          if (cls[kk] !== 2) wet += h[kk]
        }
      if (wet <= 0.001) continue
      const vol = Math.min(p.rate * dt, wet * cellA * 0.5)
      const frac = vol / (wet * cellA)
      for (let dj = -4; dj <= 4; dj++)
        for (let di = -4; di <= 4; di++) {
          const ii = p.i + di
          const jj = p.j + dj
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue
          const kk = jj * N + ii
          if (cls[kk] !== 2) h[kk] -= h[kk] * frac
        }
      p.removed += vol
      toRiver += vol
    }

    // ---- flap culverts in the sea wall (~1.5 m² of opening per 10 m of wall)
    for (const [land, sea] of this.flaps) {
      const dh = zg[land] + h[land] - zg[sea] - h[sea]
      if (dh < 0.02 || h[land] < 0.02) continue
      const vol = Math.min(0.6 * 1.5 * Math.sqrt(2 * G * dh) * dt, h[land] * cellA * 0.5)
      h[land] -= vol / cellA
      h[sea] += vol / cellA
    }

    // ---- river: drained water + upstream inflow
    const nr = this.river.length
    if (nr) {
      const add = toRiver / (nr * cellA)
      for (const k of this.river) h[k] += add
    }
    if (this.upstream.length) {
      const add = (this.inflow * dt) / (this.upstream.length * cellA)
      for (const k of this.upstream) h[k] += add
    }
    this.drainedVol += toRiver

    if (this.coast) {
      // ---- the sea: open-sea cells stand at the sea level of the moment
      const sea = this.seaZ
      for (const k of this.seaEdge) h[k] = sea > zg[k] ? sea - zg[k] : 0
    } else {
      // ---- free outflow along the downstream edge (normal-depth Manning)
      const last = (N - 1) * N
      for (let i = 0; i < N; i++) {
        const k = last + i
        const hk = h[k]
        if (hk < 1e-3) continue
        const q = (Math.pow(hk, 5 / 3) * Math.sqrt(RIVER_SLOPE)) / nn[k]
        h[k] = Math.max(0, hk - Math.min(hk * 0.5, q * k1))
      }
    }

    // ---- bookkeeping
    if (this.raining) {
      for (let k = 0; k < h.length; k++) if (h[k] > this.maxH[k]) this.maxH[k] = h[k]
    }
    this.time += dt
    this.dt = dt
    this._stageTimer = (this._stageTimer || 0) + dt
    if (this._stageTimer > 20) {
      this._stageTimer = 0
      this.updateStage()
    }
  }

  /**
   * The river gate is a storm-surge barrier, not a tide gate: it stays open
   * for ordinary tides (a river in flood has to reach the sea) and shuts only
   * when a surge has lifted the sea well above normal and above the river
   * behind it, so the surge can't run up the river. While it is shut, its
   * pumping station lifts river water over it into the sea; it opens once the
   * surge has fallen away and the river stands higher than the sea again.
   * (It compares with the open sea, not the water just outside the gate,
   * where the river rushing out piles up for a few minutes.) It waits 10
   * minutes between movements so it doesn't chatter.
   */
  operateGate(dt) {
    const { gate } = this
    const up = this.rowLevel(gate.j - 2)
    const since = this.time - (this.gateT ?? -1e9)
    const surge = this.seaRise > GATE_SURGE
    if (!this.gateClosed) {
      if (surge && since > 600 && this.seaZ > up + 0.02) this.moveGate(true)
      return
    }
    // shut through the surge (the river's own flow piles up against it for a while); open once the sea has fallen back
    if (since > 600 && this.seaRise < GATE_SURGE - 0.3 && up > this.seaZ) return this.moveGate(false)
    this.pumpOverGate(dt)
  }

  /** The barrier's pumps: river water from just behind the gate to just outside it. */
  pumpOverGate(dt) {
    const { N, h, city, gate } = this
    const cellA = this.dx * this.dx
    const from = []
    const to = []
    for (let i = 0; i < N; i++) {
      const ku = (gate.j - 1) * N + i
      const kd = (gate.j + 1) * N + i
      if (city.cellType[ku] === CELL_RIVER && h[ku] > 0.1) from.push(ku)
      if (city.cellType[kd] === CELL_RIVER) to.push(kd)
    }
    if (!from.length || !to.length) return
    let avail = 0
    for (const k of from) avail += (h[k] - 0.1) * cellA
    const vol = Math.min(GATE_PUMP * dt, avail * 0.5)
    if (vol <= 0) return
    for (const k of from) h[k] -= ((h[k] - 0.1) * cellA * (vol / avail)) / cellA
    for (const k of to) h[k] += vol / to.length / cellA
    this.gatePumped += vol
  }

  /** Mean water level of the channel across row j (river or sea cells near the river's line). */
  rowLevel(j) {
    const { N, h, zg, city } = this
    let s = 0
    let n = 0
    for (let i = 0; i < N; i++) {
      const k = j * N + i
      if (city.cellType[k] !== CELL_RIVER || Math.abs(i + 0.5 - city.riverCenter[j]) > 4 || h[k] < 0.05) continue
      s += zg[k] + h[k]
      n++
    }
    return n ? s / n : this.seaZ
  }

  moveGate(shut) {
    this.gateClosed = shut
    this.gateT = this.time
    this.gateChanges++
    for (const k of this.gate.cells) this.zg[k] = shut ? this.gate.crest : this.city.z[k]
  }

  /**
   * Spread the seawater mark: from every salty cell, across faces where water
   * is flowing out of it into a wet neighbour (run every ~20 s, so it follows
   * a surge up the streets and the river, but not rain water lying behind a
   * wall that held).
   */
  spreadSalt() {
    const { N, h, qx, qy, salt } = this
    const q = []
    for (let k = 0; k < N * N; k++) if (salt[k] && h[k] > 0.05) q.push(k)
    while (q.length) {
      const k = q.pop()
      const i = k % N
      const j = (k - i) / N
      // east, west, south, north: positive flux runs toward +i / +j
      const out = [
        i < N - 1 && qx[j * (N - 1) + i] > 1e-3 ? k + 1 : -1,
        i > 0 && qx[j * (N - 1) + i - 1] < -1e-3 ? k - 1 : -1,
        j < N - 1 && qy[k] > 1e-3 ? k + N : -1,
        j > 0 && qy[k - N] < -1e-3 ? k - N : -1,
      ]
      for (const kk of out) {
        if (kk < 0 || salt[kk] || h[kk] < 0.05) continue
        salt[kk] = 1
        q.push(kk)
      }
    }
  }

  updateStage() {
    // ordinary tides wash in and out of the estuary; only a storm surge carries the sea ashore
    if (this.salt && this.raining && (this.storm?.seaAt?.(this.time)?.surge ?? 0) > 0.5) this.spreadSalt()
    const { N, h, zg, city } = this
    let s = 0
    let n = 0
    // on the coast, the river's own level: upstream of where the sea sets it
    const jEnd = this.coast ? this.coast.shoreMean - 12 : N - 5
    for (const k of this.river) {
      const j = Math.floor(k / N)
      if (j < 5 || j > jEnd) continue
      s += zg[k] + h[k] - city.bankZ[j]
      n++
    }
    this.stage = n ? s / n : -3
    if (this.raining && this.stage > this.stageMax) this.stageMax = this.stage
  }

  depthAt(k) {
    return this.h[k]
  }

  /** Depth-averaged velocity per cell (m/s), for rendering and agents. */
  computeFlow() {
    const { N, qx, qy, h } = this
    if (!this.vx) {
      this.vx = new Float32Array(N * N)
      this.vz = new Float32Array(N * N)
    }
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = j * N + i
        if (h[k] < 0.02) {
          this.vx[k] = this.vz[k] = 0
          continue
        }
        const fx = ((i > 0 ? qx[j * (N - 1) + i - 1] : 0) + (i < N - 1 ? qx[j * (N - 1) + i] : 0)) * 0.5
        const fz = ((j > 0 ? qy[k - N] : 0) + (j < N - 1 ? qy[k] : 0)) * 0.5
        const d = Math.max(h[k], 0.1)
        this.vx[k] = clamp(fx / d, -6, 6)
        this.vz[k] = clamp(fz / d, -6, 6)
      }
  }

  flowAt(i, j) {
    if (!this.vx) return [0, 0]
    const k = j * this.N + i
    return [this.vx[k], this.vz[k]]
  }

  velocityAt(i, j) {
    const { N, qx, qy, h } = this
    const k = j * N + i
    if (h[k] < 0.02) return 0
    const fx = (i > 0 ? qx[j * (N - 1) + i - 1] : 0) + (i < N - 1 ? qx[j * (N - 1) + i] : 0)
    const fy = (j > 0 ? qy[k - N] : 0) + (j < N - 1 ? qy[k] : 0)
    return Math.hypot(fx * 0.5, fy * 0.5) / h[k]
  }
}
