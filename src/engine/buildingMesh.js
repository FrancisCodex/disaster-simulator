// Draws every building as instanced parts: facade masses in one mesh and
// detail parts (roofs, balconies, columns, domes...) in one mesh per shape.
// Parts never move on the CPU; each building's frame, sway, collapse and
// tint live in one row of a float texture that the vertex shaders read.
import * as THREE from 'three'
import { shapeOf } from './archetypes.js'
import { BLD_TEXELS, makeBodyMaterial, makeDetailMaterial, makePartsDepthMaterial } from './materials.js'

const FLAT = (g) => {
  const n = g.index ? g.toNonIndexed() : g
  n.computeVertexNormals()
  return n
}

function tri(p) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
  g.computeVertexNormals()
  return g
}

/** Unit-footprint geometries, base at y = 0, height 1. */
function partGeometries() {
  const a = 0.5
  return {
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    // ridge along x
    gable: tri([
      -a, 0, a, a, 0, a, a, 1, 0, -a, 0, a, a, 1, 0, -a, 1, 0,
      a, 0, -a, -a, 0, -a, -a, 1, 0, a, 0, -a, -a, 1, 0, a, 1, 0,
      a, 0, a, a, 0, -a, a, 1, 0, -a, 0, -a, -a, 0, a, -a, 1, 0,
    ]),
    // hipped: a short ridge along x, sloping on all four sides
    hip: tri([
      -a, 0, a, a, 0, a, 0.25, 1, 0, -a, 0, a, 0.25, 1, 0, -0.25, 1, 0,
      a, 0, -a, -a, 0, -a, -0.25, 1, 0, a, 0, -a, -0.25, 1, 0, 0.25, 1, 0,
      a, 0, a, a, 0, -a, 0.25, 1, 0, -a, 0, -a, -a, 0, a, -0.25, 1, 0,
    ]),
    // mono-pitch: tall side at -z, sloping down to +z
    shed: tri([
      -a, 0, -a, -a, 1, -a, a, 1, -a, -a, 0, -a, a, 1, -a, a, 0, -a,
      -a, 1, -a, -a, 0, a, a, 0, a, -a, 1, -a, a, 0, a, a, 1, -a,
      -a, 0, -a, -a, 0, a, -a, 1, -a, a, 0, -a, a, 1, -a, a, 0, a,
      -a, 0, -a, a, 0, -a, a, 0, a, -a, 0, -a, a, 0, a, -a, 0, a,
    ]),
    pyr: FLAT(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0)),
    cone: new THREE.ConeGeometry(0.5, 1, 12).translate(0, 0.5, 0),
    cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12).translate(0, 0.5, 0),
    dome: new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 2, 1),
    // half cylinder lying along x
    barrel: new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).scale(1, 2, 1),
  }
}

function instanced(base, n) {
  const g = new THREE.InstancedBufferGeometry()
  g.index = base.index
  for (const k of ['position', 'normal', 'uv']) if (base.attributes[k]) g.setAttribute(k, base.attributes[k])
  g.instanceCount = n
  return g
}

const _inv = new THREE.Matrix4()
const _ray = new THREE.Ray()
const _p = new THREE.Vector3()
const _box = new THREE.Box3()

export class BuildingParts {
  constructor({ uNight, envMap, cell }) {
    this.cell = cell
    this.uNight = uNight
    this.envMap = envMap
    this.uBld = { value: null }
    this.group = new THREE.Group()
    this.geos = partGeometries()
    this.bodyBase = new THREE.BoxGeometry(1, 1, 1, 1, 8, 1).translate(0, 0.5, 0)
    this.materials = []
  }

