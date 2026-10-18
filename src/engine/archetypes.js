// Building archetypes: turns a building record into the pieces it is drawn
// with. A shape is a few facade "masses" (boxes the facade shader paints with
// windows) plus detail parts (roofs, balconies, columns, spires, rooftop
// plant...). All coordinates are metres in the building's own frame: origin
// at the centre of the footprint at its base, y up, and the street front
// facing +z. Everything is deterministic in b.seed.
//
// The simulation still treats a building as its footprint box (fw × fd ×
// height); masses stay inside that box apart from small overhangs, and
// decorations such as spires or roofs may rise above it.
import * as THREE from 'three'
import { Rng } from './math.js'

// facade styles understood by the building shader
export const F_INDUSTRIAL = 0
export const F_PUNCHED = 1
export const F_RIBBON = 2
export const F_CURTAIN = 3
export const F_CLASSICAL = 4
export const F_PANEL = 5
export const F_HOUSE = 6
export const F_BRICK = 7
// mass flags
export const M_SHOP = 1 // shopfronts on the ground floor
// detail flags
export const D_GROUNDED = 1 // stays on the ground: does not sway, sink or vanish with the building

const GLASS = '#8ea6b4'
const DARK = '#3a3d42'
const METAL = '#8c9196'
const WHITE = '#ebeae4'
const CONCRETE = '#b8b5ac'
const STONE = '#d8d0bf'
const BRICK = '#9a5a44'
const COPPER = '#5f8f80'
const GOLD = '#c9a64a'
const AWNINGS = ['#9b3b33', '#2f5f4a', '#34507a', '#a8783a', '#5a4a6a']

const _c = new THREE.Color()
/** A colour in linear working space, scaled by k (k > 1 lightens). */
export function rgb(c, k = 1) {
  _c.set(c)
  if (k > 1) _c.lerp(new THREE.Color(1, 1, 1), Math.min(1, k - 1))
  else _c.multiplyScalar(k)
  return [_c.r, _c.g, _c.b]
}

class Shape {
  constructor(b, W, D, LW, LD) {
    this.b = b
    this.W = W
    this.D = D
    this.LW = LW // the lot, which may be larger than the footprint
    this.LD = LD
    // the base sits below the lowest corner of the lot: ground level in the building's frame
    this.g0 = Math.max(0, (b.groundZ ?? b.base) - b.base)
    this.masses = []
    this.details = []
  }

  /** A facade-painted box: centre (x, z), bottom y. */
  mass(x, y, z, w, h, d, { style = F_PUNCHED, color = this.b.color, k = 1, fh = this.b.floorH, flags = 0, ry = 0 } = {}) {
    this.masses.push({ x, y, z, w, h, d, ry, style, fh, flags, color: rgb(color, k) })
  }

  part(g, x, y, z, w, h, d, color, { ry = 0, k = 1, flags = 0 } = {}) {
    this.details.push({ g, x, y, z, w, h, d, ry, flags, color: rgb(color, k) })
  }

  box(x, y, z, w, h, d, color, o) {
    this.part('box', x, y, z, w, h, d, color, o)
  }

  cyl(x, y, z, r, h, color, o) {
    this.part('cyl', x, y, z, 2 * r, h, 2 * r, color, o)
  }

  /** Gable roof on a w × d rectangle, ridge along the longer side. */
  gable(x, y, z, w, d, h, color, g = 'gable') {
    if (w >= d) this.part(g, x, y, z, w, h, d, color)
    else this.part(g, x, y, z, d, h, w, color, { ry: Math.PI / 2 })
  }

  /** Columns in a row along x. */
  colonnade(x0, x1, z, y, h, r, n, color) {
    for (let q = 0; q < n; q++) this.cyl(n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * q) / (n - 1), y, z, r, h, color)
  }

  /** A classical portico: steps, columns, entablature and pediment, in front of z = zf. */
  portico(x, zf, w, h, n, color, depth = 3.2) {
    const zc = zf + depth / 2
    const g = this.g0
    for (let s = 0; s < 3; s++) this.box(x, 0, zf + depth + 0.5 - s * 0.5, w + 1.6 - s * 0.4, g + 0.35 * (s + 1), 1.2 + s * 0.5, CONCRETE, { k: 1.3 })
    this.box(x, 0, zc, w, g + 1.05, depth, color, { k: 0.95 })
    this.colonnade(x - w / 2 + 0.7, x + w / 2 - 0.7, zf + depth - 0.7, g + 1.05, h - g - 1.05, Math.min(0.55, h * 0.06), n, color)
    this.box(x, h, zc, w, 1.1, depth, color, { k: 1.05 })
    this.part('gable', x, h + 1.1, zc, w, Math.min(3, w * 0.22), depth, color, { k: 0.97 })
  }

  /** Dome on a drum with a lantern, centred at (x, z) on a roof at y. */
  dome(x, y, z, r, color = COPPER, drum = STONE) {
    this.cyl(x, y, z, r * 1.06, r * 0.7, drum)
    this.part('dome', x, y + r * 0.7, z, 2 * r, r, 2 * r, color)
    this.cyl(x, y + r * 1.62, z, r * 0.18, r * 0.45, drum)
    this.part('cone', x, y + r * 2.05, z, r * 0.4, r * 0.4, r * 0.4, color)
  }

  /** Stair and lift overruns, plant and tanks scattered on a flat roof. */
  roofClutter(r, y, w, d, { tank = false, antenna = false, mech = true, color = CONCRETE, ox = 0, oz = 0 } = {}) {
    if (w < 6 || d < 6) return
    if (mech) {
      const pw = Math.min(w * 0.35, 3 + r.float(0, 3))
      const pd = Math.min(d * 0.35, 3 + r.float(0, 2))
      this.box(ox + r.float(-1, 1) * (w - pw) * 0.3, y, oz + r.float(-1, 1) * (d - pd) * 0.3, pw, 3, pd, color, { k: 0.95 })
    }
    const n = Math.min(5, Math.floor((w * d) / 140))
    for (let q = 0; q < n; q++) this.box(ox + r.float(-0.4, 0.4) * w, y, oz + r.float(-0.4, 0.4) * d, 1.4, 1.1, 1.9, METAL, { k: r.float(0.85, 1.1) })
    if (tank) {
      const tx = ox + r.float(-0.25, 0.25) * w
      const tz = oz + r.float(-0.25, 0.25) * d
      this.box(tx, y, tz, 2.6, 1.4, 2.6, DARK)
      this.cyl(tx, y + 1.4, tz, 1.4, 2.8, '#7a5b42')
      this.part('cone', tx, y + 4.2, tz, 3, 0.9, 3, '#4f4a44')
    }
    if (antenna) this.cyl(ox + r.float(-0.2, 0.2) * w, y, oz + r.float(-0.2, 0.2) * d, 0.18, 6 + r.float(0, 8), METAL)
  }

  /** Balconies on the front (+z) and back faces of a w-wide slab. */
  balconies(r, x, w, d, f0, f1, fh, color, every = 1, sides = 2, dep = 1.4) {
    const nb = Math.max(1, Math.round(w / 3.4))
    const bw = w / nb
    const pattern = r.int(0, 2)
    let budget = 220
    for (let f = f0; f < f1; f++)
      for (let q = 0; q < nb; q++) {
        if (pattern === 1 && (q + f) % 2) continue
        if (pattern === 2 && q % 3 === 1) continue
        if (q % every) continue
        for (let s = 0; s < sides; s++) {
          if (budget-- <= 0) return
          const sg = s ? -1 : 1
          this.box(x - w / 2 + bw * (q + 0.5), f * fh, sg * (d / 2 + dep / 2), bw * 0.82, 1.05, dep, color)
        }
      }
  }

  /** Continuous balcony bands wrapping a slab at every floor. */
  bands(x, z, w, d, f0, f1, fh, slab, rail) {
    for (let f = f0; f < f1; f++) {
      this.box(x, f * fh - 0.25, z, w + 2.6, 0.25, d + 2.6, slab)
      this.box(x, f * fh, z, w + 2.4, 1.0, d + 2.4, rail)
    }
  }
}

