// Fracture: how a failing building breaks into rigid pieces along its own
// part and storey lines. Works on the building's archetype shape (facade
// masses + detail parts, building-local metres: origin at the footprint
// centre of the base, y up) and returns oriented boxes for the debris physics.
//
//  • 'crush' (progressive / pancake collapse): every band of storeys of every
//    mass becomes its facade walls (thin panels, split along bay lines) and
//    one floor slab carrying the crushed storeys. Only ~15 % of the gross
//    volume is solid, so the pieces stack into a low pile instead of
//    rebuilding the tower.
//  • 'chunks' (toppling or a sheared-off top): the structure is still intact
//    when it hits, so it breaks into solid blocks of a few storeys each.
//
// Big decorations (roofs, domes, spires, columns...) become pieces of their
// own; small ones ride on the piece they are attached to.
import { F_CURTAIN, F_HOUSE, D_GROUNDED } from './archetypes.js'

// facade bay widths by style (the facade shader's spacing), so wall panels split between windows
const BAY = [3.2, 3.2, 3.0, 1.5, 3.6, 3.6, 4.2, 3.0]
// gross density of a building (structure + contents, averaged over its volume), kg/m³
const RHO = { wood_old: 130, wood: 120, urm: 420, rc_low: 360, rc_mod: 340, rc_high: 330, steel: 230, isolated: 330 }
const RHO_DETAIL = 260

/** In the mass frame (rotated by ry): offset (ox, oz) → building-local x, z. */
function place(m, ox, oz) {
  const c = Math.cos(m.ry)
  const s = Math.sin(m.ry)
  return [m.x + c * ox + s * oz, m.z - s * ox + c * oz]
}

/** Is building-local point (x, y, z) inside mass m, shrunk by `inset`? */
function insideMass(m, x, y, z, inset) {
  if (y < m.y || y > m.y + m.h) return false
  const c = Math.cos(m.ry)
  const s = Math.sin(m.ry)
  const dx = x - m.x
  const dz = z - m.z
  // inverse of place()
  const ux = c * dx - s * dz
  const uz = s * dx + c * dz
  return Math.abs(ux) < m.w / 2 - inset && Math.abs(uz) < m.d / 2 - inset
}

/** Split length L into panels no longer than `max`, along whole bays where possible. */
function panels(L, bay, max) {
  const nb = Math.max(1, Math.round(L / bay))
  const np = Math.max(1, Math.min(nb, Math.ceil(L / max)))
  const out = []
  let b0 = 0
  for (let q = 0; q < np; q++) {
    const b1 = Math.round((nb * (q + 1)) / np)
    out.push([(L * b0) / nb - L / 2, (L * b1) / nb - L / 2])
    b0 = b1
  }
  return out
}

/** Storey bands of [y0, y1] with floor height fh, at most maxBands of them. */
function bands(y0, y1, fh, maxBands) {
  const n = Math.max(1, Math.round((y1 - y0) / fh))
  const k = Math.max(1, Math.ceil(n / maxBands))
  const out = []
  for (let f = 0; f < n; f += k) {
    const a = y0 + f * fh
    const b = f + k >= n ? y1 : y0 + (f + k) * fh
    if (b - a > 0.4) out.push([a, b, Math.min(k, n - f)])
  }
  return out
}

/** Separating-axis test of two y-rotated boxes (footprints + height ranges); true if they overlap by more than `tol`. */
function overlaps(p, q, tol = 0.06) {
  if (p.y + p.h <= q.y + tol || q.y + q.h <= p.y + tol) return false
  const axes = [p.ry, p.ry + Math.PI / 2, q.ry, q.ry + Math.PI / 2]
  for (const a of axes) {
    const ax = Math.cos(a)
    const az = -Math.sin(a)
    const proj = (r) => {
      const c = Math.cos(r.ry)
      const s = Math.sin(r.ry)
      // half extents projected on the axis: |e_x · axis| w/2 + |e_z · axis| d/2, with e_x = (c, -s), e_z = (s, c)
      return (Math.abs(c * ax - s * az) * r.w + Math.abs(s * ax + c * az) * r.d) / 2
    }
    const d = Math.abs((p.x - q.x) * ax + (p.z - q.z) * az)
    if (d >= proj(p) + proj(q) - tol) return false
  }
  return true
}

