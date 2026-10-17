// Ground failure under repeated shaking:
//  - liquefaction of loose saturated sand (Seed & Idriss simplified procedure,
//    with excess pore pressure that builds up over successive shocks and
//    dissipates between them; liquefied sand loses fabric and re-liquefies
//    more easily, as Christchurch did through 2010–2011),
//  - lateral spreading of liquefied ground toward the river's free face,
//  - earthquake-triggered landslides (Newmark rigid sliding block, Jibson 2007
//    displacement regression; slopes that have already slipped are left at
//    residual strength, so each aftershock moves them further),
//  - ground fissures where shaking is violent.
// The terrain heights in city.z are edited in place; the renderer re-reads them.

import { GRID, CELL, CELL_RIVER, CELL_BANK } from './config.js'
import { idx } from './cityGen.js'
import { clamp } from './math.js'

const N = GRID * GRID
const MAX_BOILS = 1600
const MAX_CRACKS = 2400

export class GroundFailure {
  constructor(city, rng) {
    this.city = city
    this.rng = rng
    this.ru = new Float32Array(N) // excess pore-pressure ratio (1 = liquefied)
    this.crr = new Float32Array(N) // cyclic resistance ratio; 0 = not liquefiable
    this.crr0 = new Float32Array(N)
    this.thick = new Float32Array(N) // relative thickness of the loose layer
    this.liqCount = new Uint8Array(N)
    this.settle = new Float32Array(N) // m of settlement so far
    this.spread = new Float32Array(N) // m of lateral spreading so far
    this.crack = new Float32Array(N) // fissure intensity 0..1
    this.slip = new Float32Array(N) // cumulative Newmark displacement (cm)
    this.slid = new Uint8Array(N) // 1 landslide scar, 2 landslide deposit
    this.dS = new Float32Array(N) // settlement during the current shock
    this.dSpread = new Float32Array(N)
    this.slope = new Float32Array(N) // radians
    this.aspX = new Float32Array(N) // unit downslope direction
    this.aspZ = new Float32Array(N)
    this.bankDist = new Float32Array(N) // cells to the river channel
    this.boils = []
    this.cracks = []
    this.slides = []
    this.fxQueue = [] // landslides waiting for their visual effect
    this.liquefied = 0 // cells that have liquefied at least once
    this.dirtyZ = false
    this.dirtyFx = false
    const { z, soil, cellType, riverCenter, bankZ } = city
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const k = idx(i, j)
        this.bankDist[k] = Math.max(0, Math.abs(i + 0.5 - riverCenter[j]) - 3.2)
        // loose saturated sand: young alluvium with a shallow water table
        if (soil[k] === 2 && cellType[k] !== CELL_RIVER && z[k] - bankZ[j] < 3) {
          const c = 0.1 + Math.pow(rng.next(), 1.5) * 0.3
          this.crr[k] = c
          this.crr0[k] = c
          this.thick[k] = 0.6 + rng.next() * 0.8
        }
      }
    this.computeSlopes()
  }

  computeSlopes() {
    const Z = this.city.z
    const at = (i, j) => Z[idx(clamp(i, 0, GRID - 1), clamp(j, 0, GRID - 1))]
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const k = idx(i, j)
        const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * CELL)
        const gz = (at(i, j + 1) - at(i, j - 1)) / (2 * CELL)
        const g = Math.hypot(gx, gz)
        this.slope[k] = Math.atan(g)
        this.aspX[k] = g > 1e-6 ? -gx / g : 0
        this.aspZ[k] = g > 1e-6 ? -gz / g : 0
      }
  }

  /**
   * One shock. pgaAt(k) gives the peak ground acceleration (g) at cell k.
   * Fills dS / dSpread with this shock's ground movement and returns new landslides.
   */
  shock(M, pgaAt) {
    const { city, rng } = this
    this.dS.fill(0)
    this.dSpread.fill(0)
    // magnitude scaling: longer shaking = more load cycles (Idriss 1999)
    const MSF = clamp(Math.pow(10, 2.24) / Math.pow(M, 2.56), 0.7, 2.2)
    let newLiq = 0
    const failing = []
    for (let k = 0; k < N; k++) {
      const t = city.cellType[k]
      if (t === CELL_RIVER) continue
      const a = pgaAt(k)
      // ---- liquefaction
      if (this.crr[k] > 0 && a > 0.1) {
        const csr = 0.65 * a * 1.75 * 0.95 // σv/σv' ≈ 1.75 for a shallow water table, rd ≈ 0.95
        const fs = (this.crr[k] * MSF) / csr
        const before = this.ru[k]
        if (fs <= 1) this.ru[k] = 1
        else this.ru[k] += (1 - this.ru[k]) * clamp(0.7 * Math.pow(1 / fs, 4), 0, 1)
        if (this.ru[k] >= 0.95 && before < 0.9) {
          // a fresh liquefaction episode: sand boils, settlement, spreading
          if (!this.liqCount[k]) this.liquefied++
          this.liqCount[k] = Math.min(255, this.liqCount[k] + 1)
          newLiq++
          const sev = clamp(1 / fs, 1, 3)
          let s = clamp(0.02 + 0.06 * (sev - 0.6), 0.02, 0.2) * this.thick[k] * (this.liqCount[k] > 1 ? 0.65 : 1)
          let sp = 0
          if (this.bankDist[k] < 9) {
            sp = s * 4 * (1 - this.bankDist[k] / 9.5)
            s += sp * 0.25
            this.crack[k] = Math.min(1, this.crack[k] + 0.7)
            this.addCrack(k, 'spread', sp)
          }
          this.dS[k] = s
          this.dSpread[k] = sp
          this.settle[k] += s
          this.spread[k] += sp
          city.z[k] -= s
          this.dirtyZ = true
          // the destroyed sand fabric is easier to liquefy next time
          this.crr[k] = Math.max(this.crr0[k] * 0.65, this.crr[k] * 0.9)
          const nb = 1 + Math.floor(rng.next() * (sev > 1.6 ? 3 : 2))
          for (let q = 0; q < nb; q++) this.addBoil(k, sev)
          this.crack[k] = Math.min(1, this.crack[k] + 0.25)
        }
      }
      // ---- fissures in violently shaken ground
      if (a > 0.45 && t !== CELL_BANK) {
        const inc = (a - 0.45) * 0.5 * rng.next()
        if (inc > 0.05) {
          this.crack[k] = Math.min(1, this.crack[k] + inc)
          if (rng.next() < inc * 1.5) this.addCrack(k, 'shake', inc)
        }
      }
      // ---- slope stability (infinite slope + Newmark sliding block)
      const alpha = this.slope[k]
      if (alpha < 0.2 || this.slid[k] === 1) continue
      const soil = city.soil[k]
      const moved = this.slip[k] > 5
      const c = moved ? 0 : soil === 0 ? 22 : soil === 1 ? 9 : 4 // cohesion (kPa); lost once the slope has moved
      const phi = (soil === 0 ? 38 : 31) * (moved ? 0.85 : 1) * (Math.PI / 180)
      const depth = soil === 0 ? 2 : 3.5
      const gamma = 19
      const sa = Math.sin(alpha)
      const ca = Math.cos(alpha)
      const FS = c / (gamma * depth * sa * ca) + (1 - 0.3 * (9.81 / gamma)) * (Math.tan(phi) / Math.tan(alpha))
      const ac = Math.max(0.02, (FS - 1) * sa)
      // ridges and slope crests amplify shaking
      const amax = a * (1 + clamp((alpha - 0.2) * 1.2, 0, 0.35))
      if (amax <= ac) continue
      const r = ac / amax
      const Dn = Math.pow(10, -2.71 + 0.424 * M) * Math.pow(1 - r, 2.335) * Math.pow(r, -1.478) // cm
      this.slip[k] += Dn
      if (this.slip[k] > 10) failing.push(k)
    }
    const slides = failing.length ? this.runSlides(failing) : []
    if (newLiq || slides.length) this.dirtyFx = true
    return { newLiq, slides }
  }

  /** Group failing cells into slides and move their material downhill. */
  runSlides(failing) {
    const { city, rng } = this
    const Z = city.z
    const set = new Set(failing)
    const out = []
    for (const k0 of failing) {
      if (!set.has(k0)) continue
      const cells = []
      const stack = [k0]
      const inSlide = new Set([k0])
      set.delete(k0)
      while (stack.length) {
        const k = stack.pop()
        cells.push(k)
        const i = k % GRID
        const j = (k - i) / GRID
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const ii = i + di
          const jj = j + dj
          if (ii < 0 || jj < 0 || ii >= GRID || jj >= GRID) continue
          const kk = idx(ii, jj)
          if (set.has(kk)) {
            set.delete(kk)
            stack.push(kk)
          } else if (cells.length + stack.length < 40 && !this.slid[kk] && !inSlide.has(kk) && city.cellType[kk] !== CELL_RIVER && this.slope[kk] > 0.16 && this.slip[kk] > 1.5) {
            // the slide retrogresses into neighbouring slopes that have already crept
            inSlide.add(kk)
            stack.push(kk)
          }
        }
      }
      // material leaves the scar...
      let vol = 0
      const deposit = new Map()
      for (const k of cells) {
        const h = (city.soil[k] === 0 ? 1.6 : 2.8) * (0.6 + rng.next() * 0.5)
        Z[k] -= h
        this.slid[k] = 1
        this.crack[k] = 1
        this.ru[k] = 0
        vol += h * CELL * CELL
        // ...and runs out along the steepest descent until the ground flattens
        let cur = k
        const path = []
        for (let step = 0; step < 14; step++) {
          const i = cur % GRID
          const j = (cur - i) / GRID
          let best = -1
          let bz = Z[cur]
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              if (!di && !dj) continue
              const ii = i + di
              const jj = j + dj
              if (ii < 0 || jj < 0 || ii >= GRID || jj >= GRID) continue
              const kk = idx(ii, jj)
              const zz = Z[kk] + (di && dj ? 0.3 : 0)
              if (zz < bz) {
                bz = zz
                best = kk
              }
            }
          if (best < 0 || city.cellType[best] === CELL_RIVER) break
          cur = best
          if (!set.has(cur) && !cells.includes(cur)) path.push(cur)
          if (this.slope[cur] < 0.06 && path.length >= 2) break
        }
        const tail = path.slice(-4)
        if (!tail.length) continue
        tail.forEach((kk, q) => {
          const w = (q + 1) / ((tail.length * (tail.length + 1)) / 2)
          deposit.set(kk, (deposit.get(kk) || 0) + h * w)
        })
      }
      const dep = []
      for (const [k, d] of deposit) {
        Z[k] += d
        if (!this.slid[k]) this.slid[k] = 2
        dep.push({ k, d })
      }
      const slide = { cells, dep, vol }
      out.push(slide)
      this.slides.push(slide)
      this.fxQueue.push(slide)
      this.dirtyZ = true
    }
    if (out.length) this.computeSlopes()
    return out
  }

  addBoil(k, sev) {
    if (this.boils.length >= MAX_BOILS) return
    const i = k % GRID
    const j = (k - i) / GRID
    this.boils.push({ k, x: (i + 0.15 + this.rng.next() * 0.7) * CELL, z: (j + 0.15 + this.rng.next() * 0.7) * CELL, r: 0.6 + this.rng.next() * 1.2 * sev })
  }

  addCrack(k, kind, amt) {
    if (this.cracks.length >= MAX_CRACKS) return
    const { rng } = this
    const i = k % GRID
    const j = (k - i) / GRID
    // spreading cracks open parallel to the river bank (the river runs north–south)
    const ang = kind === 'spread' ? Math.PI / 2 + (rng.next() - 0.5) * 0.5 : rng.next() * Math.PI
    this.cracks.push({ k, x: (i + 0.2 + rng.next() * 0.6) * CELL, z: (j + 0.2 + rng.next() * 0.6) * CELL, ang, len: 3 + rng.next() * 6, w: clamp(0.15 + amt * 0.6, 0.15, 0.9) })
  }

  /** Excess pore pressure bleeds away between shocks. */
  update(dtH) {
    const f = Math.exp(-dtH / 1.5)
    for (let k = 0; k < N; k++) if (this.ru[k] > 0) this.ru[k] *= f
  }

  /** Mean / spread of this shock's settlement under a footprint. */
  footprint(b) {
    let sum = 0
    let mn = Infinity
    let mx = -Infinity
    let spread = 0
    let slid = 0
    let n = 0
    for (let j = b.y; j < b.y + b.d; j++)
      for (let i = b.x; i < b.x + b.w; i++) {
        const k = idx(i, j)
        const s = this.dS[k]
        sum += s
        mn = Math.min(mn, s)
        mx = Math.max(mx, s)
        spread = Math.max(spread, this.dSpread[k])
        if (this.slid[k] === 1) slid++
        n++
      }
    return { mean: sum / n, diff: mx - mn, spread, slid: slid / n }
  }

  stats() {
    return { slides: this.slides.length, liquefiedHa: (this.liquefied * CELL * CELL) / 1e4, slideVol: this.slides.reduce((s, x) => s + x.vol, 0) }
  }
}
