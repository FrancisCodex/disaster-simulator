// Road surfaces as real geometry: high-resolution procedural asphalt tiles
// (lanes, avenue medians, stop lines, zebra crossings) laid over the terrain,
// plus raised concrete sidewalks with kerbs. A tile is drawn for every
// distinct layout the network actually uses, in world orientation.
import * as THREE from 'three'
import { GRID, CELL, CELL_ROAD } from './config.js'
import { idx } from './cityGen.js'
import { analyzeRoads, DIRS, STREET, AVENUE, JUNCTION, BEND, END } from './roadNet.js'

const HALF = (GRID * CELL) / 2
const T = 448 // pixels per tile (≈2 cm/pixel)
const PAD = 10
const SIDEWALK = 2.2 // metres
const KERB = 0.16 // metres

function noiseFill(g, x, y, w, h, base, amount, n) {
  g.fillStyle = base
  g.fillRect(x, y, w, h)
  for (let q = 0; q < n; q++) {
    const v = Math.random()
    g.fillStyle = v < 0.5 ? `rgba(0,0,0,${Math.random() * amount})` : `rgba(255,255,255,${Math.random() * amount * 0.6})`
    const s = 1 + Math.random() * 3
    g.fillRect(x + Math.random() * w, y + Math.random() * h, s, s)
  }
}

/** Tile layout key for a road cell (also the information needed to draw it). */
function tileSpec(net, k) {
  const N = GRID
  const kind = net.kind[k]
  const i = k % N
  const j = (k - i) / N
  if (kind === JUNCTION) {
    // zebra + stop line only toward real approaches (not toward other junction cells)
    let zebra = 0
    let stop = 0
    for (let d = 0; d < 4; d++) {
      if (!(net.nb[k] & (1 << d))) continue
      const kk = idx(i + DIRS[d][0], j + DIRS[d][1])
      if (net.isJ(kk)) continue
      zebra |= 1 << d
      // traffic arrives from that side if the neighbour sends cars our way
      if (net.carOut[kk] & (1 << ((d + 2) % 4))) stop |= 1 << d
    }
    return { key: `X${net.nb[k]}.${zebra}.${stop}`, kind, open: net.nb[k], zebra, stop, wide: [0, 1, 2, 3].map((d) => net.kind[idx(Math.min(N - 1, Math.max(0, i + DIRS[d][0])), Math.min(N - 1, Math.max(0, j + DIRS[d][1])))] === AVENUE) }
  }
  if (kind === BEND) return { key: `C${net.nb[k]}`, kind, open: net.nb[k] }
  if (kind === AVENUE) return { key: `A${net.axis[k]}.${net.twin[k]}`, kind, axis: net.axis[k], twin: net.twin[k] }
  if (kind === END) return { key: `E${net.nb[k]}.${net.axis[k]}`, kind, open: net.nb[k], axis: net.axis[k] }
  return { key: `S${net.axis[k]}`, kind: STREET, axis: net.axis[k] }
}

