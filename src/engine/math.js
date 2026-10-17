// Seeded randomness, value noise and a few statistics helpers.

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export class Rng {
  constructor(seed) {
    this.next = mulberry32(seed)
  }
  float(a = 0, b = 1) {
    return a + (b - a) * this.next()
  }
  int(a, b) {
    return Math.floor(this.float(a, b + 1))
  }
  chance(p) {
    return this.next() < p
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)]
  }
  weighted(obj) {
    let total = 0
    for (const k in obj) total += obj[k]
    let r = this.next() * total
    for (const k in obj) {
      r -= obj[k]
      if (r <= 0) return k
    }
    return Object.keys(obj)[0]
  }
  normal() {
    const u = 1 - this.next()
    const v = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  poisson(lambda) {
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()))
    const L = Math.exp(-lambda)
    let k = 0
    let p = 1
    do {
      k++
      p *= this.next()
    } while (p > L)
    return k - 1
  }
}

export function makeNoise2D(seed) {
  const rng = new Rng(seed)
  const perm = new Uint8Array(256)
  for (let i = 0; i < 256; i++) perm[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1))
    const t = perm[i]
    perm[i] = perm[j]
    perm[j] = t
  }
  const hash = (i, j) => perm[(perm[i & 255] + j) & 255] / 255
  function noise(x, y) {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const u = xf * xf * (3 - 2 * xf)
    const v = yf * yf * (3 - 2 * yf)
    const a = hash(xi, yi)
    const b = hash(xi + 1, yi)
    const c = hash(xi, yi + 1)
    const d = hash(xi + 1, yi + 1)
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1
  }
  function fbm(x, y, octaves = 4) {
    let sum = 0
    let amp = 0.5
    let freq = 1
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq, y * freq) * amp
      norm += amp
      amp *= 0.5
      freq *= 2
    }
    return sum / norm
  }
  return { noise, fbm }
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26).
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2)
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
export const lerp = (a, b, t) => a + (b - a) * t
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US')
}
export function fmtMoney(m) {
  if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(2)}B`
  if (Math.abs(m) >= 10) return `$${m.toFixed(0)}M`
  return `$${m.toFixed(2)}M`
}
