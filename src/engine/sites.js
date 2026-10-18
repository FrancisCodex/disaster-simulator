// Special sites: civic centres, museums, campuses, schools, parks and
// landmarks. Each takes a corner of a city block (or a whole block) before
// ordinary lots are filled, and lays out its buildings and grounds there.
import { CELL_GRASS, CELL_PARK } from './config.js'

// Surface finish of open site cells (city.ground), used to paint the terrain.
export const GROUND_PLAZA = 1
export const GROUND_FIELD = 2
export const GROUND_COURT = 3
export const GROUND_LAWN = 4

// cells: [preferred w, preferred d, minimum w, minimum d] in the site's own frame (d runs back→front)
const SIZES = {
  civic: [7, 6, 4, 4],
  museum: [6, 5, 4, 4],
  library: [4, 4, 3, 3],
  worship: [3, 4, 3, 3],
  clock: [3, 3, 3, 3],
  needle: [4, 4, 3, 3],
  arch: [4, 4, 3, 3],
  landmark: [4, 4, 3, 3],
  park: [8, 8, 4, 4],
  stadium: [7, 7, 5, 5],
  university: [8, 8, 6, 6],
  high: [6, 5, 5, 4],
  primary: [4, 3, 3, 3],
}

/**
 * Places the city type's special sites. ctx: { city, rng, P, blocks, cx, cy,
 * N, idx, add(spec) → building, slopeOk(x, y, w, d) }.
 */
export function placeSites(ctx) {
  const { city, rng, P, blocks, cx, cy, idx } = ctx
  const placed = []
  for (const spec of P.sites || []) {
    if (spec.chance !== undefined && !rng.chance(spec.chance)) continue
    let kind = spec.kind
    if (kind === 'landmark') kind = rng.pick(['clock', 'arch', 'needle'])
    const [pw, pd, mw, md] = SIZES[kind]
    let best = null
    let bestScore = -Infinity
    for (const B of blocks) {
      const r = Math.hypot(B.x0 + B.w / 2 - cx, B.y0 + B.d / 2 - cy) / P.radius
      if (r < spec.r[0] || r > spec.r[1]) continue
      // the site's front faces the city centre
      const front = Math.abs(cx - (B.x0 + B.w / 2)) > Math.abs(cy - (B.y0 + B.d / 2)) ? (cx > B.x0 + B.w / 2 ? 1 : 3) : cy > B.y0 + B.d / 2 ? 0 : 2
      const odd = front % 2 === 1
      const bw = odd ? B.d : B.w
      const bd = odd ? B.w : B.d
      if (bw < mw || bd < md) continue
      const cw = Math.min(pw, bw)
      const cd = Math.min(pd, bd)
      const W = odd ? cd : cw
      const D = odd ? cw : cd
      // hug the front edge of the block
      const x = front === 1 ? B.x0 + B.w - W : front === 3 ? B.x0 : B.x0 + Math.floor((B.w - W) / 2)
      const y = front === 0 ? B.y0 + B.d - D : front === 2 ? B.y0 : B.y0 + Math.floor((B.d - D) / 2)
      if (!areaFree(ctx, x, y, W, D)) continue
      let score = rng.next() - r * 0.3
      for (const p of placed) if (Math.hypot(p.x - x, p.y - y) < 14) score -= 3
      if (score > bestScore) {
        bestScore = score
        best = { x, y, W, D, cw, cd, front }
      }
    }
    if (!best) continue
    const site = { kind, ...best }
    layout(ctx, site)
    placed.push(site)
    city.sites.push({ kind, x: site.x, y: site.y, w: site.W, d: site.D, front: site.front })
  }
  // open site cells become parkland with a surface finish
  for (const s of placed)
    for (let j = s.y; j < s.y + s.D; j++)
      for (let i = s.x; i < s.x + s.W; i++) {
        const k = idx(i, j)
        if (city.buildingAt[k] >= 0) continue
        city.cellType[k] = CELL_PARK
        if (!city.ground[k] && s.kind !== 'park') city.ground[k] = GROUND_LAWN
      }
}

function areaFree(ctx, x, y, w, d) {
  const { city, idx, N } = ctx
  if (x < 1 || y < 1 || x + w > N - 1 || y + d > N - 1) return false
  for (let j = y; j < y + d; j++) for (let i = x; i < x + w; i++) if (city.cellType[idx(i, j)] !== CELL_GRASS || city.buildingAt[idx(i, j)] >= 0) return false
  return ctx.slopeOk(x, y, w, d)
}

/** Maps a rectangle in the site's frame (u across, v back→front) to grid cells. */
function toGrid(s, u, v, w, d) {
  switch (s.front) {
    case 0:
      return { x: s.x + u, y: s.y + v, w, d }
    case 2:
      return { x: s.x + s.W - u - w, y: s.y + s.D - v - d, w, d }
    case 1:
      return { x: s.x + v, y: s.y + s.D - u - w, w: d, d: w }
    default:
      return { x: s.x + s.W - v - d, y: s.y + u, w: d, d: w }
  }
}