// ------------------------------------------------------------- residential
function house(S, b, r) {
  const { W, D } = S
  const H = b.floors * b.floorH
  const roof = b.roofColor ?? '#6d3b2f'
  const old = b.construction === 'wood_old' || b.construction === 'urm'
  const v = r.weighted({ gable: 3, hip: 2, lshape: W > 9 && D > 9 ? 2 : 0, modern: old ? 0.3 : 1.6, cottage: old ? 2 : 0.4 })
  const style = b.construction === 'urm' ? F_BRICK : F_HOUSE
  const chimney = (x, z, top) => S.box(x, H - 0.5, z, 0.9, top - H + 1.6, 0.9, b.construction === 'urm' ? BRICK : '#8a7f72')
  if (v === 'modern') {
    S.mass(0, 0, 0, W * 0.9, Math.min(H, 3), D * 0.9, { style: F_RIBBON, fh: 3 })
    if (b.floors > 1) {
      const off = r.float(-0.12, 0.12) * W
      S.mass(off, 3, -D * 0.04, W * 0.72, H - 3, D * 0.82, { style: F_RIBBON, fh: 3, k: r.float(0.9, 1.1) })
      S.box(off, H, -D * 0.04, W * 0.76, 0.3, D * 0.86, DARK)
      S.box(-off * 0.5, 3, D * 0.4, W * 0.5, 1, 0.08, GLASS, { k: 1.3 })
    }
    S.box(0, Math.min(H, 3), 0, W * 0.94, 0.3, D * 0.94, DARK)
    S.box(W * 0.3, 2.6, D * 0.45 + 1, W * 0.3, 0.2, 2, DARK)
    return
  }
  if (v === 'lshape') {
    S.mass(0, 0, -D * 0.2, W, H, D * 0.6, { style })
    const ww = W * 0.45
    S.mass(-W / 2 + ww / 2, 0, D * 0.3, ww, H, D * 0.4 + 0.01, { style })
    const rh = Math.min(W, D * 0.6) * 0.36
    S.gable(0, H, -D * 0.2, W * 1.06, D * 0.6 * 1.12, rh, roof)
    S.part('gable', -W / 2 + ww / 2, H, D * 0.3 + 0.4, D * 0.42, rh * 0.85, ww * 1.1, roof, { ry: Math.PI / 2 })
    chimney(W * 0.3, -D * 0.3, H + rh)
    S.box(W * 0.15, 2.5, D * 0.1 + 0.9, 3.2, 0.2, 1.8, roof)
    S.box(W * 0.15 + 1.4, 0, D * 0.1 + 1.6, 0.18, 2.5, 0.18, WHITE)
  } else {
    const cottage = v === 'cottage'
    const w = cottage ? W * 0.85 : W
    const d = cottage ? D * 0.8 : D
    // a garage wing beside wider houses
    const garage = !cottage && W >= 11 && r.chance(0.45)
    const mw = garage ? w - 4 : w
    const mx = garage ? -2 : 0
    S.mass(mx, 0, 0, mw, H, d, { style })
    const rh = Math.min(mw, d) * (cottage ? 0.55 : 0.36)
    if (v === 'hip') S.gable(mx, H, 0, mw * 1.08, d * 1.1, rh, roof, 'hip')
    else S.gable(mx, H, 0, mw * 1.06, d * 1.12, rh, roof)
    chimney(mx + mw * 0.28 * (r.chance(0.5) ? 1 : -1), -d * 0.15, H + rh)
    if (cottage && mw >= d) {
      // a dormer in the front slope
      S.box(mx, H - 0.2, d * 0.12, 1.8, 1.5, 1.6, b.color)
      S.part('gable', mx, H + 1.3, d * 0.12, 2.2, 0.9, 2.0, roof, { ry: Math.PI / 2 })
    }
    if (garage) {
      S.mass(w / 2 - 2, 0, d * 0.05, 3.9, 3, d * 0.85, { style: F_PANEL, fh: 3, k: 0.95 })
      S.box(w / 2 - 2, 3, d * 0.05, 4.1, 0.25, d * 0.88, DARK)
      S.box(w / 2 - 2, S.g0, d * 0.475 + 0.05, 2.9, 2.2, 0.1, '#d6d4cc')
    }
    // porch
    const pw = Math.min(4.5, mw * 0.5)
    const px = mx + (r.chance(0.5) ? -1 : 1) * Math.max(0, (mw - pw) / 2 - 0.8)
    S.box(px, 2.55, d / 2 + 0.9, pw, 0.22, 1.9, roof, { k: 0.9 })
    S.box(px - pw / 2 + 0.2, 0, d / 2 + 1.7, 0.18, 2.55, 0.18, WHITE)
    S.box(px + pw / 2 - 0.2, 0, d / 2 + 1.7, 0.18, 2.55, 0.18, WHITE)
    S.box(px, 0, d / 2 + 0.9, pw, S.g0 + 0.3, 1.9, CONCRETE)
  }
  // a fence or hedge along the sides and back of the lot
  if (r.chance(0.55)) {
    const hedge = r.chance(0.5)
    const c = hedge ? '#3f5f33' : r.chance(0.5) ? WHITE : '#7a6250'
    const h = (hedge ? 1.3 : 1.0) + S.g0
    const t = hedge ? 0.8 : 0.1
    const lw = S.LW - 1.2
    const ld = S.LD - 1.2
    S.box(0, 0, -ld / 2, lw, h, t, c, { flags: D_GROUNDED })
    S.box(-lw / 2, 0, 0, t, h, ld, c, { flags: D_GROUNDED })
    S.box(lw / 2, 0, 0, t, h, ld, c, { flags: D_GROUNDED })
  }
}