  /** (Re)builds all meshes for the given buildings; list order is the texture row. */
  build(list) {
    this.dispose(false)
    const n = Math.max(1, list.length)
    this.list = list
    this.shapes = list.map((b) => shapeOf(b, this.cell))
    const data = new Float32Array(BLD_TEXELS * 4 * n)
    this.data = data
    const tex = new THREE.DataTexture(data, BLD_TEXELS, n, THREE.RGBAFormat, THREE.FloatType)
    tex.minFilter = tex.magFilter = THREE.NearestFilter
    tex.generateMipmaps = false
    tex.needsUpdate = true
    this.tex = tex
    this.uBld.value = tex
    this.frames = new Float32Array(16 * n)

    // facade masses
    let nm = 0
    for (const s of this.shapes) nm += s.masses.length
    const pos = new Float32Array(nm * 4)
    const size = new Float32Array(nm * 4)
    const col = new Float32Array(nm * 4)
    const info = new Float32Array(nm * 4)
    let q = 0
    this.shapes.forEach((s, row) => {
      const b = list[row]
      for (const m of s.masses) {
        pos.set([m.x, m.y, m.z, m.ry], q * 4)
        size.set([m.w, m.h, m.d, row], q * 4)
        col.set([...m.color, 0], q * 4)
        info.set([m.fh, m.style, Math.floor(b.seed * 997) + q, m.flags], q * 4)
        q++
      }
    })
    const bg = instanced(this.bodyBase, nm)
    bg.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 4))
    bg.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 4))
    bg.setAttribute('iColor', new THREE.InstancedBufferAttribute(col, 4))
    bg.setAttribute('iInfo', new THREE.InstancedBufferAttribute(info, 4))
    const bodyMat = makeBodyMaterial({ uNight: this.uNight, uBld: this.uBld, envMap: this.envMap })
    this.bodyMat = bodyMat
    this.add(bg, bodyMat, makePartsDepthMaterial(this.uBld, false))

    // details, grouped by shape
    const byGeo = {}
    this.shapes.forEach((s, row) => {
      for (const d of s.details) (byGeo[d.g] ||= []).push([d, row])
    })
    this.detailMat = makeDetailMaterial({ uBld: this.uBld, envMap: this.envMap })
    const depth = makePartsDepthMaterial(this.uBld, true)
    for (const g in byGeo) {
      const items = byGeo[g]
      const k = items.length
      const p = new Float32Array(k * 4)
      const sz = new Float32Array(k * 4)
      const c = new Float32Array(k * 4)
      items.forEach(([d, row], i) => {
        p.set([d.x, d.y, d.z, d.ry], i * 4)
        sz.set([d.w, d.h, d.d, row], i * 4)
        c.set([...d.color, d.flags], i * 4)
      })
      const geo = instanced(this.geos[g], k)
      geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(p, 4))
      geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(sz, 4))
      geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(c, 4))
      this.add(geo, this.detailMat, depth)
    }
    this.materials = [bodyMat, this.detailMat]
    return this
  }

  add(geo, mat, depth) {
    const m = new THREE.Mesh(geo, mat)
    m.customDepthMaterial = depth
    m.castShadow = true
    m.receiveShadow = true
    // parts are placed in the shader: the base geometry's bounds mean nothing
    m.frustumCulled = false
    this.group.add(m)
  }

  /** Live state of building `row`. frame: Matrix4 (building metres → world). */
  set(row, frame, swayX, swayZ, H, cut, sink, flags) {
    const o = row * BLD_TEXELS * 4
    const e = frame.elements
    const d = this.data
    // rows of the affine part of a column-major matrix
    d[o] = e[0]
    d[o + 1] = e[4]
    d[o + 2] = e[8]
    d[o + 3] = e[12]
    d[o + 4] = e[1]
    d[o + 5] = e[5]
    d[o + 6] = e[9]
    d[o + 7] = e[13]
    d[o + 8] = e[2]
    d[o + 9] = e[6]
    d[o + 10] = e[10]
    d[o + 11] = e[14]
    d[o + 12] = swayX
    d[o + 13] = swayZ
    d[o + 14] = H
    d[o + 15] = cut
    d[o + 16] = sink
    d[o + 17] = flags
    this.frames.set(e, row * 16)
    this.dirty = true
  }

  /** Colour override for a building's facades and details: rgb (linear) and amount. */
  setTint(row, body, detail) {
    const o = row * BLD_TEXELS * 4 + 20
    this.data.set(body, o)
    this.data.set(detail, o + 4)
    this.dirty = true
  }

  flush() {
    if (!this.dirty || !this.tex) return
    this.dirty = false
    this.tex.needsUpdate = true
  }

  /** Nearest building hit by a world-space ray, or null. */
  raycast(ray) {
    if (!this.list) return null
    let best = null
    let bestD = Infinity
    const data = this.data
    for (let row = 0; row < this.list.length; row++) {
      const b = this.list[row]
      const r = Math.hypot(b.fw, b.fd, b.height) * 0.6 + 12
      _p.set(b.cx, b.base + b.height * 0.5, b.cz)
      if (ray.distanceSqToPoint(_p) > r * r * 4) continue
      _inv.fromArray(this.frames, row * 16).invert()
      _ray.copy(ray).applyMatrix4(_inv)
      const o = row * BLD_TEXELS * 4
      const cut = data[o + 15]
      const sink = data[o + 16]
      for (const m of this.shapes[row].masses) {
        const c = Math.abs(Math.cos(m.ry))
        const s = Math.abs(Math.sin(m.ry))
        const hx = (c * m.w + s * m.d) / 2
        const hz = (s * m.w + c * m.d) / 2
        const top = Math.max(0.5, Math.min(m.y + m.h, cut) - sink)
        const bot = Math.max(0, Math.min(m.y, cut) - sink)
        _box.min.set(m.x - hx, bot, m.z - hz)
        _box.max.set(m.x + hx, top, m.z + hz)
        if (!_ray.intersectBox(_box, _p)) continue
        // back to world to compare distances
        _p.applyMatrix4(_inv.fromArray(this.frames, row * 16))
        const dist = _p.distanceTo(ray.origin)
        if (dist < bestD) {
          bestD = dist
          best = { row, point: _p.clone() }
        }
        _inv.fromArray(this.frames, row * 16).invert()
      }
    }
    return best
  }

  /** Height of the roof (local metres above the base) of building `row` at local (lx, lz), or -1. */
  roofAt(row, lx, lz) {
    const o = row * BLD_TEXELS * 4
    const cut = this.data[o + 15]
    const sink = this.data[o + 16]
    let top = -1
    for (const m of this.shapes[row].masses) {
      const c = Math.cos(m.ry)
      const s = Math.sin(m.ry)
      const dx = lx - m.x
      const dz = lz - m.z
      // into the mass's own axes (inverse of the y rotation)
      const ux = c * dx - s * dz
      const uz = s * dx + c * dz
      if (Math.abs(ux) > m.w / 2 + 0.3 || Math.abs(uz) > m.d / 2 + 0.3) continue
      top = Math.max(top, Math.max(0, Math.min(m.y + m.h, cut) - sink))
    }
    return top
  }

  dispose(all = true) {
    for (const m of [...this.group.children]) {
      this.group.remove(m)
      m.geometry.dispose()
      m.customDepthMaterial?.dispose()
    }
    for (const m of this.materials) m.dispose()
    this.materials = []
    this.tex?.dispose()
    this.tex = null
    if (all) {
      for (const g of Object.values(this.geos)) g.dispose()
      this.bodyBase.dispose()
    }
  }
}
