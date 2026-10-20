// Storm weather you can see: a typhoon's cloud deck turning overhead, ragged
// low scud racing past with the wind, and the wind itself — streaks of
// wind-driven rain and spray close to the ground, and leaves torn off trees.
import * as THREE from 'three'

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Tileable cloud texture: soft blobs drawn wrapped around the edges, stretched into bands. */
function cloudTexture(w, h, blobs, stretch, seed) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  let s = seed
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let n = 0; n < blobs; n++) {
    const x = rnd() * w
    const y = rnd() * h
    const r = (0.03 + rnd() * rnd() * 0.16) * w
    const a = 0.12 + rnd() * 0.3
    for (const ox of [-w, 0, w])
      for (const oy of [-h, 0, h]) {
        g.save()
        g.translate(x + ox, y + oy)
        g.scale(stretch, 1)
        const grd = g.createRadialGradient(0, 0, 0, 0, 0, r)
        grd.addColorStop(0, `rgba(255,255,255,${a})`)
        grd.addColorStop(0.6, `rgba(255,255,255,${a * 0.4})`)
        grd.addColorStop(1, 'rgba(255,255,255,0)')
        g.fillStyle = grd
        g.fillRect(-r, -r, r * 2, r * 2)
        g.restore()
      }
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function puffTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  for (let n = 0; n < 14; n++) {
    const x = 34 + Math.random() * 60
    const y = 44 + Math.random() * 40
    const r = 18 + Math.random() * 26
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    grd.addColorStop(0, 'rgba(255,255,255,0.5)')
    grd.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, 128, 128)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/**
 * The cloud deck: two layers on the inside of a dome around the view (they
 * scroll at different speeds for depth), plus scud — low, fast, ragged
 * cloud under the deck — as sprites drifting with the wind. Seen mostly
 * toward the horizon; the city below stays readable from above.
 */
export class StormClouds {
  constructor(scene) {
    this.group = new THREE.Group()
    this.layers = [
      { r: 4200, tex: cloudTexture(1024, 512, 260, 2.2, 7), rep: [5, 2.2], speed: 1 },
      { r: 3600, tex: cloudTexture(512, 256, 140, 3.2, 31), rep: [7, 3], speed: 1.7 },
    ].map((L) => {
      L.tex.repeat.set(L.rep[0], L.rep[1])
      const geo = new THREE.SphereGeometry(L.r, 48, 14, 0, Math.PI * 2, 0, Math.PI * 0.49)
      const mat = new THREE.MeshBasicMaterial({ map: L.tex, color: 0x5c6470, transparent: true, opacity: 0, depthWrite: false, side: THREE.BackSide, fog: false })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.renderOrder = -2
      mesh.frustumCulled = false
      this.group.add(mesh)
      return { ...L, mesh, mat }
    })
    const puff = puffTexture()
    this.scud = []
    for (let q = 0; q < 70; q++) {
      const mat = new THREE.SpriteMaterial({ map: puff, color: 0x6b7480, transparent: true, opacity: 0, depthWrite: false })
      const sp = new THREE.Sprite(mat)
      const size = 140 + Math.random() * 220
      sp.scale.set(size * 1.8, size, 1)
      sp.position.set((Math.random() - 0.5) * 1800, 170 + Math.random() * 220, (Math.random() - 0.5) * 1800)
      sp.userData.base = 0.25 + Math.random() * 0.35
      sp.visible = false
      this.group.add(sp)
      this.scud.push(sp)
    }
    scene.add(this.group)
    this.cover = 0
  }

  /**
   * cover: 0 clear … 1 full typhoon deck; wind: [x, z] m/s at 10 m; center: the
   * view's target; camera; tint: THREE.Color for the cloud base (day/night lit).
   */
  update(dt, { cover = 0, wind = [0, 0], center, camera, tint }) {
    this.cover += (cover - this.cover) * Math.min(1, dt * 0.8)
    const c = this.cover
    this.group.visible = c > 0.01
    if (!this.group.visible) return
    const sp = Math.hypot(wind[0], wind[1])
    for (const L of this.layers) {
      L.mesh.position.set(center.x, -300, center.z)
      // the deck turns with the storm's circulation, faster when the wind is up
      L.tex.offset.x += (wind[0] * 0.000012 + 0.000004 * sp) * L.speed * dt
      L.tex.offset.y += wind[1] * 0.00001 * L.speed * dt
      L.mat.opacity = Math.min(0.97, c * (L.speed > 1 ? 0.75 : 1.05))
      L.mat.color.copy(tint)
    }
    const nScud = Math.round(this.scud.length * smooth(0.25, 0.9, c))
    const half = 900
    this.scud.forEach((s, q) => {
      s.visible = q < nScud
      if (!s.visible) return
      // scud runs ahead of the surface wind (it sits in faster air aloft)
      s.position.x += wind[0] * 1.6 * dt
      s.position.z += wind[1] * 1.6 * dt
      const dx = s.position.x - center.x
      const dz = s.position.z - center.z
      if (dx > half) s.position.x -= 2 * half
      else if (dx < -half) s.position.x += 2 * half
      if (dz > half) s.position.z -= 2 * half
      else if (dz < -half) s.position.z += 2 * half
      // thin out what is right in front of the camera, and what it looks down through
      const d = s.position.distanceTo(camera.position)
      const above = camera.position.y > s.position.y + 60 ? 0.45 : 1
      s.material.opacity = s.userData.base * c * smooth(90, 360, d) * above
      s.material.color.copy(tint).multiplyScalar(1.5)
    })
  }
}

/**
 * The wind made visible near the ground: fast streaks of wind-driven rain
 * and spray (they lengthen with speed and come in gusty bursts), leaves torn
 * off the trees, and spindrift blown off the river.
 */
export class WindStreaks {
  constructor(scene, max = 1400) {
    this.max = max
    this.pos = new Float32Array(max * 6)
    this.st = Array.from({ length: max }, () => ({ x: 0, y: 0, z: 0, life: 0, max: 1 }))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo = geo
    this.mat = new THREE.LineBasicMaterial({ color: 0xe4ebf2, transparent: true, opacity: 0.22, depthWrite: false })
    this.lines = new THREE.LineSegments(geo, this.mat)
    this.lines.frustumCulled = false
    scene.add(this.lines)
    this.t = 0
  }

  /** wind: [x, z] m/s; ground(x, z) → height; gust: 0.6–1.4 multiplier for bursts. */
  update(dt, wind, center, ground, night = 0) {
    this.t += dt
    const sp = Math.hypot(wind[0], wind[1])
    const amount = smooth(11, 45, sp)
    const n = Math.round(this.max * amount)
    this.lines.visible = n > 0
    if (!n) return
    const ux = wind[0] / sp
    const uz = wind[1] / sp
    // gust bursts: the streak field brightens and lengthens in waves
    const burst = 0.75 + 0.25 * Math.sin(this.t * 1.3) + 0.15 * Math.sin(this.t * 3.7)
    const len = Math.min(16, sp * 0.16) * burst
    const p = this.pos
    for (let i = 0; i < n; i++) {
      const s = this.st[i]
      s.life -= dt
      if (s.life <= 0) {
        // respawn upwind of the view so streaks sweep across it
        s.x = center.x + (Math.random() - 0.5) * 520 - ux * 120
        s.z = center.z + (Math.random() - 0.5) * 520 - uz * 120
        s.y = (ground ? ground(s.x, s.z) : 0) + 1 + Math.random() * Math.random() * 30
        s.max = s.life = 0.5 + Math.random() * 0.9
      }
      s.x += wind[0] * 1.1 * dt
      s.z += wind[1] * 1.1 * dt
      const f = Math.sin((s.life / s.max) * Math.PI) // fade in and out by length
      const l = len * f
      p.set([s.x, s.y, s.z, s.x - ux * l, s.y + 0.15, s.z - uz * l], i * 6)
    }
    this.geo.setDrawRange(0, n * 2)
    this.geo.attributes.position.needsUpdate = true
    this.mat.opacity = (0.12 + 0.16 * amount) * (1 - night * 0.55) * burst
  }
}