function apartment(S, b, r) {
  const { W, D } = S
  const fh = b.floorH
  const F = b.floors
  const H = b.height
  const old = b.construction === 'urm' || (b.construction === 'rc_low' && r.chance(0.4))
  const rail = r.chance(0.5) ? rgbHex(GLASS, 1.25) : b.color
  let v
  if (b.arch === 'dorm') v = r.chance(0.5) ? 'bands' : 'balcony'
  else if (old && F <= 6) v = 'walkup'
  else v = r.weighted({ balcony: 3, bands: 1.5, stepped: F >= 7 ? 1.5 : 0, court: W >= 20 && D >= 20 && F <= 9 ? 1.2 : 0, walkup: F <= 5 ? 0.6 : 0 })
  if (v === 'walkup') {
    const shop = r.chance(0.55)
    S.mass(0, 0, 0, W, H, D, { style: F_BRICK, flags: shop ? M_SHOP : 0 })
    S.box(0, H - 0.7, 0, W + 0.7, 0.7, D + 0.7, STONE, { k: 0.95 })
    if (shop) for (let x = -W / 2 + 2; x < W / 2 - 1.5; x += 4) S.part('shed', x + 1.5, 2.6, D / 2 + 0.8, 3.2, 0.8, 1.6, r.pick(AWNINGS))
    // a fire escape zig-zags down the front
    const fx = r.float(-0.2, 0.2) * W
    for (let f = 1; f < F; f++) {
      S.box(fx, f * fh, D / 2 + 0.65, 3.2, 0.12, 1.3, DARK)
      S.box(fx, f * fh, D / 2 + 1.28, 3.2, 0.95, 0.06, DARK)
    }
    if (F > 1) S.box(fx + 1.5, fh, D / 2 + 0.65, 0.08, (F - 1) * fh, 0.08, DARK)
    S.roofClutter(r, H, W, D, { tank: r.chance(0.6), mech: true })
    return
  }
  if (v === 'court') {
    // a U around a courtyard, open to the street
    const t = D * 0.38
    const s = W * 0.32
    S.mass(0, 0, -D / 2 + t / 2, W, H, t)
    S.mass(-W / 2 + s / 2, 0, t / 2, s, H, D - t)
    S.mass(W / 2 - s / 2, 0, t / 2, s, H, D - t)
    S.balconies(r, 0, W, t, 1, F, fh, rail, 1, 1)
    S.box(0, H, -D / 2 + t / 2, 4, 3, 3, CONCRETE)
    return
  }
  if (v === 'stepped') {
    // terraces step back from the street as the block rises
    const tiers = F >= 12 ? 3 : 2
    let f0 = 0
    let d = D
    for (let q = 0; q < tiers; q++) {
      const f1 = q === tiers - 1 ? F : Math.round((F * (q + 1)) / (tiers + 0.6))
      const z = -(D - d) / 2
      const top = q === tiers - 1 ? H : f1 * fh
      S.mass(0, f0 * fh, z, W, top - f0 * fh, d)
      S.balconies(r, 0, W, d, Math.max(1, f0), f1, fh, rail, 1, 1)
      if (q < tiers - 1) S.box(0, f1 * fh, z + d / 2 - 0.05, W, 1.0, 0.12, GLASS, { k: 1.3 })
      f0 = f1
      d *= 0.72
    }
    d /= 0.72
    S.roofClutter(r, H, W, d, { mech: true, oz: -(D - d) / 2 })
    return
  }
  S.mass(0, 0, 0, W, H, D, { style: v === 'bands' ? F_RIBBON : F_PUNCHED })
  if (v === 'bands') S.bands(0, 0, W, D, 1, F, fh, rgbHex(b.color, 1.15), rail)
  else S.balconies(r, 0, W, D, 1, F, fh, rail)
  S.roofClutter(r, H, W, D, { tank: F < 8 && r.chance(0.3), antenna: r.chance(0.3) })
}

// -------------------------------------------------------------- commercial
function office(S, b, r) {
  const { W, D } = S
  const fh = b.floorH
  const F = b.floors
  const H = b.height
  if ((b.construction === 'urm' || F <= 3) && r.chance(b.construction === 'urm' ? 0.9 : 0.5)) {
    // main-street commercial: brick, shopfronts, awnings and a decorated parapet
    S.mass(0, 0, 0, W, H, D, { style: F_BRICK, flags: M_SHOP })
    S.box(0, H - 0.6, 0, W + 0.6, 0.6, D + 0.6, STONE)
    S.box(0, H, D / 2 - 0.3, W * 0.35, 1.3, 0.5, b.color)
    const c = r.pick(AWNINGS)
    for (let x = -W / 2 + 2.2; x < W / 2 - 1.5; x += 4.4) S.part('shed', x + 1.2, 2.7, D / 2 + 0.9, 3.6, 0.9, 1.8, c)
    S.roofClutter(r, H, W, D, { mech: false })
    return
  }
  const v = r.weighted({ podium: F >= 6 ? 2 : 0, block: 2, notch: 1, glass: F >= 6 ? 1.2 : 0 })
  if (v === 'podium') {
    const p = Math.min(3, F - 3)
    S.mass(0, 0, 0, W, p * fh, D, { style: F_RIBBON, flags: M_SHOP, k: 0.88 })
    S.mass(0, p * fh, -D * 0.06, W * 0.8, H - p * fh, D * 0.76, { style: r.chance(0.5) ? F_CURTAIN : F_RIBBON })
    S.roofClutter(r, H, W * 0.8, D * 0.76, { antenna: r.chance(0.4) })
  } else if (v === 'notch') {
    S.mass(0, 0, -D * 0.2, W, H, D * 0.6, { style: F_RIBBON, flags: M_SHOP })
    const f2 = Math.max(1, Math.round(F * r.float(0.45, 0.75)))
    S.mass(-W * 0.2, 0, D * 0.3, W * 0.6, f2 * fh + 1, D * 0.4, { style: F_RIBBON, flags: M_SHOP, k: 0.92 })
    S.roofClutter(r, H, W, D * 0.6, { oz: -D * 0.2 })
  } else {
    S.mass(0, 0, 0, W, H, D, { style: v === 'glass' ? F_CURTAIN : F_RIBBON, flags: M_SHOP })
    S.roofClutter(r, H, W, D, { antenna: r.chance(0.35) })
  }
  // entrance canopy
  S.box(0, 3.6, D / 2 + 1.2, Math.min(8, W * 0.4), 0.3, 2.6, DARK)
}

