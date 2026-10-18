// Street furniture for parks, squares and school grounds: fountains,
// gazebos, benches, lamps, goals and hoops. Static, instanced, cheap.
import * as THREE from 'three'
import { CELL } from './config.js'
import { idx, cellToWorld } from './cityGen.js'
import { GROUND_PLAZA, GROUND_FIELD, GROUND_COURT } from './sites.js'

const _m = new THREE.Matrix4()
const _r = new THREE.Matrix4()
const _c = new THREE.Color()

const GEOS = {
  box: () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  cyl: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 10).translate(0, 0.5, 0),
  cone: () => new THREE.ConeGeometry(0.5, 1, 8).translate(0, 0.5, 0),
}

/** Bounding rectangle (cells) of the cells inside `r` whose ground finish is `g`. */
export function finishRect(city, r, g) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let j = r.y; j < r.y + r.d; j++)
    for (let i = r.x; i < r.x + r.w; i++)
      if (city.ground[idx(i, j)] === g && city.buildingAt[idx(i, j)] < 0) {
        x0 = Math.min(x0, i)
        y0 = Math.min(y0, j)
        x1 = Math.max(x1, i)
        y1 = Math.max(y1, j)
      }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0 + 1, d: y1 - y0 + 1 }
}

const worldRect = (r) => ({ x0: cellToWorld(r.x) - CELL / 2, z0: cellToWorld(r.y) - CELL / 2, w: r.w * CELL, d: r.d * CELL })