function layout(ctx, s) {
  const { city, rng, P, idx } = ctx
  const big = P.key === 'megacity'
  const rural = P.key === 'rural'
  const mix = (t) => rng.weighted(P.mix[t])
  const bld = (u, v, w, d, spec) => {
    const r = toGrid(s, u, v, w, d)
    return ctx.add({ ...r, facing: s.front, construction: mix(spec.type), ...spec })
  }
  const ground = (u, v, w, d, g) => {
    const r = toGrid(s, u, v, w, d)
    for (let j = r.y; j < r.y + r.d; j++) for (let i = r.x; i < r.x + r.w; i++) city.ground[idx(i, j)] = g
  }
  const { cw, cd } = s
  ground(0, 0, cw, cd, GROUND_PLAZA)
  switch (s.kind) {
    case 'civic': {
      // the hall sits at the back of a paved square
      const hd = Math.min(3, cd - 2)
      bld(0, 0, cw, hd, { type: 'civic', floors: rural ? 2 : big ? 4 : 3 })
      ground(0, hd, 1, cd - hd, GROUND_LAWN)
      ground(cw - 1, hd, 1, cd - hd, GROUND_LAWN)
      break
    }
    case 'museum': {
      const hd = Math.min(4, cd - 1)
      bld(Math.max(0, Math.floor((cw - 5) / 2)), 0, Math.min(5, cw), hd, { type: 'museum', floors: 2 })
      break
    }
    case 'library':
      bld(0, 0, Math.min(4, cw), Math.min(3, cd - 1), { type: 'library', floors: 2 })
      ground(0, cd - 1, cw, 1, GROUND_LAWN)
      break
    case 'worship': {
      const variant = rng.weighted(rural ? { church: 0.8, temple: 0.2 } : { church: 0.45, cathedral: 0.2, mosque: 0.2, temple: 0.15 })
      bld(0, 0, Math.min(3, cw), Math.min(cd, variant === 'cathedral' ? 4 : 3), { type: 'worship', floors: 1, variant })
      ground(0, 0, cw, cd, GROUND_LAWN)
      break
    }
    case 'clock':
      bld(Math.floor((cw - 2) / 2), Math.floor((cd - 2) / 2), 2, 2, { type: 'landmark', floors: 8, variant: 'clock', construction: rng.chance(0.7) ? 'urm' : 'rc_mod' })
      break
    case 'needle':
      bld(Math.floor((cw - 2) / 2), Math.floor((cd - 2) / 2), 2, 2, { type: 'landmark', floors: big ? 44 : 32, variant: 'needle', construction: rng.chance(0.6) ? 'steel' : 'rc_high' })
      break
    case 'arch':
      bld(Math.floor((cw - 3) / 2), Math.floor((cd - 2) / 2), 3, 2, { type: 'landmark', floors: 6, variant: 'arch' })
      break
    case 'stadium':
      bld(0, 0, cw, cd, { type: 'stadium', floors: big ? 4 : 3 })
      break
    case 'park':
      ground(0, 0, cw, cd, 0)
      city.parks.push({ ...toGrid(s, 0, 0, cw, cd), big: true })
      break
    case 'university': {
      // a quad: great hall at the back, faculty wings either side, a lawn in the middle
      ground(0, 0, cw, cd, GROUND_LAWN)
      const lvl = big ? 1 : 0
      bld(1, 0, cw - 2, 2, { type: 'school', floors: 3 + lvl, variant: 'university', arch: 'uni_hall' })
      bld(0, 2, 2, cd - 4, { type: 'school', floors: 3 + lvl, variant: 'university', arch: 'uni_wing', noIcon: true })
      bld(cw - 2, 2, 2, cd - 5, { type: 'school', floors: 4 + lvl * 2, variant: 'university', arch: 'uni_lab', noIcon: true })
      bld(cw - 2, cd - 3, 2, 3, { type: 'apartment', floors: 5 + lvl * 3, variant: 'dorm', arch: 'dorm', noIcon: true })
      bld(0, cd - 2, 2, 2, { type: 'library', floors: 2, variant: 'university', arch: 'uni_library', noIcon: true })
      ground(2, cd - 2, cw - 4, 2, GROUND_PLAZA)
      break
    }
    case 'high': {
      bld(0, 0, cw, 2, { type: 'school', floors: rural ? 2 : big ? 4 : 3, variant: 'high', arch: 'high' })
      bld(0, 2, 2, 2, { type: 'school', floors: 1, variant: 'high', arch: 'gym', noIcon: true })
      ground(2, 2, cw - 2, cd - 2, GROUND_FIELD)
      ground(0, 4, 2, cd - 4, GROUND_COURT)
      break
    }
    case 'primary': {
      bld(0, 0, Math.min(3, cw), 2, { type: 'school', floors: big ? 3 : 2, variant: 'primary', arch: 'primary' })
      ground(0, 2, cw, cd - 2, GROUND_COURT)
      if (cw > 3) ground(3, 0, cw - 3, 2, GROUND_LAWN)
      break
    }
  }
}
