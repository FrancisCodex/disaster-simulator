// The typhoon over the district: advances the storm along its track and keeps
// what the rest of the game needs at the current moment (wind, gusts,
// pressure, rain on the district and on the upstream catchment, the PAGASA
// signal in force) plus a log of what happens. Simulation time t = 0 is when
// the first rain bands or strong winds are due; τ (hours) is measured from
// the storm's closest approach.

import { buildStorm, structure, fieldAt, catchmentRain, forecastSummary, signalAt, SIGNALS, tenMinKmh, GUST_LAND, compassOf, pagasaCat } from './typhoonPhysics.js'

export class TyphoonSim {
  constructor(scenario, { place = 'the city' } = {}) {
    this.scenario = scenario
    this.place = place
    this.storm = buildStorm(scenario)
    this.fc = forecastSummary(this.storm)
    this.startH = this.fc.startH
    this.events = []
    this.time = 0
    this.peak = { wind: 0, gust: 0, kmh10: 0, pmin: 1100, signal: 0 }
    this.signal = 0
    this.catchT = -1e9
    this.catchRain = 0
    this.flags = {}
    this.update(0)
  }

  tau(t = this.time) {
    return this.startH + t / 3600
  }

  /** Rain on the district (mm/h) at simulation time t. */
  rainAt(t) {
    return fieldAt(this.storm, this.tau(t)).rain
  }

  /** Mean rain over the upstream catchment (mm/h); re-sampled every simulated minute. */
  catchmentAt(t) {
    if (Math.abs(t - this.catchT) >= 60) {
      this.catchT = t
      this.catchRain = catchmentRain(this.storm, this.tau(t))
    }
    return this.catchRain
  }

  log(text, level = 'info') {
    this.events.push({ t: this.time, text, level })
  }

  update(t) {
    this.time = t
    const s = this.storm
    const tau = this.tau(t)
    const st = structure(s, tau)
    const f = fieldAt(s, tau, 0, 0, st)
    const kmh10 = tenMinKmh(f.wind)
    const [cx, cy] = s.pos(tau)
    this.now = {
      tau,
      wind: f.wind,
      kmh10,
      gust: f.wind * GUST_LAND,
      dir: f.dir,
      from: compassOf(-f.dir[0], -f.dir[1]),
      p: f.p,
      rain: f.rain,
      dist: Math.hypot(cx, cy),
      bearing: compassOf(cx, cy),
      eye: f.eye,
      vmax: st.vmax,
      pc: s.pc(tau),
      category: pagasaCat(tenMinKmh(st.vmax)),
      overLand: s.overLand(tau),
    }
    const P = this.peak
    if (f.wind > P.wind) {
      P.wind = f.wind
      P.kmh10 = kmh10
      P.gust = f.wind * GUST_LAND
      P.from = this.now.from
    }
    P.pmin = Math.min(P.pmin, f.p)
    this.narrate(tau, kmh10, f)
    this.updateSignal(tau)
  }

  updateSignal(tau) {
    let sig = signalAt(this.fc.timeline, tau)
    // signals come down only once the storm has passed and the wind has dropped below them
    const cur = SIGNALS[this.signal - 1]
    if (sig < this.signal && (tau < 0 || this.now.eye || this.now.kmh10 >= cur.kmh)) sig = this.signal
    if (sig === this.signal) return
    const g = SIGNALS[sig - 1]
    if (sig > this.signal) this.log(`PAGASA raises Tropical Cyclone Wind Signal No. ${sig} over ${this.place}: ${g.name.toLowerCase()} (${g.kmh}+ km/h) expected within ${g.lead} hours. ${g.threat}.`, sig >= 3 ? 'bad' : 'warn')
    else if (sig > 0) this.log(`Wind signal lowered to No. ${sig}.`, 'info')
    else this.log('All tropical cyclone wind signals have been lifted.', 'good')
    this.signal = sig
    this.peak.signal = Math.max(this.peak.signal, sig)
  }

  /** One-off log lines as the storm arrives, peaks and leaves. */
  narrate(tau, kmh10, f) {
    const F = this.flags
    const s = this.storm
    const n = this.now
    if (!F.intro) {
      F.intro = true
      const ca = Math.round(-this.startH)
      this.log(`${this.scenario.title ?? 'A tropical cyclone'} is ${Math.round(n.dist)} km ${n.bearing} of ${this.place}, moving ${compassOf(s.u[0], s.u[1])} at ${Math.round(s.c)} km/h. Closest approach (${Math.round(s.dist)} km) in about ${ca} h. ${n.category.name}, ${Math.round(tenMinKmh(n.vmax))} km/h sustained near the centre, ${Math.round(n.pc)} hPa.`, 'warn')
    }
    if (s.landfall != null && !F.landfall && tau >= s.landfall) {
      F.landfall = true
      this.log(`Landfall ${Math.round(n.dist)} km ${n.bearing} of the city as a ${n.category.name.toLowerCase()}. Over land it starts to weaken.`, 'warn')
    }
    if (!F.gale && kmh10 >= 62) {
      F.gale = true
      this.log(`Gale-force winds reach the city: ${Math.round(kmh10)} km/h sustained from the ${n.from}, gusting ${Math.round(n.gust * 3.6)} km/h.`, 'warn')
    }
    if (!F.storm && kmh10 >= 89) {
      F.storm = true
      this.log(`Storm-force winds: ${Math.round(kmh10)} km/h sustained. Light roofs, signs and trees are at risk.`, 'bad')
    }
    if (!F.typhoon && kmh10 >= 118) {
      F.typhoon = true
      this.log(`Typhoon-force winds: ${Math.round(kmh10)} km/h sustained, gusts to ${Math.round(n.gust * 3.6)} km/h. Nobody should be outdoors.`, 'bad')
    }
    if (f.eye && !F.inEye) {
      F.inEye = true
      F.eyeFrom = n.from
      this.log(`The eye is passing over: the wind falls almost calm and the rain stops (${Math.round(f.p)} hPa). It isn't over — the back eyewall is coming, from the opposite direction.`, 'warn')
    } else if (!f.eye && F.inEye && !F.eyeOut) {
      F.eyeOut = true
      this.log(`The back of the eyewall arrives: winds slam back from the ${n.from}.`, 'bad')
    }
    if (!F.passed && tau > 0 && f.r > 3 * f.rmax && kmh10 < 39 && f.rain < 2) {
      F.passed = true
      this.log('The storm is moving away. The river can keep rising for hours as rain from upstream arrives.', 'info')
    }
  }
}