/** Builds the props group for a city. groundAt(x, z) gives the terrain height. */
export function buildProps(city, groundAt) {
  const items = { box: [], cyl: [], cone: [] }
  const put = (g, x, y, z, w, h, d, c, ry = 0) => items[g].push({ x, y, z, w, h, d, c, ry })
  const onGround = (g, x, z, dy, w, h, d, c, ry = 0) => put(g, x, groundAt(x, z) + dy, z, w, h, d, c, ry)
  const bench = (x, z, ry) => {
    const y = groundAt(x, z)
    const s = Math.sin(ry)
    const c = Math.cos(ry)
    put('box', x, y + 0.42, z, 1.8, 0.08, 0.5, 0x7a5a3a, ry)
    put('box', x - s * 0.22, y + 0.5, z - c * 0.22, 1.8, 0.45, 0.06, 0x7a5a3a, ry)
    put('box', x, y, z, 1.6, 0.42, 0.4, 0x3d3f43, ry)
  }
  const lamp = (x, z) => {
    onGround('cyl', x, z, 0, 0.14, 4.2, 0.14, 0x30343a)
    onGround('box', x, z, 4.2, 0.5, 0.35, 0.5, 0xf2e3b5)
  }
  const fountain = (x, z, r) => {
    onGround('cyl', x, z, 0, 2 * r, 0.6, 2 * r, 0xc9c2b2)
    onGround('cyl', x, z, 0.05, 2 * r - 0.6, 0.6, 2 * r - 0.6, 0x5f8ea8)
    onGround('cyl', x, z, 0, 0.7, 2.2, 0.7, 0xc9c2b2)
    onGround('cyl', x, z, 2.2, r * 0.8, 0.3, r * 0.8, 0xc9c2b2)
    onGround('cone', x, z, 2.5, 0.5, 1.2, 0.5, 0xbfdcec)
  }
  const gazebo = (x, z, r) => {
    for (let q = 0; q < 6; q++) {
      const a = (q / 6) * Math.PI * 2
      onGround('box', x + Math.cos(a) * r, z + Math.sin(a) * r, 0, 0.25, 2.8, 0.25, 0xe8e4da)
    }
    onGround('cyl', x, z, 0, 2 * r + 0.6, 0.3, 2 * r + 0.6, 0xc9c2b2)
    onGround('cone', x, z, 2.8, 2 * r + 1.2, 1.8, 2 * r + 1.2, 0x5f7f78)
  }
  const playground = (x, z) => {
    onGround('box', x - 2, z, 0, 0.15, 2.4, 0.15, 0xc9483a)
    onGround('box', x + 1, z, 0, 0.15, 2.4, 0.15, 0xc9483a)
    onGround('box', x - 0.5, z, 2.4, 3.2, 0.15, 0.15, 0xc9483a)
    onGround('box', x, z + 3, 0, 2, 1.6, 2, 0x2f7a9e)
    onGround('cone', x, z + 3, 1.6, 2.4, 1.2, 2.4, 0xd39a2e)
    onGround('box', x + 1.8, z + 3, 0, 2.4, 0.9, 0.8, 0x4f8f4a)
  }
  const goal = (x, z, alongX) => {
    const hw = 3.6
    for (const s of [-1, 1]) onGround('box', x + (alongX ? 0 : s * hw), z + (alongX ? s * hw : 0), 0, 0.12, 2.4, 0.12, 0xf2f2ee)
    onGround('box', x, z, 2.4, alongX ? 0.12 : 2 * hw, 0.12, alongX ? 2 * hw : 0.12, 0xf2f2ee)
  }

  for (const p of city.parks || []) {
    const R = worldRect(p)
    const cx = R.x0 + R.w / 2
    const cz = R.z0 + R.d / 2
    if (p.big || p.w * p.d >= 12) {
      fountain(cx, cz, Math.min(4.5, R.w * 0.08))
      gazebo(R.x0 + R.w * 0.78, R.z0 + R.d * 0.25, 2.6)
      playground(R.x0 + R.w * 0.22, R.z0 + R.d * 0.72)
      for (let q = 0; q < 4; q++) {
        const a = (q / 4) * Math.PI * 2 + Math.PI / 4
        bench(cx + Math.cos(a) * 8, cz + Math.sin(a) * 8, -a + Math.PI / 2)
        lamp(cx + Math.cos(a) * 11, cz + Math.sin(a) * 11)
      }
    } else {
      bench(cx - 3, cz + 1.5, 0)
      bench(cx + 3, cz - 1.5, Math.PI)
      lamp(cx, cz)
      if (p.w * p.d >= 6) playground(cx + R.w * 0.2, cz - R.d * 0.2)
    }
  }

  for (const s of city.sites || []) {
    const field = finishRect(city, s, GROUND_FIELD)
    if (field) {
      const R = worldRect(field)
      const alongX = R.w >= R.d
      const cx = R.x0 + R.w / 2
      const cz = R.z0 + R.d / 2
      const half = (alongX ? R.w : R.d) / 2 - 7
      goal(cx + (alongX ? -half : 0), cz + (alongX ? 0 : -half), alongX)
      goal(cx + (alongX ? half : 0), cz + (alongX ? 0 : half), alongX)
      // bleachers along one side
      const bx = alongX ? cx : R.x0 + 1.5
      const bz = alongX ? R.z0 + 1.5 : cz
      for (let q = 0; q < 3; q++) onGround('box', bx + (alongX ? 0 : q * 0.9), bz + (alongX ? q * 0.9 : 0), 0, alongX ? 14 : 0.9, 0.5 + q * 0.5, alongX ? 0.9 : 14, 0x9aa3ab)
    }
    const court = finishRect(city, s, GROUND_COURT)
    if (court) {
      const R = worldRect(court)
      const cx = R.x0 + R.w / 2
      const cz = R.z0 + R.d / 2
      if (s.kind === 'primary') playground(cx, cz - 1.5)
      else {
        const alongX = R.w >= R.d
        for (const sg of [-1, 1]) {
          const x = cx + (alongX ? sg * (R.w / 2 - 1.5) : 0)
          const z = cz + (alongX ? 0 : sg * (R.d / 2 - 1.5))
          onGround('cyl', x, z, 0, 0.15, 3.05, 0.15, 0x3d3f43)
          onGround('box', x, z, 3.05, alongX ? 0.1 : 1.8, 1.05, alongX ? 1.8 : 0.1, 0xf2f2ee)
        }
      }
    }
    const plaza = finishRect(city, s, GROUND_PLAZA)
    if (plaza && ['civic', 'museum', 'library', 'clock', 'arch', 'needle'].includes(s.kind)) {
      const R = worldRect(plaza)
      for (const [fx, fz] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) lamp(R.x0 + R.w * fx, R.z0 + R.d * fz)
      if (s.kind === 'civic' && plaza.w * plaza.d >= 8) {
        // the fountain sits in the open square in front of the hall
        const fx = s.front === 1 ? R.x0 + R.w * 0.8 : s.front === 3 ? R.x0 + R.w * 0.2 : R.x0 + R.w / 2
        const fz = s.front === 0 ? R.z0 + R.d * 0.8 : s.front === 2 ? R.z0 + R.d * 0.2 : R.z0 + R.d / 2
        fountain(fx, fz, 4)
      }
    }
  }

  const group = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.75 })
  for (const g in items) {
    const list = items[g]
    if (!list.length) continue
    const mesh = new THREE.InstancedMesh(GEOS[g](), mat, list.length)
    list.forEach((it, q) => {
      _m.makeScale(it.w, it.h, it.d)
      if (it.ry) _m.premultiply(_r.makeRotationY(it.ry))
      _m.setPosition(it.x, it.y, it.z)
      mesh.setMatrixAt(q, _m)
      mesh.setColorAt(q, _c.set(it.c))
    })
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }
  return group
}