/**
 * Cut a w × h × d block into about n smaller blocks, as concrete breaks: each
 * time the biggest block cracks across its longest side, somewhere near the
 * middle. Returns the blocks as centre offsets and sizes in the block's axes.
 */
export function splitBlock(w, h, d, n, minSize = 1.1) {
  const out = [{ x: 0, y: 0, z: 0, w, h, d }]
  while (out.length < n) {
    let k = 0
    for (let i = 1; i < out.length; i++) if (out[i].w * out[i].h * out[i].d > out[k].w * out[k].h * out[k].d) k = i
    const b = out[k]
    const axis = b.w >= b.h && b.w >= b.d ? 'w' : b.d >= b.h ? 'd' : 'h'
    const L = b[axis]
    if (L < minSize * 2) break
    const f = 0.3 + Math.random() * 0.4
    const a = { ...b }
    const c = { ...b }
    const pos = axis === 'w' ? 'x' : axis === 'h' ? 'y' : 'z'
    a[axis] = L * f - 0.03
    c[axis] = L * (1 - f) - 0.03
    a[pos] = b[pos] - L / 2 + (L * f) / 2
    c[pos] = b[pos] + L / 2 - (L * (1 - f)) / 2
    out.splice(k, 1, a, c)
  }
  return out
}

/**
 * The pieces building b breaks into.
 * opts: mode 'crush' | 'chunks'; only material between `above` and `below`
 * (rest metres) is used; lod in (0, 1] coarsens the breakup for distant or
 * crowded scenes; drop: storeys below this height are pulverised (the
 * failed soft storey of a pancake collapse) and give no pieces.
 * Each piece: { kind, x, y, z, w, h, d, ry, mass, geo?, style, fh, flags,
 * color, seed, nx, nz (outward normal of a wall, building-local),
 * attached: [detail parts riding on it] }.
 */