function tower(S, b, r) {
  const { W, D } = S
  const fh = b.floorH
  const F = b.floors
  const H = b.height
  const m = Math.min(W, D)
  const v = r.weighted({ setback: 2, podium: 2.5, octagon: 1, twin: W > 26 || D > 26 ? 1.2 : 0, taper: 1.2, residential: 1.4 })
  const spire = (y, base, h) => {
    S.part('pyr', 0, y, 0, base, h * 0.25, base, METAL)
    S.cyl(0, y + h * 0.25, 0, 0.35, h * 0.75, METAL, { k: 1.1 })
  }
  if (v === 'setback') {
    // art-deco wedding cake: tiers step in towards a spire
    const style = r.chance(0.5) ? F_PUNCHED : F_CURTAIN
    const cuts = [0, Math.round(F * 0.55), Math.round(F * 0.8), F]
    const sizes = [1, 0.78, 0.56]
    for (let q = 0; q < 3; q++) {
      const y0 = cuts[q] * fh
      const y1 = q === 2 ? H : cuts[q + 1] * fh
      S.mass(0, y0, 0, W * sizes[q], y1 - y0, D * sizes[q], { style, k: 1 - q * 0.04 })
      if (q < 2) S.box(0, y1 - 0.6, 0, W * sizes[q] + 0.5, 0.6, D * sizes[q] + 0.5, STONE, { k: 0.95 })
    }
    spire(H, m * 0.3, H * 0.16)
    return
  }
  if (v === 'octagon') {
    const s = m * 0.78
    S.mass(0, 0, 0, W, 4 * fh, D, { style: F_RIBBON, flags: M_SHOP, k: 0.9 })
    S.mass(0, 4 * fh, 0, s, H - 4 * fh, s, { style: F_CURTAIN })
    S.mass(0, 4 * fh, 0, s, H - 4 * fh, s, { style: F_CURTAIN, ry: Math.PI / 4, k: 0.96 })
    S.part('pyr', 0, H, 0, s * 0.95, Math.min(14, H * 0.08), s * 0.95, METAL, { ry: Math.PI / 8 })
    return
  }
  if (v === 'twin') {
    const wide = W >= D
    const a = (wide ? W : D) * 0.52
    const f2 = Math.round(F * r.float(0.6, 0.85))
    const o = (wide ? W : D) / 2 - a / 2
    if (wide) {
      S.mass(-o, 0, 0, a, H, D, { style: F_CURTAIN })
      S.mass(o, 0, D * 0.06, a, f2 * fh + 1, D * 0.88, { style: F_CURTAIN, k: 0.9 })
    } else {
      S.mass(0, 0, -o, W, H, a, { style: F_CURTAIN })
      S.mass(W * 0.06, 0, o, W * 0.88, f2 * fh + 1, a, { style: F_CURTAIN, k: 0.9 })
    }
    S.roofClutter(r, H, wide ? a : W, wide ? D : a, { antenna: true, ox: wide ? -o : 0, oz: wide ? 0 : -o })
    return
  }
  if (v === 'taper') {
    const n = 5
    for (let q = 0; q < n; q++) {
      const y0 = Math.round((F * q) / n) * fh
      const y1 = q === n - 1 ? H : Math.round((F * (q + 1)) / n) * fh
      const s = 1 - q * 0.075
      S.mass(0, y0, 0, W * s, y1 - y0, D * s, { style: F_CURTAIN, k: 1 - q * 0.02 })
    }
    spire(H, m * 0.25, H * 0.12)
    return
  }
  // podium + shaft, or a residential tower with balcony bands
  const p = Math.min(5, Math.max(2, Math.round(F * 0.12)))
  const res = v === 'residential'
  S.mass(0, 0, 0, W, p * fh, D, { style: F_RIBBON, flags: M_SHOP, k: 0.86 })
  const sw = W * 0.74
  const sd = D * 0.74
  S.mass(0, p * fh, 0, sw, H - p * fh, sd, { style: res ? F_PUNCHED : F_CURTAIN })
  if (res) S.bands(0, 0, sw, sd, p + 1, F, fh, rgbHex(b.color, 1.15), rgbHex(GLASS, 1.2))
  // crown: plant screen and maybe a helipad
  S.box(0, H, 0, sw * 0.6, 4, sd * 0.6, CONCRETE, { k: 0.9 })
  if (r.chance(0.5)) {
    const R = Math.min(sw, sd) * 0.24
    S.cyl(0, H + 4, 0, R, 0.4, DARK)
    S.box(-R * 0.3, H + 4.4, 0, R * 0.12, 0.06, R * 0.8, WHITE)
    S.box(R * 0.3, H + 4.4, 0, R * 0.12, 0.06, R * 0.8, WHITE)
    S.box(0, H + 4.4, 0, R * 0.6, 0.06, R * 0.12, WHITE)
  } else S.cyl(sw * 0.2, H + 4, 0, 0.3, 10 + r.float(0, 12), METAL)
}

