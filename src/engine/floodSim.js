// 2-D flood hydraulics: the "local inertial" shallow-water scheme used by
// LISFLOOD-FP (Bates et al., 2010). Mass-conserving, with Manning friction,
// rainfall, infiltration, storm drains, pumps, an upstream river hydrograph
// and a free-outflow downstream boundary. Rain comes from a TyphoonSim: on the
// district for the grid, and over the upstream catchment for the river.

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
export function forecastRiverPeak(storm, catchmentRain, tau0, tau1, { dredged = false } = {}) {
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
    const q = BASE_FLOW + (CATCHMENT_M2 * runoffC * lag) / 3.6e6
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
  constructor(city, { storm = null, drainage = 20 } = {}) {
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
      this.cls[k] = t === CELL_RIVER ? 2 : built || t === CELL_ROAD ? 1 : 0
      if (t === CELL_RIVER) {
        this.river.push(k)
        if (k < N * 2) this.upstream.push(k)
      }
      if (t === CELL_POND) this.cls[k] = 0
    }
    this.refreshGround()
    this.pumps = city.pumps.map((p) => ({ ...p, active: true, removed: 0 }))
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
    const { N, dx, zg, h, qx, qy, nn, cls } = this
    const gdt = G * dt
    const cap = (0.25 * dx) / dt

    // ---- hydrology (rates in m/s)
    const rainMmH = this.raining ? this.rainRate(this.time) : 0
    this.rain = rainMmH
    const r = (rainMmH / 3.6e6) * dt
    this.cumRain += (rainMmH * dt) / 3600
    const th = this.time / 3600
    const infil = this.raining ? ((6 + 24 * Math.exp(-th / 1.5)) / 3.6e6) * dt : 0
    // storm drains back up when the river is near its banks
    const drainEff = clamp(-this.stage / 1.2, 0, 1)
    const drain = (this.drainage / 3.6e6) * dt * drainEff
    // upstream hydrograph: lagged runoff of the rain falling on the catchment
    const basin = this.raining && this.storm ? this.storm.catchmentAt(this.time) * UPLAND_RAIN : 0
    this.basinRain = basin
    this.cumBasin += (basin * dt) / 3600
    const tau = 2.5 * 3600
    this.rainLag += ((basin - this.rainLag) * dt) / tau
    const runoffC = 0.25 + 0.55 * (this.cumBasin / (this.cumBasin + 100))
    this.inflow = BASE_FLOW + (this.catchment * runoffC * this.rainLag) / 3.6e6

    // ---- momentum: x faces
    for (let j = 0; j < N; j++) {
      const row = j * N
      const frow = j * (N - 1)
      for (let i = 0; i < N - 1; i++) {
        const a = row + i
        const b = a + 1
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
      if (!p.active || p.unpowered) continue
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
      const vol = Math.min(PUMP_RATE * dt, wet * cellA * 0.5)
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

    // ---- free outflow along the downstream edge (normal-depth Manning)
    const last = (N - 1) * N
    for (let i = 0; i < N; i++) {
      const k = last + i
      const hk = h[k]
      if (hk < 1e-3) continue
      const q = (Math.pow(hk, 5 / 3) * Math.sqrt(RIVER_SLOPE)) / nn[k]
      h[k] = Math.max(0, hk - Math.min(hk * 0.5, q * k1))
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

  updateStage() {
    const { N, h, zg, city } = this
    let s = 0
    let n = 0
    for (const k of this.river) {
      const j = Math.floor(k / N)
      if (j < 5 || j > N - 5) continue
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
