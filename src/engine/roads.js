// Road surfaces as real geometry: high-resolution procedural asphalt tiles
// (lanes, edge lines, stop lines, zebra crossings) laid over the terrain,
// plus raised concrete sidewalks with kerbs.
import * as THREE from 'three'
import { GRID, CELL, CELL_ROAD } from './config.js'
import { idx } from './cityGen.js'

const HALF = (GRID * CELL) / 2
const T = 512 // pixels per tile (≈2 cm/pixel)
const PAD = 12
const SIDEWALK = 2.2 // metres
const KERB = 0.16 // metres

// tile ids in the atlas
const STRAIGHT = 0
const CROSS = 1
const TEE = 2
const CORNER = 3
const END = 4
const SINGLE = 5

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

/**
 * Draws one tile in "north-up" orientation: open edges listed in `open`
 * (n, e, s, w). Lanes run between open edges.
 */
function drawTile(g, ox, oy, open) {
  const S = T
  const m = (v) => (v / CELL) * S // metres → px
  g.save()
  g.beginPath()
  g.rect(ox - PAD, oy - PAD, S + PAD * 2, S + PAD * 2)
  g.clip()
  noiseFill(g, ox - PAD, oy - PAD, S + PAD * 2, S + PAD * 2, '#36383c', 0.09, 9000)
  // patched asphalt and oil stains
  for (let q = 0; q < 5; q++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '20,20,22' : '70,70,72'},${0.15 + Math.random() * 0.15})`
    g.beginPath()
    g.ellipse(ox + Math.random() * S, oy + Math.random() * S, 10 + Math.random() * 40, 6 + Math.random() * 20, Math.random() * 3, 0, Math.PI * 2)
    g.fill()
  }
  const c = S / 2
  const n = open.includes('n')
  const e = open.includes('e')
  const s = open.includes('s')
  const w = open.includes('w')
  const count = [n, e, s, w].filter(Boolean).length
  const white = '#e8e6df'
  const yellow = '#e1bf4c'
  const edge = m(SIDEWALK) + m(0.35)
  g.lineCap = 'butt'
  if (count === 2 && ((n && s) || (e && w))) {
    // straight: double yellow centre line, white edge lines
    const vertical = n && s
    g.save()
    g.translate(ox + c, oy + c)
    if (!vertical) g.rotate(Math.PI / 2)
    g.fillStyle = yellow
    g.fillRect(-m(0.22), -c, m(0.12), S)
    g.fillRect(m(0.1), -c, m(0.12), S)
    g.fillStyle = white
    g.fillRect(-c + edge, -c, m(0.15), S)
    g.fillRect(c - edge - m(0.15), -c, m(0.15), S)
    g.restore()
  } else if (count >= 3) {
    // junction: zebra crossings and stop lines on every open approach
    for (const [dir, rot] of [
      ['n', 0],
      ['e', Math.PI / 2],
      ['s', Math.PI],
      ['w', -Math.PI / 2],
    ]) {
      if (!open.includes(dir)) continue
      g.save()
      g.translate(ox + c, oy + c)
      g.rotate(rot)
      g.fillStyle = white
      for (let x = -c + edge; x < c - edge - m(0.3); x += m(0.9)) g.fillRect(x, -c + m(0.3), m(0.5), m(1.9))
      g.fillRect(-m(0.1) - (c - edge), -c + m(2.4), c - edge, m(0.3)) // stop line (incoming lane)
      g.restore()
    }
  } else if (count === 2) {
    // bend: centre line follows a quarter arc
    const ax = e ? ox + S : ox
    const ay = s ? oy + S : oy
    g.strokeStyle = yellow
    g.lineWidth = m(0.12)
    for (const r of [c - m(0.16), c + m(0.16)]) {
      g.beginPath()
      g.arc(ax, ay, r, 0, Math.PI * 2)
      g.stroke()
    }
  } else if (count === 1) {
    g.save()
    g.translate(ox + c, oy + c)
    g.rotate({ n: 0, e: Math.PI / 2, s: Math.PI, w: -Math.PI / 2 }[open[0]])
    g.fillStyle = yellow
    g.fillRect(-m(0.22), -c, m(0.12), c - m(1))
    g.fillRect(m(0.1), -c, m(0.12), c - m(1))
    g.restore()
  }
  // drains along kerbs
  g.fillStyle = 'rgba(15,15,15,0.8)'
  for (let q = 0; q < 2; q++) g.fillRect(ox + m(SIDEWALK) + 2, oy + Math.random() * S, m(0.4), m(0.8))
  g.restore()
}

let atlasCache = null
function makeAtlas(renderer) {
  if (atlasCache) return atlasCache
  const cv = document.createElement('canvas')
  const cols = 3
  const rows = 2
  cv.width = (T + PAD * 2) * cols
  cv.height = (T + PAD * 2) * rows
  const g = cv.getContext('2d')
  const defs = { [STRAIGHT]: ['n', 's'], [CROSS]: ['n', 'e', 's', 'w'], [TEE]: ['n', 's', 'w'], [CORNER]: ['n', 'e'], [END]: ['n'], [SINGLE]: [] }
  const rects = {}
  for (const id of [STRAIGHT, CROSS, TEE, CORNER, END, SINGLE]) {
    const cx = id % cols
    const cy = Math.floor(id / cols)
    const ox = cx * (T + PAD * 2) + PAD
    const oy = cy * (T + PAD * 2) + PAD
    drawTile(g, ox, oy, defs[id])
    rects[id] = [ox / cv.width, oy / cv.height, T / cv.width, T / cv.height]
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  atlasCache = { tex, rects }
  return atlasCache
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
  const { tex, rects } = makeAtlas(renderer)
  const isRoad = (i, j) => i >= 0 && j >= 0 && i < GRID && j < GRID && (city.cellType[idx(i, j)] === CELL_ROAD || city.bridge[idx(i, j)])
  const pos = []
  const uv = []
  const uv1 = []
  const ind = []
  const wPos = []
  const wUv = []
  const wUv1 = []
  const wInd = []
  const lift = 0.06
  const corner = (vi, vj) => heightAt(vi, vj)
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      const k = idx(i, j)
      if (city.cellType[k] !== CELL_ROAD || city.bridge[k]) continue
      const N = isRoad(i, j - 1)
      const E = isRoad(i + 1, j)
      const S = isRoad(i, j + 1)
      const W = isRoad(i - 1, j)
      const count = N + E + S + W
      // pick a tile and how many quarter turns it needs
      let id = SINGLE
      let rot = 0
      if (count === 4) id = CROSS
      else if (count === 3) {
        id = TEE
        rot = !E ? 0 : !S ? 1 : !W ? 2 : 3 // TEE base is closed on the east
      } else if (count === 2) {
        if (N && S) id = STRAIGHT
        else if (E && W) {
          id = STRAIGHT
          rot = 1
        } else {
          id = CORNER
          rot = N && E ? 0 : E && S ? 1 : S && W ? 2 : 3
        }
      } else if (count === 1) {
        id = END
        rot = N ? 0 : E ? 1 : S ? 2 : 3
      }
      const [u0, v0, du, dv] = rects[id]
      // tile corner UVs in tile space (0..1), rotated clockwise `rot` times
      const tc = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([x, y]) => {
        let a = x
        let b = y
        for (let r = 0; r < rot; r++) [a, b] = [b, 1 - a]
        return [u0 + a * du, 1 - (v0 + b * dv)]
      })
      const x0 = -HALF + i * CELL
      const z0 = -HALF + j * CELL
      const base = pos.length / 3
      const corners = [
        [x0, z0, i, j],
        [x0 + CELL, z0, i + 1, j],
        [x0, z0 + CELL, i, j + 1],
        [x0 + CELL, z0 + CELL, i + 1, j + 1],
      ]
      corners.forEach(([x, z, vi, vj], q) => {
        pos.push(x, corner(vi, vj) + lift, z)
        uv.push(tc[q][0], tc[q][1])
        uv1.push(vi / GRID, 1 - vj / GRID)
      })
      ind.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)

      // raised sidewalks along every edge that doesn't continue as road
      const edges = [
        [!N, [x0, z0], [x0 + CELL, z0], [0, 1], [i, j], [i + 1, j]],
        [!S, [x0 + CELL, z0 + CELL], [x0, z0 + CELL], [0, -1], [i + 1, j + 1], [i, j + 1]],
        [!W, [x0, z0 + CELL], [x0, z0], [1, 0], [i, j + 1], [i, j]],
        [!E, [x0 + CELL, z0], [x0 + CELL, z0 + CELL], [-1, 0], [i + 1, j], [i + 1, j + 1]],
      ]
      for (const [has, a, b, inward, va, vb] of edges) {
        if (!has) continue
        const ha = corner(...va) + lift
        const hb = corner(...vb) + lift
        const ia = [a[0] + inward[0] * SIDEWALK, a[1] + inward[1] * SIDEWALK]
        const ib = [b[0] + inward[0] * SIDEWALK, b[1] + inward[1] * SIDEWALK]
        const wb = wPos.length / 3
        // top surface
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
        // kerb face toward the carriageway
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
    }
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
  walk.castShadow = false
  return { road, walk, lamp }
}

export { SIDEWALK, KERB }