// --------------------------------------------------------------- industry
function industrial(S, b, r) {
  const { W, D } = S
  const H = b.height
  const v = r.weighted({ sawtooth: 2, warehouse: 2, plant: 1.5 })
  if (v === 'sawtooth') {
    S.mass(0, 0, 0, W, H, D, { style: F_INDUSTRIAL })
    const n = Math.max(2, Math.round(D / 6))
    for (let q = 0; q < n; q++) S.part('shed', 0, H, -D / 2 + (D / n) * (q + 0.5), W, 2.4, D / n, '#7f878c')
    S.box(W * 0.3, 0, D / 2 + 0.1, 4, 4.5, 0.2, '#5c6268')
    return
  }
  if (v === 'warehouse') {
    S.mass(0, 0, -D * 0.1, W, H, D * 0.8, { style: F_INDUSTRIAL })
    S.gable(0, H, -D * 0.1, W * 1.02, D * 0.82, Math.min(W, D) * 0.1, '#80868a')
    const n = Math.max(1, Math.floor(W / 6))
    for (let q = 0; q < n - 1; q++) S.box(-W / 2 + 6 * (q + 1), 0.4, D * 0.3 + 0.1, 3.6, 4, 0.2, '#596066')
    S.box(0, 4.6, D * 0.3 + 1.2, W * 0.9, 0.25, 2.4, DARK)
    // office annex at the front corner
    S.mass(-W / 2 + W * 0.15, 0, D * 0.4, W * 0.3, 7, D * 0.2, { style: F_RIBBON, fh: 3.5, k: 1.05 })
    return
  }
  // process plant: shed, silos and a stack
  S.mass(-W * 0.17, 0, 0, W * 0.66, H, D, { style: F_INDUSTRIAL })
  S.gable(-W * 0.17, H, 0, W * 0.67, D * 1.02, 1.5, '#80868a')
  const sr = Math.min(W * 0.1, D * 0.16, 2.8)
  const n = Math.max(2, Math.min(4, Math.floor(D / (2 * sr + 0.8))))
  for (let q = 0; q < n; q++) {
    const z = -D / 2 + (D / n) * (q + 0.5)
    S.cyl(W / 2 - sr - 0.5, 0, z, sr, H + 7, '#c9c6bd')
    S.part('cone', W / 2 - sr - 0.5, H + 7, z, 2 * sr, sr * 0.6, 2 * sr, '#9a978e')
  }
  S.cyl(-W * 0.4, 0, -D * 0.35, 0.9, H + 16, '#9b4a3a')
  S.cyl(-W * 0.4, H + 13, -D * 0.35, 0.95, 1.5, WHITE)
  S.box(W * 0.15, H - 1.5, 0, W * 0.35, 0.8, 0.8, METAL)
}

// --------------------------------------------------------------- services
function hospital(S, b, r) {
  const { W, D } = S
  const fh = b.floorH
  const H = b.height
  S.mass(0, 0, 0, W, 2 * fh, D, { style: F_RIBBON, k: 0.95 })
  const sd = D * 0.46
  S.mass(0, 0, -D / 2 + sd / 2, W * 0.86, H, sd, { style: F_PUNCHED })
  if (W > 24) S.mass(W * 0.3, 0, 0, W * 0.25, H - 2 * fh, D * 0.7, { style: F_PUNCHED, k: 0.97 })
  // emergency entrance canopy
  S.box(-W * 0.2, 4.2, D / 2 + 2, 10, 0.4, 4.5, '#c9302c')
  S.box(-W * 0.2 - 4.6, 0, D / 2 + 4, 0.3, 4.2, 0.3, WHITE)
  S.box(-W * 0.2 + 4.6, 0, D / 2 + 4, 0.3, 4.2, 0.3, WHITE)
  // helipad on the ward block
  const R = Math.min(W * 0.2, sd * 0.4)
  S.cyl(-W * 0.2, H, -D / 2 + sd / 2, R, 0.5, '#4b4f55')
  S.box(-W * 0.2 - R * 0.3, H + 0.5, -D / 2 + sd / 2, R * 0.12, 0.06, R * 0.8, WHITE)
  S.box(-W * 0.2 + R * 0.3, H + 0.5, -D / 2 + sd / 2, R * 0.12, 0.06, R * 0.8, WHITE)
  S.box(-W * 0.2, H + 0.5, -D / 2 + sd / 2, R * 0.6, 0.06, R * 0.12, WHITE)
  S.roofClutter(r, H, W * 0.3, sd, { mech: true, ox: W * 0.2, oz: -D / 2 + sd / 2 })
}

function fireStation(S, b) {
  const { W, D } = S
  const H = b.height
  S.mass(0, 0, 0, W, H, D, { style: F_BRICK })
  S.box(0, H - 0.6, 0, W + 0.5, 0.6, D + 0.5, STONE)
  // apparatus bay doors
  const n = Math.max(2, Math.min(4, Math.floor(W / 5.5)))
  for (let q = 0; q < n; q++) S.box(-W / 2 + (W / n) * (q + 0.5), 0.2, D / 2 + 0.06, Math.min(4, W / n - 1), 4.2, 0.12, '#dcdad2')
  // hose-drying tower
  S.mass(W / 2 - 2, 0, -D / 2 + 2, 4, H + 7, 4, { style: F_BRICK, k: 0.9 })
  S.part('pyr', W / 2 - 2, H + 7, -D / 2 + 2, 4.6, 2, 4.6, '#4c5560')
  S.cyl(-W / 2 - 1, 0, D / 2 + 2, 0.08, 9, METAL, { flags: D_GROUNDED })
  S.box(-W / 2 - 0.2, 7.4, D / 2 + 2, 1.6, 1, 0.05, '#b8433a', { flags: D_GROUNDED })
}

function shelter(S, b) {
  const { W, D } = S
  const H = b.height
  S.mass(0, 0, 0, W, H, D, { style: F_PANEL })
  S.part('barrel', 0, H, 0, W >= D ? W : D, Math.min(W, D) * 0.18, W >= D ? D : W, '#5d8f6a', { ry: W >= D ? 0 : Math.PI / 2 })
  S.box(0, 3.5, D / 2 + 1.5, 6, 0.3, 3, DARK)
}