export function fracture(b, shape, { mode = 'crush', above = 0, below = Infinity, lod = 1, drop = 0, maxDetails = 24 } = {}) {
  const rho = RHO[b.construction] ?? 330
  const pieces = []
  const masses = shape.masses
  const seed = Math.floor(b.seed * 997)
  const maxBands = mode === 'crush' ? Math.round(2 + 6 * lod) : Math.round(2 + 5 * lod)
  const split = lod > 0.55 ? (mode === 'crush' ? 14 : 12) : lod > 0.3 ? 22 : 1e3
  for (const m of masses) {
    const y0 = Math.max(m.y, above, drop)
    const y1 = Math.min(m.y + m.h, below)
    if (y1 - y0 < 0.5) continue
    const bay = BAY[m.style] ?? 3.2
    const house = m.style === F_HOUSE
    const base = { ry: m.ry, style: m.style, fh: m.fh, color: m.color, seed }
    for (const [ya, yb, nst] of bands(y0, y1, m.fh, maxBands)) {
      const hb = yb - ya
      const flags = ya < m.fh * 0.5 ? m.flags : 0
      const bandMass = m.w * m.d * hb * rho
      if (mode === 'chunks') {
        const nx = Math.max(1, Math.min(3, Math.round(m.w / split)))
        const nz = Math.max(1, Math.min(3, Math.round(m.d / split)))
        for (let i = 0; i < nx; i++)
          for (let k = 0; k < nz; k++) {
            const w = m.w / nx
            const d = m.d / nz
            const [x, z] = place(m, -m.w / 2 + w * (i + 0.5), -m.d / 2 + d * (k + 0.5))
            pieces.push({ ...base, kind: 'chunk', x, y: ya + 0.02, z, w: w - 0.06, h: hb - 0.04, d: d - 0.06, flags, mass: bandMass / (nx * nz) })
          }
        continue
      }
      // crush: four walls around a floor slab
      const t = house ? 0.3 : m.style === F_CURTAIN ? 0.35 : 0.45
      const ts = Math.min(hb * 0.4, 0.3 * nst + 0.1)
      const walls = []
      const wall = (ox, oz, w, d, nx, nz) => {
        const [x, z] = place(m, ox, oz)
        const c = Math.cos(m.ry)
        const s = Math.sin(m.ry)
        // a panel inside another mass is an interior wall where the two volumes meet: leave it out
        for (const o of masses) if (o !== m && insideMass(o, x, (ya + yb) / 2, z, 0.05)) return
        walls.push({ ...base, kind: 'wall', x, y: ya + 0.02, z, w, h: hb - 0.04, d, flags, nx: c * nx + s * nz, nz: -s * nx + c * nz })
      }
      for (const [a, c] of panels(m.w, bay, split)) {
        wall((a + c) / 2, m.d / 2 - t / 2, c - a - 0.05, t, 0, 1)
        wall((a + c) / 2, -m.d / 2 + t / 2, c - a - 0.05, t, 0, -1)
      }
      for (const [a, c] of panels(m.d - 2 * t, bay, split)) {
        wall(m.w / 2 - t / 2, (a + c) / 2, t, c - a - 0.05, 1, 0)
        wall(-m.w / 2 + t / 2, (a + c) / 2, t, c - a - 0.05, -1, 0)
      }
      const wallArea = walls.reduce((s, p) => s + Math.max(p.w, p.d), 0)
      for (const p of walls) {
        p.mass = (bandMass * 0.35 * Math.max(p.w, p.d)) / Math.max(1, wallArea)
        pieces.push(p)
      }
      const iw = m.w - 2 * t - 0.1
      const id = m.d - 2 * t - 0.1
      if (iw < 0.5 || id < 0.5) continue
      const sx = Math.max(1, Math.min(4, Math.round(iw / split)))
      const sz = Math.max(1, Math.min(4, Math.round(id / split)))
      for (let i = 0; i < sx; i++)
        for (let k = 0; k < sz; k++) {
          const w = iw / sx
          const d = id / sz
          const [x, z] = place(m, -iw / 2 + w * (i + 0.5), -id / 2 + d * (k + 0.5))
          // the slab carries the storeys crushed onto it: rough, broken concrete
          pieces.push({ ...base, kind: 'slab', x, y: yb - ts - 0.02, z, w: w - 0.06, h: ts, d: d - 0.06, flags: 0, rough: true, mass: (bandMass * 0.65) / (sx * sz) })
        }
    }
  }

  // decorations: big ones fall on their own, small ones stay with what they are fixed to
  const own = []
  const small = []
  for (const d of shape.details) {
    if (d.flags & D_GROUNDED) continue
    if (d.y < Math.max(above, drop) - 0.5 || d.y >= below) continue
    const big = Math.max(d.w, d.h, d.d) >= 3 && d.w * d.h * d.d >= 2.5
    ;(big ? own : small).push(d)
  }
  own.sort((p, q) => q.w * q.h * q.d - p.w * p.h * p.d)
  const nOwn = Math.round(maxDetails * lod)
  for (let q = 0; q < own.length; q++) {
    const d = own[q]
    if (q >= nOwn) {
      small.push(d)
      continue
    }
    const vol = d.w * d.h * d.d
    pieces.push({ kind: 'detail', geo: d.g, x: d.x, y: d.y, z: d.z, w: d.w, h: d.h, d: d.d, ry: d.ry, color: d.color, mass: vol * RHO_DETAIL * (d.g === 'box' || d.g === 'cyl' ? 1 : 0.5), detail: d })
  }

  // no two pieces may start inside each other: the smaller of an overlapping pair goes
  pieces.sort((p, q) => q.w * q.h * q.d - p.w * p.h * p.d)
  const kept = []
  for (const p of pieces) {
    if (p.w < 0.05 || p.h < 0.05 || p.d < 0.05) continue
    let clash = false
    for (const q of kept)
      if (overlaps(p, q)) {
        clash = true
        break
      }
    if (clash) {
      if (p.detail) small.push(p.detail)
      continue
    }
    p.attached = []
    kept.push(p)
  }

  // attach small details to the piece they sit on or hang from
  for (const d of small) {
    const cx = d.x
    const cy = d.y + Math.min(d.h, 1) * 0.5
    const cz = d.z
    let best = null
    let bestD = 3
    for (const p of kept) {
      if (p.kind === 'detail') continue
      const c = Math.cos(p.ry)
      const s = Math.sin(p.ry)
      const dx = cx - p.x
      const dz = cz - p.z
      const ux = Math.max(0, Math.abs(c * dx - s * dz) - p.w / 2)
      const uz = Math.max(0, Math.abs(s * dx + c * dz) - p.d / 2)
      const uy = Math.max(0, p.y - cy, cy - (p.y + p.h))
      const dist = Math.hypot(ux, uy * 1.5, uz)
      if (dist < bestD) {
        bestD = dist
        best = p
      }
    }
    best?.attached.push(d)
  }
  return kept
}
