// Visual effects: GPU point particles (fire, smoke, dust), rigid-body debris,
// and rain streaks.
import * as THREE from 'three'

function makeSoftTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.4, 'rgba(255,255,255,0.55)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export class Particles {
  constructor(scene, max, additive) {
    this.max = max
    this.pos = new Float32Array(max * 3)
    this.col = new Float32Array(max * 4)
    this.size = new Float32Array(max)
    this.vel = new Float32Array(max * 3)
    this.life = new Float32Array(max)
    this.maxLife = new Float32Array(max)
    this.grow = new Float32Array(max)
    this.c0 = new Float32Array(max * 4)
    this.c1 = new Float32Array(max * 4)
    this.cursor = 0
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    this.geo = geo
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: makeSoftTexture() }, uScale: { value: 800 } },
      vertexShader: `
        attribute vec4 aColor; attribute float aSize; varying vec4 vColor;
        uniform float uScale;
        void main(){ vColor = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = aSize * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform sampler2D uTex; varying vec4 vColor;
        void main(){ vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vColor.rgb, vColor.a * t.a); if (gl_FragColor.a < 0.01) discard;
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    scene.add(this.points)
  }

  emit(x, y, z, vx, vy, vz, size, grow, life, c0, c1) {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.max
    this.pos.set([x, y, z], i * 3)
    this.vel.set([vx, vy, vz], i * 3)
    this.size[i] = size
    this.grow[i] = grow
    this.life[i] = life
    this.maxLife[i] = life
    this.c0.set(c0, i * 4)
    this.c1.set(c1, i * 4)
  }

  update(dt, wind = 0) {
    const { pos, vel, col, size, life, maxLife, grow, c0, c1 } = this
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) {
        col[i * 4 + 3] = 0
        continue
      }
      life[i] -= dt
      const t = 1 - life[i] / maxLife[i]
      pos[i * 3] += (vel[i * 3] + wind) * dt
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt
      vel[i * 3] *= 0.99
      vel[i * 3 + 2] *= 0.99
      size[i] += grow[i] * dt
      for (let c = 0; c < 4; c++) col[i * 4 + c] = c0[i * 4 + c] + (c1[i * 4 + c] - c0[i * 4 + c]) * t
      if (life[i] <= 0) col[i * 4 + 3] = 0
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.aColor.needsUpdate = true
    this.geo.attributes.aSize.needsUpdate = true
  }

  clear() {
    this.life.fill(0)
    this.col.fill(0)
    this.geo.attributes.aColor.needsUpdate = true
  }
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _s = new THREE.Vector3()
const _p = new THREE.Vector3()
const _c = new THREE.Color()

/** Simple rigid-body debris: gravity, ground contact with restitution and friction, sleeping. */
export class Debris {
  constructor(scene, max = 3000) {
    this.max = max
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9 })
    this.mesh = new THREE.InstancedMesh(geo, mat, max)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.items = []
    this.cursor = 0
    scene.add(this.mesh)
    this.surfaceAt = () => ({ y: 0, bid: -1 })
  }

  /**
   * opts: { dims: [sx,sy,sz] exact size, fragile: shatters on hard impact,
   *         src: id of the building it came from (ignored for roof contact) }
   */
  spawn(x, y, z, vx, vy, vz, size, color, opts = {}) {
    let it
    let i
    if (this.items.length < this.max) {
      it = {}
      i = this.items.push(it) - 1
    } else {
      i = this.cursor
      it = this.items[i]
      this.cursor = (this.cursor + 1) % this.max
    }
    const d = opts.dims
    Object.assign(it, {
      x,
      y,
      z,
      vx,
      vy,
      vz,
      sx: d ? d[0] : size * (0.6 + Math.random() * 0.8),
      sy: d ? d[1] : size * (0.3 + Math.random() * 0.5),
      sz: d ? d[2] : size * (0.6 + Math.random() * 0.8),
      rx: d ? 0 : Math.random() * 6,
      ry: d ? 0 : Math.random() * 6,
      rz: d ? 0 : Math.random() * 6,
      wx: d ? (Math.random() - 0.5) * 0.6 : (Math.random() - 0.5) * 8,
      wy: d ? 0 : (Math.random() - 0.5) * 8,
      wz: d ? (Math.random() - 0.5) * 0.6 : (Math.random() - 0.5) * 8,
      sleep: false,
      dirty: true,
      fragile: !!opts.fragile,
      src: opts.src ?? -1,
      color,
      age: 0,
      dead: false,
      rimY: undefined,
      burn: opts.burn ?? 0, // seconds it keeps burning
    })
    _c.set(color)
    if (!d) _c.offsetHSL(0, 0, (Math.random() - 0.5) * 0.15)
    this.mesh.setColorAt(i, _c)
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this.mesh.count = this.items.length
    return it
  }

  update(dt) {
    let changed = false
    const steps = Math.min(4, Math.ceil(dt / (1 / 120)))
    const h = dt / steps
    const shatter = []
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]
      if (it.dead || (it.sleep && !it.dirty)) continue
      it.age += dt
      for (let s = 0; s < steps && !it.sleep; s++) {
        it.vy -= 9.81 * h
        it.x += it.vx * h
        it.y += it.vy * h
        it.z += it.vz * h
        it.rx += it.wx * h
        it.ry += it.wy * h
        it.rz += it.wz * h
        // thrown past the edge of the district: gone once it drops below the rim
        if (this.half && (Math.abs(it.x) > this.half || Math.abs(it.z) > this.half)) {
          if (it.rimY === undefined) it.rimY = this.edgeAt(it.x, it.z)
          if (it.y < it.rimY - 8) {
            it.dead = true
            break
          }
          continue
        }
        // lands on the ground, or on the roof of a standing building
        const surf = this.surfaceAt(it.x, it.z, it.age < 0.6 ? it.src : -1)
        const g = surf.y + it.sy * 0.5
        if (it.y < g) {
          const impact = -it.vy
          if (impact > 4) this.onLand?.(it, impact, surf.bid)
          if (it.fragile && impact > 3) {
            shatter.push(it)
            it.dead = true
            break
          }
          it.y = g
          if (it.vy < 0) it.vy = -it.vy * 0.25
          it.vx *= 0.55
          it.vz *= 0.55
          it.wx *= 0.5
          it.wy *= 0.5
          it.wz *= 0.5
          if (Math.abs(it.vy) < 0.6 && Math.hypot(it.vx, it.vz) < 0.4) {
            it.sleep = true
            it.rx = Math.round(it.rx / (Math.PI / 2)) * (Math.PI / 2) * 0.3 + it.rx * 0.7
          }
        }
      }
      if (it.dead) _m.makeScale(0, 0, 0)
      else {
        _p.set(it.x, it.y, it.z)
        _q.setFromEuler(_e.set(it.rx, it.ry, it.rz))
        _s.set(it.sx, it.sy, it.sz)
        _m.compose(_p, _q, _s)
      }
      this.mesh.setMatrixAt(i, _m)
      it.dirty = false
      changed = true
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true
    for (const it of shatter) this.onShatter?.(it)
  }

  /** Wake resting pieces (e.g. the roof they sat on just collapsed). */
  wakeAll() {
    for (const it of this.items) if (it.sleep && !it.dead) it.sleep = false
  }

  clear() {
    this.items = []
    this.cursor = 0
    this.mesh.count = 0
  }
}

export class Rain {
  constructor(scene, max = 9000) {
    this.max = max
    this.pos = new Float32Array(max * 6)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo = geo
    this.mat = new THREE.LineBasicMaterial({ color: 0xb8c6d4, transparent: true, opacity: 0.35, depthWrite: false })
    this.lines = new THREE.LineSegments(geo, this.mat)
    this.lines.frustumCulled = false
    scene.add(this.lines)
    this.count = 0
    for (let i = 0; i < max; i++) this.reset(i, 0, 0, true)
  }

  reset(i, cx, cz, randomY) {
    let x = cx + (Math.random() - 0.5) * 700
    let z = cz + (Math.random() - 0.5) * 700
    if (this.bounds) {
      x = Math.max(-this.bounds, Math.min(this.bounds, x))
      z = Math.max(-this.bounds, Math.min(this.bounds, z))
    }
    const top = (this.ground ? this.ground(x, z) : 0) + 320
    const y = randomY ? top - Math.random() * 320 : top
    this.pos.set([x, y, z, x + 0.4, y - 4, z], i * 6)
  }

  /** ground(x,z): surface height so drops stop on roofs and roads; bounds: keep rain over the district only (cut-away view). */
  update(dt, intensity, center, ground = null, bounds = 0) {
    this.ground = ground
    this.bounds = bounds
    const n = Math.min(this.max, Math.round(intensity * 140))
    this.count = n
    this.geo.setDrawRange(0, n * 2)
    this.lines.visible = n > 0
    if (!n) return
    const fall = 55 * dt
    const p = this.pos
    for (let i = 0; i < n; i++) {
      p[i * 6 + 1] -= fall
      p[i * 6 + 4] -= fall
      const x = p[i * 6]
      const z = p[i * 6 + 2]
      const floor = ground ? ground(x, z) : center.y - 20
      if (p[i * 6 + 4] < floor) this.reset(i, center.x, center.z, false)
    }
    this.geo.attributes.position.needsUpdate = true
  }
}