// ------------------------------------------------------------------ schools
function school(S, b, r) {
  const { W, D } = S
  const fh = b.floorH
  const H = b.height
  const accent = r.pick(['#c9483a', '#2f7a9e', '#4f8f4a', '#d39a2e'])
  switch (b.arch) {
    case 'gym': {
      S.mass(0, 0, 0, W, H, D, { style: F_PANEL, k: 0.95 })
      S.part('barrel', 0, H, 0, W >= D ? W : D, Math.min(W, D) * 0.16, W >= D ? D : W, '#7d8c94', { ry: W >= D ? 0 : Math.PI / 2 })
      S.box(0, H - 2, D / 2 + 0.05, W * 0.8, 1.2, 0.1, GLASS)
      return
    }
    case 'uni_hall':
      return classicalHall(S, b, r, { dome: true })
    case 'uni_wing':
      S.mass(0, 0, 0, W, H, D, { style: F_BRICK })
      S.gable(0, H, 0, W * 1.04, D * 1.06, Math.min(W, D) * 0.3, b.roofColor ?? '#4f5a5e', 'hip')
      return
    case 'uni_lab': {
      S.mass(0, 0, 0, W, H, D, { style: F_CURTAIN })
      const n = Math.min(12, Math.floor(W / 2.2))
      for (let q = 0; q <= n; q++) S.box(-W / 2 + (W / n) * q, 0, D / 2 + 0.5, 0.25, H, 1.0, WHITE)
      S.roofClutter(r, H, W, D, { mech: true })
      return
    }
    case 'high': {
      S.mass(0, 0, 0, W, H, D, { style: F_PUNCHED })
      const ew = Math.min(10, W * 0.25)
      S.mass(0, 0, 0.6, ew, H + fh, D + 1.2, { style: F_CURTAIN })
      S.box(0, 3.4, D / 2 + 2.4, ew + 2, 0.3, 3.2, accent)
      S.roofClutter(r, H, W, D, { mech: true })
      S.cyl(ew / 2 + 3, 0, D / 2 + 5, 0.08, 9, METAL, { flags: D_GROUNDED })
      S.box(ew / 2 + 3.8, 7.4, D / 2 + 5, 1.6, 1, 0.05, accent, { flags: D_GROUNDED })
      return
    }
    default: {
      // primary school: a friendly L with a coloured entrance
      S.mass(0, 0, -D * 0.15, W, H, D * 0.7, { style: F_PUNCHED })
      const ww = W * 0.38
      S.mass(-W / 2 + ww / 2, 0, D * 0.35, ww, Math.max(fh + 1, H - fh), D * 0.3, { style: F_PUNCHED, k: 0.95 })
      S.part('shed', 0, H, -D * 0.15, W * 1.04, 1.6, D * 0.72, b.roofColor ?? '#6d6a64')
      for (let q = 0; q < 3; q++) S.box(W * 0.05 + q * 2.2, 0, D * 0.2 + 0.25, 1.4, H - 1, 0.3, ['#c9483a', '#2f7a9e', '#d39a2e'][q])
      S.box(W * 0.25, 3.2, D * 0.2 + 1.6, 5, 0.3, 3, accent)
    }
  }
}

// ----------------------------------------------------------- civic & culture
function classicalHall(S, b, r, { dome = false, tower = false } = {}) {
  const { W, D } = S
  const fh = b.floorH
  const H = b.height
  const stone = b.color
  S.mass(0, 0, 0, W, H, D, { style: F_CLASSICAL })
  S.box(0, H - 0.8, 0, W + 0.8, 0.8, D + 0.8, stone, { k: 1.08 })
  // central pavilion pushed forward, with the portico
  const pw = Math.max(8, W * 0.32)
  S.mass(0, 0, 0.75, pw, H + 1.5, D + 1.5, { style: F_CLASSICAL, k: 1.04 })
  const ph = Math.min(H - 1, 2 * fh)
  S.portico(0, D / 2 + 1.5, pw, ph, pw > 14 ? 8 : 6, stone)
  if (dome) S.dome(0, H + 1.5, 0, Math.min(pw * 0.38, D * 0.32), b.roofColor ?? COPPER, stone)
  if (tower) {
    const tw = Math.min(6, pw * 0.4)
    const tz = -D * 0.15
    S.mass(0, H, tz, tw, 12, tw, { style: F_CLASSICAL, k: 1.06 })
    clockFaces(S, 0, H + 8.5, tz, tw)
    S.part('pyr', 0, H + 12, tz, tw * 1.1, tw * 0.9, tw * 1.1, b.roofColor ?? COPPER)
    S.cyl(0, H + 12 + tw * 0.9, 0 + tz, 0.12, 3, GOLD)
  }
  if (!dome && !tower) S.gable(0, H, 0, W * 0.98, D * 0.98, Math.min(W, D) * 0.12, b.roofColor ?? '#5e6a6e', 'hip')
}

function clockFaces(S, x, y, z, w) {
  for (let s = 0; s < 4; s++) {
    const nx = s === 1 ? 1 : s === 3 ? -1 : 0
    const nz = s === 0 ? 1 : s === 2 ? -1 : 0
    const fx = x + (nx * (w / 2 + 0.06))
    const fz = z + (nz * (w / 2 + 0.06))
    const ry = nx ? Math.PI / 2 : 0
    S.box(fx, y - w * 0.32, fz, w * 0.64, w * 0.64, 0.12, '#f3efe2', { ry })
    S.box(fx + nx * 0.05, y, fz + nz * 0.05, 0.12, w * 0.25, 0.1, DARK, { ry })
    S.box(fx + nx * 0.05 + (nz ? w * 0.08 : 0), y, fz + nz * 0.05 + (nx ? w * 0.08 : 0), w * 0.2, 0.12, 0.1, DARK, { ry })
  }
}

function civic(S, b, r) {
  classicalHall(S, b, r, r.chance(0.5) ? { dome: true } : { tower: true })
  // flagpoles on the square
  for (const x of [-6, 0, 6]) {
    S.cyl(x, 0, S.D / 2 + 9, 0.1, 11, METAL, { flags: D_GROUNDED })
    S.box(x + 1, 9.4, S.D / 2 + 9, 2, 1.3, 0.05, r.pick(['#2b4c8c', '#b8433a', '#e2c55a', '#2f7a4a']), { flags: D_GROUNDED })
  }
}

