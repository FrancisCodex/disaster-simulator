// "Diorama" mode: the district sits on a cut-away block of ground so you can
// see what happens underneath during an earthquake — rock strata, the fault
// plane, the rupture slipping, and P- and S-waves travelling up from the
// hypocentre to the city. Not to scale: real hypocentres are kilometres deep.
import * as THREE from 'three'
import { GRID, CELL } from './config.js'

const HALF = (GRID * CELL) / 2
const BOTTOM = -300 // metres
const V_P = 420 // visual wave speeds (m/s of animation), P faster than S
const V_S = 240
const DIP = (55 * Math.PI) / 180

const STRATA = /* glsl */ `
float sHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float sNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y);
}
vec3 strata(vec3 q, float riverX) {
  float h = q.x + q.z;
  float d = uDatum - q.y + (sNoise(vec2(h * 0.012, 3.0)) - 0.5) * 10.0;
  float alluvium = 16.0 + 26.0 * exp(-abs(q.x - riverX) / 140.0);
  float grain = sHash(floor(vec2(h * 2.0, q.y * 2.0)));
  vec3 c;
  if (d < 1.8) c = vec3(0.30, 0.22, 0.15);
  else if (d < alluvium) c = mix(vec3(0.62, 0.50, 0.33), vec3(0.50, 0.42, 0.30), sNoise(vec2(h * 0.05, q.y * 0.4))) * (0.9 + grain * 0.2);
  else if (d < 75.0) c = mix(vec3(0.47, 0.40, 0.35), vec3(0.55, 0.47, 0.40), step(0.5, fract(d * 0.22)));
  else if (d < 150.0) c = mix(vec3(0.70, 0.56, 0.40), vec3(0.62, 0.48, 0.34), sNoise(vec2(h * 0.02, d * 0.25)));
  else if (d < 205.0) c = vec3(0.33, 0.32, 0.32) * (0.9 + 0.1 * step(0.5, fract(d * 0.6)));
  else c = vec3(0.44, 0.43, 0.45) * (0.85 + grain * 0.3);
  // thin dark partings at bedding planes
  float bed = abs(fract(d / 9.0) - 0.5);
  c *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.03, bed)) * step(alluvium, d);
  return c;
}`

export class Subsurface {
  constructor(world) {
    this.world = world
    this.group = new THREE.Group()
    this.uniforms = {
      uDatum: { value: 20 },
      uRiverX: { value: 0 },
      uFaultOn: { value: 0 },
      uFaultP: { value: new THREE.Vector3() },
      uFaultN: { value: new THREE.Vector3(0, 1, 0) },
      uSlipDir: { value: new THREE.Vector3() },
      uSlip: { value: 0 },
      uHypo: { value: new THREE.Vector3() },
      uWaveT: { value: -1 },
      uWaveAmp: { value: 0 },
    }
    this.slipTarget = 0
    this.waveT = -1
  }

