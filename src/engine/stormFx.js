// Thunderstorm visuals: lightning (a branching bolt to the strike point,
// cloud flashes that light up the whole scene) and a tornado (a rotating
// condensation funnel reaching down from the cloud base, with a skirt of
// dust and debris swirling around its foot).
import * as THREE from 'three'

const CLOUD_BASE = 420 // m above the ground the bolts start from and the funnel hangs below

/** A jagged path from the cloud base down to (x, y, z), with a couple of forks. */
function boltPaths(x, y, z) {
  const main = []
  let px = x + (Math.random() - 0.5) * 160
  let pz = z + (Math.random() - 0.5) * 160
  const top = y + CLOUD_BASE
  const n = 22
  for (let q = 0; q <= n; q++) {
    const f = q / n
    // wander less as the leader closes in on what it struck
    const k = (1 - f) * 22
    px += (x - px) * (0.18 + f * 0.5) + (Math.random() - 0.5) * k
    pz += (z - pz) * (0.18 + f * 0.5) + (Math.random() - 0.5) * k
    main.push(new THREE.Vector3(q === n ? x : px, top - (top - y) * f, q === n ? z : pz))
  }
  const forks = []
  for (let b = 0; b < 3; b++) {
    const s = main[3 + Math.floor(Math.random() * 10)]
    const pts = [s.clone()]
    const dx = (Math.random() - 0.5) * 2
    const dz = (Math.random() - 0.5) * 2
    for (let q = 1; q < 6; q++) pts.push(pts[q - 1].clone().add(new THREE.Vector3(dx * 14 + (Math.random() - 0.5) * 10, -18 - Math.random() * 12, dz * 14 + (Math.random() - 0.5) * 10)))
    forks.push(pts)
  }
  return [main, ...forks]
}

export class StormFx {
  constructor(scene, dust) {
    this.scene = scene
    this.dust = dust
    this.group = new THREE.Group()
    scene.add(this.group)
    // lightning lights the whole scene for an instant
    this.flashLight = new THREE.HemisphereLight(0xe4ebff, 0x8a93a8, 0)
    scene.add(this.flashLight)
    this.flash = 0
    this.flicker = 0
    this.bolts = []
    this.boltMat = new THREE.MeshBasicMaterial({ color: 0xf2f5ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    // the tornado: two nested funnels turning at different rates
    const prof = []
    for (let q = 0; q <= 24; q++) {
      const f = q / 24
      // narrow rope near the ground, flaring into the wall cloud
      prof.push(new THREE.Vector2(0.35 + 0.65 * f ** 2.2 * 6 + 0.15 * Math.sin(f * 9), f))
    }
    const geo = new THREE.LatheGeometry(prof, 28)
    // the funnel fades into the dust at its foot and into the cloud at its top
    const uv = geo.attributes.uv
    const col = new Float32Array(uv.count * 4)
    for (let q = 0; q < uv.count; q++) {
      const f = uv.getY(q)
      col.set([1, 1, 1, Math.min(1, f / 0.06) * (1 - Math.max(0, (f - 0.7) / 0.3) ** 1.5)], q * 4)
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4))
    const mat = (color, opacity) => new THREE.MeshStandardMaterial({ color, roughness: 1, transparent: true, opacity, vertexColors: true, depthWrite: false, side: THREE.DoubleSide })
    this.funnel = new THREE.Group()
    this.funnelIn = new THREE.Mesh(geo, mat(0x6d7077, 0.8))
    this.funnelOut = new THREE.Mesh(geo, mat(0x8a8d92, 0.32))
    this.funnelOut.scale.set(1.35, 1, 1.35)
    // the lowered, slowly turning wall cloud it hangs from
    this.wallCloud = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 10), new THREE.MeshStandardMaterial({ color: 0x4d5158, roughness: 1, transparent: true, opacity: 0.88, depthWrite: false }))
    this.wallCloud.scale.set(9, 0.09, 9)
    this.wallCloud.position.y = 1
    this.funnel.add(this.funnelIn, this.funnelOut, this.wallCloud)
    this.funnel.visible = false
    this.group.add(this.funnel)
    this.tornado = null
  }

  /** A cloud-to-ground strike at (x, y, z); dist: how far the camera is (for the flash's strength). */
  strike(x, y, z) {
    for (const pts of boltPaths(x, y, z)) {
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1)
      const main = pts.length > 10
      const core = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 3, main ? 0.9 : 0.45, 5), this.boltMat)
      const glow = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, main ? 5 : 2.5, 6), this.glowMat)
      this.group.add(core, glow)
      this.bolts.push({ meshes: [core, glow], age: 0, life: 0.32 + Math.random() * 0.15 })
    }
    this.flash = Math.max(this.flash, 1)
    this.flicker = 0.35
  }

  /** A flash inside the clouds: the scene lights up without a bolt. */
  cloudFlash(k = 0.5) {
    this.flash = Math.max(this.flash, k)
    this.flicker = 0.2 + Math.random() * 0.2
  }

  /** The tornado at (x, z) on ground y, core radius rc (m), or null when there is none. */
  setTornado(t) {
    this.tornado = t
    this.funnel.visible = !!t
    if (!t) return
    const r = t.rc * 0.9
    this.funnel.position.set(t.x, t.y, t.z)
    this.funnel.scale.set(r, CLOUD_BASE, r)
  }

  update(dt, night = 0) {
    // the flash flickers (return strokes) and fades
    if (this.flicker > 0) this.flicker -= dt
    const strobe = this.flicker > 0 ? (Math.random() < 0.55 ? 1 : 0.25) : 1
    this.flashLight.intensity = this.flash * strobe * (2.2 + 2.5 * night)
    this.flash = Math.max(0, this.flash - dt * (this.flicker > 0 ? 1.2 : 6))
    for (let q = this.bolts.length - 1; q >= 0; q--) {
      const b = this.bolts[q]
      b.age += dt
      const vis = b.age < b.life && (b.age < 0.06 || Math.random() < 0.7)
      for (const m of b.meshes) m.visible = vis
      if (b.age >= b.life) {
        for (const m of b.meshes) {
          this.group.remove(m)
          m.geometry.dispose()
        }
        this.bolts.splice(q, 1)
      }
    }
    const t = this.tornado
    if (!t) return
    this.funnelIn.rotation.y += dt * 2.6
    this.funnelOut.rotation.y -= dt * 1.1
    // the funnel sways as it walks
    this.funnel.rotation.z = Math.sin(performance.now() / 900) * 0.06
    // a skirt of dust and debris swirling around its foot
    const n = Math.round(dt * 90)
    for (let q = 0; q < n; q++) {
      const a = Math.random() * Math.PI * 2
      const r = t.rc * (0.6 + Math.random() * 1.2)
      const sp = 20 + Math.random() * 15
      this.dust.emit(t.x + Math.cos(a) * r, t.y + Math.random() * 6, t.z + Math.sin(a) * r, Math.sin(a) * sp * t.hemi + t.mx, 4 + Math.random() * 12, -Math.cos(a) * sp * t.hemi + t.mz, 6 + Math.random() * 6, 10, 1.4 + Math.random(), [0.42, 0.4, 0.36, 0.55], [0.5, 0.48, 0.44, 0])
    }
  }
}