function museum(S, b, r) {
  const { W, D } = S
  const H = b.height
  const v = r.weighted({ colonnade: 2, modern: 1.5, rotunda: 1 })
  if (v === 'modern') {
    // stacked, offset volumes with a glass lobby
    S.mass(0, 0, 0, W, b.floorH, D, { style: F_CURTAIN })
    S.mass(-W * 0.08, b.floorH, -D * 0.05, W * 0.86, H - b.floorH, D * 0.8, { style: F_PANEL, color: r.pick(['#e9e6df', '#b9b4aa', '#d5cbbb', '#6e6e6c']) })
    S.mass(W * 0.12, H - b.floorH, D * 0.12, W * 0.6, b.floorH, D * 0.7, { style: F_PANEL, k: 0.85, color: r.pick(['#e9e6df', '#8a8580']) })
    S.box(0, H, 0, W * 0.3, 0.6, D * 0.3, GLASS, { k: 1.2 })
    return
  }
  if (v === 'rotunda') return classicalHall(S, b, r, { dome: true })
  // a long colonnade across the whole front under a low hipped roof
  S.mass(0, 0, -1.6, W, H, D - 3.2, { style: F_CLASSICAL })
  const n = Math.max(6, Math.round(W / 3.2))
  const g = S.g0
  for (let s = 0; s < 3; s++) S.box(0, 0, D / 2 - 0.4 - s * 0.45, W + 1.5 - s * 0.5, g + 0.35 * (s + 1), 1.3, CONCRETE, { k: 1.3 })
  S.box(0, 0, D / 2 - 2, W, g + 1.05, 3.2, b.color, { k: 0.95 })
  S.colonnade(-W / 2 + 0.8, W / 2 - 0.8, D / 2 - 1.2, g + 1.05, H - g - 2.2, 0.5, n, b.color)
  S.box(0, H - 1.15, 0, W + 0.6, 1.15, D + 0.4, b.color, { k: 1.06 })
  S.gable(0, H, 0, W + 0.6, D + 0.4, Math.min(W, D) * 0.1, b.roofColor ?? '#6b6a66', 'hip')
  S.part('gable', 0, H, D / 2 - 1.4, W * 0.36, Math.min(3.2, W * 0.08), 3, b.color, { k: 1.04 })
}

function library(S, b, r) {
  const { W, D } = S
  const H = b.height
  if (b.arch === 'uni_library' || r.chance(0.55)) return classicalHall(S, b, r, { dome: b.arch === 'uni_library' || r.chance(0.3) })
  // modern library: glass reading room under a big floating roof
  S.mass(0, 0, 0, W, H, D, { style: F_CURTAIN })
  S.box(0, H, 0, W + 4, 0.8, D + 4, '#e6e3dc')
  for (const [x, z] of [[-W / 2 - 1.5, D / 2 + 1.5], [W / 2 + 1.5, D / 2 + 1.5], [-W / 2 - 1.5, -D / 2 - 1.5], [W / 2 + 1.5, -D / 2 - 1.5]]) S.cyl(x, 0, z, 0.25, H, WHITE)
}

function worship(S, b, r) {
  const { W, D } = S
  const H = b.height
  const roof = b.roofColor ?? '#5e5149'
  const stone = b.color
  switch (b.variant) {
    case 'mosque': {
      const s = Math.min(W, D * 0.8)
      S.mass(0, 0, D * 0.1, s, H * 0.75, s, { style: F_CLASSICAL })
      S.dome(0, H * 0.75, D * 0.1, s * 0.38, r.pick([COPPER, '#d9d4c7', GOLD]), stone)
      // minaret
      const mx = W / 2 - 1.2
      const mz = -D / 2 + 1.2
      S.cyl(mx, 0, mz, 1.1, H * 2.2, stone)
      S.cyl(mx, H * 1.7, mz, 1.6, 0.5, stone, { k: 1.05 })
      S.part('cone', mx, H * 2.2, mz, 2.2, 3.5, 2.2, r.pick([COPPER, '#d9d4c7']))
      return
    }
    case 'temple': {
      // pagoda: storeys stepping in, each under a broad flared roof
      const tiers = 4
      let s = Math.min(W, D) * 0.62
      let y = 0
      const th = Math.max(4.5, H / tiers + 1)
      const red = r.chance(0.6)
      for (let q = 0; q < tiers; q++) {
        const top = q === tiers - 1
        S.mass(0, y, 0, s, th, s, { style: F_PANEL, color: red ? '#8f2d24' : stone })
        // broad, shallow eaves; the next storey rises out of them
        S.part('pyr', 0, y + th - 0.3, 0, s * 1.45, s * (top ? 0.5 : 0.16), s * 1.45, roof)
        y += th
        s *= 0.8
      }
      S.cyl(0, y + s * 0.4, 0, 0.3, 6, GOLD)
      return
    }
    case 'cathedral': {
      const nw = W * 0.6
      S.mass(0, 0, -D * 0.05, nw, H, D * 0.85, { style: F_CLASSICAL })
      S.part('gable', 0, H, -D * 0.05, D * 0.87, nw * 0.55, nw * 1.04, roof, { ry: Math.PI / 2 })
      // transept
      S.mass(0, 0, -D * 0.12, W, H * 0.9, nw * 0.6, { style: F_CLASSICAL, k: 0.97 })
      S.part('gable', 0, H * 0.9, -D * 0.12, W * 1.02, nw * 0.45, nw * 0.62, roof)
      // twin west towers with spires
      const tw = nw * 0.36
      for (const sx of [-1, 1]) {
        const tx = sx * (nw / 2 - tw / 2)
        S.mass(tx, 0, D / 2 - tw / 2, tw, H * 1.6, tw, { style: F_CLASSICAL, k: 1.03 })
        S.part('pyr', tx, H * 1.6, D / 2 - tw / 2, tw * 1.02, H * 0.9, tw * 1.02, roof)
      }
      S.cyl(0, 0, -D / 2 + nw * 0.3, nw * 0.3, H * 0.85, stone)
      return
    }
    default: {
      // church: nave, gable roof, a steeple over the door and a round apse
      const nw = Math.min(W, D * 0.6)
      S.mass(0, 0, -0.5, nw, H, D - 1, { style: F_CLASSICAL })
      S.part('gable', 0, H, -0.5, D - 0.6, nw * 0.6, nw * 1.08, roof, { ry: Math.PI / 2 })
      const tw = Math.min(5, nw * 0.5)
      S.mass(0, 0, D / 2 - tw / 2, tw, H * 1.5, tw, { style: F_CLASSICAL, k: 1.03 })
      S.part('pyr', 0, H * 1.5, D / 2 - tw / 2, tw * 1.05, H * 1.1, tw * 1.05, roof)
      S.cyl(0, 0, -D / 2 + 0.5, nw * 0.35, H * 0.8, stone, { k: 0.97 })
      S.part('cone', 0, H * 0.8, -D / 2 + 0.5, nw * 0.75, nw * 0.3, nw * 0.75, roof)
    }
  }
}

