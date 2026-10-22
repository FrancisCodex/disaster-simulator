// Windborne debris: when a piece of roof comes loose, whether it flies, how
// far it gets and how hard it hits whatever is in its way.
//
// Flight initiation (Wills, Lee & Wyatt 2002): a loose plate lifts off once
// the wind exceeds U_f = √(2·ρm·t·g·I / (ρa·C_F)), with ρm its density, t
// its thickness and I how well it is still held (1 = sitting loose).
//
// Flight: a 2-D trajectory in a horizontal wind U, released at rest from
// roof height. A tumbling plate feels drag ½·ρa·C_D·A·|Vr|·Vr and, while it
// autorotates, a lift ½·ρa·C_L·A·|Vr|² across the relative wind (Tachikawa
// 1983; Holmes 2004). The Tachikawa number K = ρa·U²·A / (2·m·g) says which
// wins: roof sheets (K ≈ 40–100 in a typhoon) are picked up and carried at
// nearly the wind's speed; tiles (K ≈ 5) fall within tens of metres.
//
// Impact: kinetic energy ½·m·v² against the glass. Ordinary annealed
// windows break at a few tens of joules (a 2 g steel ball at 40 m/s, the
// ASTM E1996 small missile, carries 1.6 J and still cracks them; a 4 kg
// timber stud at 4.5 m/s, 42 J, is the lowest large-missile level).
//
// Units: m, s, kg, J. Pure functions, no three.js.

import { clamp } from './math.js'

const RHO_AIR = 1.2
const G = 9.81

// m: mass of one piece (kg), A: its area (m²), rho·t: areal density for flight initiation,
// cd / cl: time-averaged drag and autorotation lift of a tumbling piece
export const MISSILES = {
  sheet: { key: 'sheet', name: 'roof sheet', m: 6.0, A: 1.92, rho: 7850, t: 0.0004, cd: 1.17, cl: 0.3 },
  tile: { key: 'tile', name: 'roof tile', m: 4.2, A: 0.14, rho: 2100, t: 0.014, cd: 1.0, cl: 0.15 },
  // rooftop gravel, vents and cladding off a concrete roof
  gravel: { key: 'gravel', name: 'rooftop debris', m: 0.5, A: 0.02, rho: 2400, t: 0.01, cd: 0.8, cl: 0 },
}

/** Wind speed (m/s) that lifts a piece held with fixing factor I off the roof (Wills et al. 2002, C_F ≈ 0.6). */
export const takeOffSpeed = (mis, I = 1) => Math.sqrt((2 * mis.rho * mis.t * G * I) / (RHO_AIR * 0.6))

/** Tachikawa number of a piece in a wind U. */
export const tachikawa = (mis, U) => (RHO_AIR * U * U * mis.A) / (2 * mis.m * G)

// window glass: kinetic energy at 50% breakage (J) and its lognormal spread
export const GLASS_E50 = 35
export const GLASS_BETA = 0.6

const cache = new Map()

/**
 * Trajectory of a piece released at rest h metres up in a wind U (m/s):
 * height y and speed v sampled every metre downwind, until it lands.
 */
export function flightPath(mis, U, h) {
  const Ur = Math.max(0, Math.round(U))
  const hr = Math.max(1, Math.round(h / 2) * 2)
  const key = `${mis.key}|${Ur}|${hr}`
  let path = cache.get(key)
  if (path) return path
  const k = (RHO_AIR * mis.A) / (2 * mis.m)
  const ys = [hr]
  const vs = [0]
  let x = 0
  let y = hr
  let u = 0
  let v = 0
  let next = 1
  const dt = 0.01
  for (let t = 0; t < 60 && x < 600; t += dt) {
    const rx = Ur - u
    const ry = -v
    const R = Math.hypot(rx, ry)
    // drag along the relative wind, lift across it (upward while the wind outruns the piece)
    u += k * R * (mis.cd * rx - mis.cl * ry) * dt
    v += (-G + k * R * (mis.cd * ry + mis.cl * rx)) * dt
    x += u * dt
    y += v * dt
    while (x >= next) {
      ys.push(y)
      vs.push(Math.hypot(u, v))
      next++
    }
    if (y <= 0) break
  }
  path = { ys: Float32Array.from(ys), vs: Float32Array.from(vs), range: Math.max(0, x) }
  if (cache.size > 4000) cache.clear()
  cache.set(key, path)
  return path
}

/** Where the piece is d metres downwind: { y, v, E } while airborne, null once it has landed. */
export function flightAt(mis, U, h, d) {
  const p = flightPath(mis, U, h)
  const n = Math.floor(d)
  if (n + 1 >= p.ys.length) return null
  const f = d - n
  const y = p.ys[n] + (p.ys[n + 1] - p.ys[n]) * f
  if (y <= 0) return null
  const v = p.vs[n] + (p.vs[n + 1] - p.vs[n]) * f
  return { y, v, E: 0.5 * mis.m * v * v }
}

/** Chance that one piece arriving across a target w metres wide d metres downwind passes through it (±15° spread). */
export const hitChance = (w, d, srcW = 10) => clamp(w / (2.5 * (0.27 * d + srcW / 2)), 0, 1)