function drawTile(g, ox, oy, spec) {
  const S = T
  const m = (v) => (v / CELL) * S // metres → px
  const c = S / 2
  g.save()
  g.beginPath()
  g.rect(ox - PAD, oy - PAD, S + PAD * 2, S + PAD * 2)
  g.clip()
  noiseFill(g, ox - PAD, oy - PAD, S + PAD * 2, S + PAD * 2, '#36383c', 0.09, 7000)
  for (let q = 0; q < 4; q++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '20,20,22' : '70,70,72'},${0.12 + Math.random() * 0.12})`
    g.beginPath()
    g.ellipse(ox + Math.random() * S, oy + Math.random() * S, 10 + Math.random() * 35, 6 + Math.random() * 18, Math.random() * 3, 0, Math.PI * 2)
    g.fill()
  }
  const white = '#e8e6df'
  const yellow = '#e1bf4c'
  const edge = m(SIDEWALK) + m(0.35)
  g.translate(ox + c, oy + c) // origin at the tile centre, +x east, +y south
  // draws a line that runs along the road axis at perpendicular offset `off` (metres)
  const along = (vertical, off, width, color, dash) => {
    g.fillStyle = color
    const w = m(width)
    if (!dash) {
      if (vertical) g.fillRect(m(off) - w / 2, -c, w, S)
      else g.fillRect(-c, m(off) - w / 2, S, w)
      return
    }
    for (let p = -c; p < c; p += m(dash * 2)) {
      if (vertical) g.fillRect(m(off) - w / 2, p, w, m(dash))
      else g.fillRect(p, m(off) - w / 2, m(dash), w)
    }
  }
  if (spec.kind === STREET || spec.kind === END) {
    const v = spec.axis === 2
    along(v, -0.16, 0.12, yellow)
    along(v, 0.16, 0.12, yellow)
    along(v, -(5 - (SIDEWALK + 0.35)), 0.15, white)
    along(v, 5 - (SIDEWALK + 0.35), 0.15, white)
  } else if (spec.kind === AVENUE) {
    // median on the twin side, dashed lane divider, edge line by the kerb
    const v = spec.axis === 2
    const s = DIRS[spec.twin][v ? 0 : 1]
    along(v, s * 4.82, 0.13, yellow)
    along(v, s * 0.8, 0.14, white, 3)
    along(v, -s * (5 - SIDEWALK - 0.35), 0.15, white)
  } else if (spec.kind === BEND) {
    const n = spec.open
    const ax = n & 1 ? c : -c
    const ay = n & 2 ? c : -c
    g.strokeStyle = yellow
    g.lineWidth = m(0.12)
    for (const r of [c - m(0.16), c + m(0.16)]) {
      g.beginPath()
      g.arc(ax, ay, r, 0, Math.PI * 2)
      g.stroke()
    }
  } else if (spec.kind === JUNCTION) {
    // rotation that puts direction d's edge at the top (−y)
    const rot = [Math.PI / 2, Math.PI, -Math.PI / 2, 0]
    for (let d = 0; d < 4; d++) {
      if (!(spec.zebra & (1 << d))) continue
      g.save()
      g.rotate(rot[d])
      g.fillStyle = white
      const span = spec.wide[d] ? c : c - edge
      for (let x = -span; x < span - m(0.3); x += m(0.9)) g.fillRect(x, -c + m(0.3), m(0.5), m(1.9))
      if (spec.stop & (1 << d)) {
        if (spec.wide[d]) g.fillRect(-c, -c + m(2.4), S, m(0.3))
        else g.fillRect(-m(0.1) - (c - edge), -c + m(2.4), c - edge, m(0.3))
      }
      g.restore()
    }
  }
  // gully drains
  g.fillStyle = 'rgba(15,15,15,0.8)'
  g.fillRect(-c + m(SIDEWALK) + 2, -c + Math.random() * S, m(0.4), m(0.8))
  g.restore()
}

function buildAtlas(specs, renderer) {
  const keys = [...new Set(specs.map((s) => s.key))]
  const cols = Math.ceil(Math.sqrt(keys.length))
  const rows = Math.ceil(keys.length / cols)
  const cv = document.createElement('canvas')
  cv.width = (T + PAD * 2) * cols
  cv.height = (T + PAD * 2) * rows
  const g = cv.getContext('2d')
  const rects = {}
  const byKey = new Map(specs.map((s) => [s.key, s]))
  keys.forEach((key, n) => {
    const ox = (n % cols) * (T + PAD * 2) + PAD
    const oy = Math.floor(n / cols) * (T + PAD * 2) + PAD
    drawTile(g, ox, oy, byKey.get(key))
    rects[key] = [ox / cv.width, oy / cv.height, T / cv.width, T / cv.height]
  })
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  return { tex, rects }
}

function concreteTexture(renderer) {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 256
  const g = cv.getContext('2d')
  noiseFill(g, 0, 0, 256, 256, '#a7a49b', 0.07, 2500)
  g.fillStyle = 'rgba(60,60,55,0.45)'
  g.fillRect(0, 0, 256, 2) // slab joints every ~1.5 m
  g.fillRect(0, 0, 2, 256)
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = renderer.capabilities.getMaxAnisotropy()
  return t
}

/**
 * Build the road mesh and sidewalk mesh for a city. `heightAt(vi, vj)`
 * returns the terrain height at a grid vertex. Returns { road, walk }.
 */
export function buildRoadMeshes(city, renderer, heightAt, lampTex) {
  const net = analyzeRoads(city)
  const cells = []
  for (let k = 0; k < GRID * GRID; k++) if (city.cellType[k] === CELL_ROAD && !city.bridge[k]) cells.push(k)
  const specs = cells.map((k) => tileSpec(net, k))
  const { tex, rects } = buildAtlas(specs, renderer)
  const isRoad = (i, j) => i >= 0 && j >= 0 && i < GRID && j < GRID && net.road[idx(i, j)]
  const pos = []
  const uv = []
  const uv1 = []
  const ind = []
  const wPos = []
  const wUv = []
  const wUv1 = []
  const wInd = []
  const lift = 0.06
  cells.forEach((k, n) => {
    const i = k % GRID
    const j = (k - i) / GRID
    const [u0, v0, du, dv] = rects[specs[n].key]
    const x0 = -HALF + i * CELL
    const z0 = -HALF + j * CELL
    const base = pos.length / 3
    ;[
      [x0, z0, i, j, 0, 0],
      [x0 + CELL, z0, i + 1, j, 1, 0],
      [x0, z0 + CELL, i, j + 1, 0, 1],
      [x0 + CELL, z0 + CELL, i + 1, j + 1, 1, 1],
    ].forEach(([x, z, vi, vj, a, b]) => {
      pos.push(x, heightAt(vi, vj) + lift, z)
      uv.push(u0 + a * du, 1 - (v0 + b * dv))
      uv1.push(vi / GRID, 1 - vj / GRID)
    })
    ind.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)

    // raised sidewalks along every edge that doesn't continue as road
    const N_ = isRoad(i, j - 1)
    const S_ = isRoad(i, j + 1)
    const W_ = isRoad(i - 1, j)
    const E_ = isRoad(i + 1, j)
    const edges = [
      [!N_, [x0, z0], [x0 + CELL, z0], [0, 1], [i, j], [i + 1, j]],
      [!S_, [x0 + CELL, z0 + CELL], [x0, z0 + CELL], [0, -1], [i + 1, j + 1], [i, j + 1]],
      [!W_, [x0, z0 + CELL], [x0, z0], [1, 0], [i, j + 1], [i, j]],
      [!E_, [x0 + CELL, z0], [x0 + CELL, z0 + CELL], [-1, 0], [i + 1, j], [i + 1, j + 1]],
    ]
    for (const [has, a, b, inward, va, vb] of edges) {
      if (!has) continue
      const ha = heightAt(...va) + lift
      const hb = heightAt(...vb) + lift
      const ia = [a[0] + inward[0] * SIDEWALK, a[1] + inward[1] * SIDEWALK]
      const ib = [b[0] + inward[0] * SIDEWALK, b[1] + inward[1] * SIDEWALK]
      const wb = wPos.length / 3
      for (const [p, h] of [
        [a, ha],
        [b, hb],
        [ia, ha],
        [ib, hb],
      ]) {
        wPos.push(p[0], h + KERB, p[1])
        wUv.push(p[0] / 1.6, p[1] / 1.6)
        wUv1.push((p[0] + HALF) / (GRID * CELL), 1 - (p[1] + HALF) / (GRID * CELL))
      }
      wInd.push(wb, wb + 2, wb + 1, wb + 1, wb + 2, wb + 3)
      const kb = wPos.length / 3
      for (const [p, h] of [
        [ia, ha + KERB],
        [ib, hb + KERB],
        [ia, ha - 0.05],
        [ib, hb - 0.05],
      ]) {
        wPos.push(p[0], h, p[1])
        wUv.push((p[0] + p[1]) / 1.6, h * 2)
        wUv1.push((p[0] + HALF) / (GRID * CELL), 1 - (p[1] + HALF) / (GRID * CELL))
      }
      wInd.push(kb, kb + 1, kb + 2, kb + 1, kb + 3, kb + 2)
    }
  })
  const mk = (p, u, u1, i) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2))
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(u1, 2))
    g.setIndex(i)
    g.computeVertexNormals()
    return g
  }
  const lamp = lampTex.clone()
  lamp.channel = 1
  lamp.needsUpdate = true
  const roadMat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.88,
    metalness: 0,
    emissive: 0xffffff,
    emissiveMap: lamp,
    emissiveIntensity: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const walkMat = new THREE.MeshStandardMaterial({ map: concreteTexture(renderer), roughness: 0.9, emissive: 0xffffff, emissiveMap: lamp, emissiveIntensity: 0, side: THREE.DoubleSide })
  const road = new THREE.Mesh(mk(pos, uv, uv1, ind), roadMat)
  road.receiveShadow = true
  const walk = new THREE.Mesh(mk(wPos, wUv, wUv1, wInd), walkMat)
  walk.receiveShadow = true
  return { road, walk, lamp }
}

export { SIDEWALK, KERB, END, BEND }