function stadium(S, b, r) {
  const { W, D } = S
  const H = b.height
  const t = Math.min(W, D) * 0.2
  const c = b.color
  // four stands around an open pitch
  S.mass(0, 0, -D / 2 + t / 2, W, H, t, { style: F_PANEL, color: c })
  S.mass(0, 0, D / 2 - t / 2, W, H, t, { style: F_PANEL, color: c })
  S.mass(-W / 2 + t / 2, 0, 0, t, H * 0.8, D - 2 * t, { style: F_PANEL, color: c, k: 0.95 })
  S.mass(W / 2 - t / 2, 0, 0, t, H * 0.8, D - 2 * t, { style: F_PANEL, color: c, k: 0.95 })
  const seat = r.pick(['#b8433a', '#2f5f9a', '#3f7a4a', '#c9a64a'])
  // seating raked down toward the pitch
  S.part('shed', 0, H * 0.25, -D / 2 + t + 2, W - 2 * t, H * 0.7, 4, seat)
  S.part('shed', 0, H * 0.25, D / 2 - t - 2, W - 2 * t, H * 0.7, 4, seat, { ry: Math.PI })
  S.part('shed', -W / 2 + t + 2, H * 0.2, 0, D - 2 * t - 8, H * 0.55, 4, seat, { ry: Math.PI / 2 })
  S.part('shed', W / 2 - t - 2, H * 0.2, 0, D - 2 * t - 8, H * 0.55, 4, seat, { ry: -Math.PI / 2 })
  // roof canopies over the long stands
  S.box(0, H, -D / 2 + t * 0.9, W, 0.5, t * 1.4, WHITE)
  S.box(0, H, D / 2 - t * 0.9, W, 0.5, t * 1.4, WHITE)
  // pitch and floodlights
  S.box(0, S.g0, 0, W - 2 * t - 8, 0.3, D - 2 * t - 8, '#4f8a3c')
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    S.cyl((sx * W) / 2, 0, (sz * D) / 2, 0.4, H + 14, METAL)
    S.box((sx * W) / 2, H + 13, (sz * D) / 2, 3, 2, 0.6, WHITE, { ry: Math.atan2(sx, sz) })
  }
}

function landmark(S, b) {
  const { W, D } = S
  const H = b.height
  if (b.variant === 'needle') {
    // observation tower: a flared base, a slender shaft, the viewing pod and a mast
    S.mass(0, 0, 0, W, 8, D, { style: F_CURTAIN })
    S.mass(0, 8, 0, 6, H * 0.78 - 8, 6, { style: F_PANEL, color: '#d3d0c8' })
    S.mass(0, 8, 0, 6, H * 0.78 - 8, 6, { style: F_PANEL, color: '#d3d0c8', ry: Math.PI / 4 })
    const py = H * 0.78
    S.cyl(0, py - 4, 0, 9, 1.2, '#c9c6be')
    S.cyl(0, py - 2.8, 0, 9.4, 4, GLASS, { k: 0.9 })
    S.cyl(0, py + 1.2, 0, 10, 1, WHITE)
    S.part('dome', 0, py + 2.2, 0, 16, 3.5, 16, '#c9c6be')
    S.cyl(0, py + 5.5, 0, 1.4, 3, '#c9c6be')
    S.cyl(0, py + 8.5, 0, 0.5, H * 0.22, '#e04a3a')
    return
  }
  if (b.variant === 'arch') {
    // monumental arch: two piers carry an attic over the opening
    const pw = W * 0.28
    const ah = H * 0.68
    S.mass(-W / 2 + pw / 2, 0, 0, pw, ah, D, { style: F_PANEL })
    S.mass(W / 2 - pw / 2, 0, 0, pw, ah, D, { style: F_PANEL })
    S.mass(0, ah, 0, W, H - ah, D, { style: F_PANEL, k: 1.03 })
    S.box(0, ah - 1, 0, W - 2 * pw, 1, D * 0.9, b.color, { k: 0.9 })
    S.box(0, H, 0, W + 0.8, 0.8, D + 0.8, b.color, { k: 1.06 })
    S.box(0, H + 0.8, 0, W * 0.5, 2.2, D * 0.5, '#5d6a63')
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) S.cyl(sx * (W / 2 - pw / 2), 1, (sz * D) / 2 + sz * 0.6, 0.55, ah - 1, b.color, { k: 1.04 })
    return
  }
  // clock tower: a stone shaft, clock faces, an open belfry and a spire
  const sh = H * 0.72
  S.mass(0, 0, 0, W, sh, D, { style: F_CLASSICAL })
  S.box(0, sh - 0.6, 0, W + 0.8, 0.6, D + 0.8, b.color, { k: 1.08 })
  clockFaces(S, 0, sh - W * 0.7, 0, W)
  const bh = H - sh
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) S.box((sx * (W - 1.6)) / 2, sh, (sz * (D - 1.6)) / 2, 1.6, bh, 1.6, b.color)
  S.box(0, sh + bh * 0.2, 0, W * 0.4, 1.8, D * 0.4, '#8a6a3a')
  S.box(0, H, 0, W + 0.4, 0.6, D + 0.4, b.color, { k: 1.05 })
  S.part('pyr', 0, H + 0.6, 0, W * 1.02, H * 0.35, D * 1.02, '#4c5560')
  S.cyl(0, H + 0.6 + H * 0.35, 0, 0.1, 3, GOLD)
}

const BUILDERS = { house, apartment, office, tower, industrial, hospital, fire: fireStation, shelter, school, civic, museum, library, worship, stadium, landmark }

function rgbHex(c, k) {
  _c.set(c)
  if (k > 1) _c.lerp(new THREE.Color(1, 1, 1), Math.min(1, k - 1))
  else _c.multiplyScalar(k)
  return _c.getHex()
}

/** The masses and detail parts a building is drawn with, turned to face its street. */
export function shapeOf(b, cell) {
  const odd = (b.facing ?? 0) % 2 === 1
  const S = new Shape(b, odd ? b.fd : b.fw, odd ? b.fw : b.fd, (odd ? b.d : b.w) * cell, (odd ? b.w : b.d) * cell)
  const r = new Rng(Math.floor(b.seed * 2147483647) ^ 0x5bd1e995)
  ;(BUILDERS[b.type] ?? apartment)(S, b, r)
  const th = ((b.facing ?? 0) * Math.PI) / 2
  if (th) {
    const c = Math.cos(th)
    const s = Math.sin(th)
    for (const p of [...S.masses, ...S.details]) {
      const x = p.x
      p.x = c * x + s * p.z
      p.z = -s * x + c * p.z
      p.ry += th
    }
  }
  return S
}