  makeMaterial() {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.95, side: THREE.DoubleSide })
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms)
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vWP;
          uniform float uDatum; uniform float uRiverX; uniform float uFaultOn;
          uniform vec3 uFaultP; uniform vec3 uFaultN; uniform vec3 uSlipDir; uniform float uSlip;
          uniform vec3 uHypo; uniform float uWaveT; uniform float uWaveAmp;
          vec3 gGlow = vec3(0.0);
          ${STRATA}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec3 p = vWP;
            float sd = dot(p - uFaultP, uFaultN) * uFaultOn;
            // the hanging wall (above the fault) is thrust up-dip by the slip
            vec3 q = p - step(0.0, sd) * uSlipDir * uSlip * uFaultOn;
            vec3 c = strata(q, uRiverX);
            if (uFaultOn > 0.5) {
              float w = abs(sd);
              c = mix(c, vec3(0.1, 0.09, 0.08), 1.0 - smoothstep(0.6, 2.2, w));
              c = mix(c, vec3(0.32, 0.29, 0.26), (1.0 - smoothstep(2.2, 5.0, w)) * 0.4); // crushed gouge zone
              float r = length(p - uHypo);
              c = mix(c, vec3(1.0, 0.85, 0.3), 1.0 - smoothstep(4.0, 9.0, r)); // hypocentre
            }
            if (uWaveT >= 0.0) {
              float r = length(p - uHypo);
              float pw = exp(-pow((r - ${V_P.toFixed(1)} * uWaveT) / 14.0, 2.0));
              float sw = exp(-pow((r - ${V_S.toFixed(1)} * uWaveT) / 22.0, 2.0));
              float fade = uWaveAmp * exp(-uWaveT * 0.25);
              gGlow = (vec3(0.35, 0.65, 1.0) * pw * 0.8 + vec3(1.0, 0.45, 0.15) * sw * 1.4) * fade;
            }
            diffuseColor.rgb = c;
          }`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gGlow;')
    }
    return m
  }

  build(city) {
    this.city = city
    for (const c of [...this.group.children]) {
      this.group.remove(c)
      c.geometry?.dispose()
      c.material?.dispose?.()
    }
    this.uniforms.uDatum.value = city.bankZ[GRID >> 1]
    this.uniforms.uRiverX.value = city.riverCenter[GRID >> 1] * CELL - HALF
    const mat = this.makeMaterial()
    const ROWS = 24
    for (let s = 0; s < 4; s++) {
      const pos = []
      const index = []
      for (let t = 0; t <= GRID; t++) {
        const [vi, vj] = s === 0 ? [t, 0] : s === 1 ? [GRID, t] : s === 2 ? [GRID - t, GRID] : [0, GRID - t]
        const x = -HALF + vi * CELL
        const z = -HALF + vj * CELL
        const top = this.world.vertexHeight(vi, vj)
        for (let r = 0; r < ROWS; r++) {
          const y = r === 0 ? top : Math.min(top, top - 2 - (r - 1) * ((top - 2 - BOTTOM) / (ROWS - 2)))
          pos.push(x, r === ROWS - 1 ? BOTTOM : y, z)
        }
      }
      for (let t = 0; t < GRID; t++)
        for (let r = 0; r < ROWS - 1; r++) {
          const a = t * ROWS + r
          const b = a + ROWS
          index.push(a, a + 1, b, b, a + 1, b + 1)
        }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setIndex(index)
      g.computeVertexNormals()
      const wall = new THREE.Mesh(g, mat)
      wall.receiveShadow = true
      this.group.add(wall)
    }
    const bottom = new THREE.Mesh(new THREE.PlaneGeometry(GRID * CELL, GRID * CELL).rotateX(Math.PI / 2).translate(0, BOTTOM, 0), new THREE.MeshStandardMaterial({ color: 0x2e2b29, roughness: 1 }))
    this.group.add(bottom)
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true }))
    this.label.visible = false
    this.label.renderOrder = 20
    this.group.add(this.label)
  }

  /** Orient the fault and hypocentre toward the scenario's epicentre. */
  setQuake(q) {
    this.quake = q
    if (!q) {
      this.uniforms.uFaultOn.value = 0
      this.label.visible = false
      return
    }
    const dx = Math.cos(q.az)
    const dz = Math.sin(q.az)
    const k = HALF / Math.max(Math.abs(dx), Math.abs(dz))
    const hypo = new THREE.Vector3(dx * k * 0.98, BOTTOM + 60, dz * k * 0.98)
    this.uniforms.uHypo.value.copy(hypo)
    this.uniforms.uFaultP.value.copy(hypo)
    // a reverse fault dipping toward the epicentre
    this.uniforms.uFaultN.value.set(dx * Math.sin(DIP), Math.cos(DIP), dz * Math.sin(DIP)).normalize()
    this.uniforms.uSlipDir.value.set(-dx * Math.cos(DIP), Math.sin(DIP), -dz * Math.cos(DIP)).normalize()
    this.uniforms.uFaultOn.value = 1
    this.uniforms.uSlip.value = 0
    this.slipTarget = 0
    this.uniforms.uWaveT.value = -1
    this.waveT = -1
    // label
    const c = document.createElement('canvas')
    c.width = 512
    c.height = 128
    const g = c.getContext('2d')
    g.fillStyle = 'rgba(10,14,24,0.82)'
    g.beginPath()
    g.roundRect(4, 4, 504, 120, 18)
    g.fill()
    g.fillStyle = '#fcd34d'
    g.font = 'bold 34px system-ui, sans-serif'
    g.fillText(`★ Hypocentre — M${q.M.toFixed(1)}`, 22, 52)
    g.fillStyle = '#cbd5e1'
    g.font = '24px system-ui, sans-serif'
    g.fillText(`${q.dist} km away, ${q.depth} km deep (not to scale)`, 22, 96)
    this.label.material.map?.dispose()
    this.label.material.map = new THREE.CanvasTexture(c)
    this.label.material.map.colorSpace = THREE.SRGBColorSpace
    this.label.material.needsUpdate = true
    this.label.scale.set(120, 30, 1)
    this.label.position.set(hypo.x + dx * 70, hypo.y + 40, hypo.z + dz * 70)
    this.label.visible = true
  }

  /** A shock starts: waves leave the hypocentre, the fault slips. Returns seconds until S-waves reach the city. */
  trigger(M, main) {
    if (!this.uniforms.uFaultOn.value) return 0
    this.waveT = 0
    this.uniforms.uWaveAmp.value = Math.min(1.6, 0.35 + (M - 4) * 0.25)
    const slip = Math.max(0.5, Math.min(28, 2 + (M - 4) * 4))
    this.slipTarget = main ? slip : this.slipTarget + slip * 0.08
    const h = this.uniforms.uHypo.value
    return Math.hypot(h.x, h.y - this.uniforms.uDatum.value, h.z) / V_S
  }

  update(dt) {
    if (this.waveT >= 0) {
      this.waveT += dt
      if (this.waveT > 12) this.waveT = -1
    }
    this.uniforms.uWaveT.value = this.waveT
    const u = this.uniforms.uSlip
    // rupture: slip grows over a couple of seconds, then stays as permanent offset
    u.value += (this.slipTarget - u.value) * Math.min(1, dt * 1.2)
  }
}
