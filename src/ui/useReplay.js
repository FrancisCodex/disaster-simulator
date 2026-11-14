import { useEffect, useMemo, useState } from 'react'
import { SPEEDS } from '../engine/config.js'
import { clockAt } from './news.js'

/**
 * Looking back along the recorded timeline. viewT is null while following the
 * simulation live. Scrubbing pauses the simulation; resuming it returns to
 * live. From a moment in the past the record can be played forward again, at
 * its own speed, until it catches up with the present. The readouts and the
 * news go back in time, and so does the picture of the city (Game.setReplay):
 * the flood water, the state of each building, and the weather.
 */
export function useReplay(s, game) {
  // look: the moment being looked at, and whether the pause that a seek asks for has been seen yet
  const [look, setLook] = useState(null)
  const viewT = look?.t ?? null
  const setViewT = (t) => setLook(t == null ? null : { t, held: false })
  const sim = s.sim
  const done = s.phase === 'results'
  // the clock is running again: follow it
  if (look && !done) {
    if (!look.held && sim.paused) setLook({ ...look, held: true })
    else if (look.held && !sim.paused) setLook(null)
  }
  const reviewing = viewT != null && viewT < sim.time
  const t = reviewing ? viewT : sim.time

  // playing the record forward: the simulation itself stays paused meanwhile
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(2)
  // caught up with the present (or left the replay): stop
  if (playing && !reviewing) setPlaying(false)
  if (look && !reviewing) setLook(null)
  // the 3D city follows: the water, the buildings and the weather of that moment
  useEffect(() => {
    game.setReplay(reviewing ? viewT : null)
  }, [game, reviewing, viewT])
  useEffect(() => () => game.setReplay(null), [game])

  const on = playing && reviewing
  useEffect(() => {
    if (!on) return
    let last = performance.now()
    const iv = setInterval(() => {
      const now = performance.now()
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      setLook((l) => l && { ...l, t: l.t + dt * SPEEDS[rate].mult })
    }, 50)
    return () => clearInterval(iv)
  }, [on, rate])

  const view = useMemo(() => {
    if (!reviewing) return s
    const tl = sim.timeline
    let f = tl[0]
    for (let lo = 0, hi = tl.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1
      if (tl[mid].time <= viewT) {
        f = tl[mid]
        lo = mid + 1
      } else hi = mid - 1
    }
    const hour = s.settings.startHour + viewT / 3600
    return {
      ...s,
      sim: {
        ...sim,
        ...f,
        time: viewT,
        elapsed: viewT,
        clock: `Day ${Math.floor(hour / 24) + 1}, ${clockAt(s.settings.startHour, viewT, false)}`,
        paused: sim.paused,
        speedIdx: sim.speedIdx,
        lens: sim.lens,
        log: sim.log.filter((e) => e.t <= viewT),
      },
    }
  }, [s, sim, reviewing, viewT])

  const seek = (to) => {
    if (!done && !sim.paused) game.togglePause()
    setViewT(to >= sim.time ? null : Math.max(0, to))
  }
  // the moments worth stopping at: bad news and warnings
  const marks = useMemo(() => sim.log.filter((e) => e.level === 'bad' || e.level === 'warn'), [sim.log])
  const step = (dir) => {
    if (dir < 0) {
      let to = 0
      for (const e of marks) if (e.t < t - 1) to = e.t
      seek(to)
    } else {
      const next = marks.find((e) => e.t > t + 1)
      seek(next ? next.t : sim.time)
    }
  }
  /** Play the record forward from a moment (default: from where it is being looked at). */
  const play = (from) => {
    if (from != null) seek(from)
    else if (!reviewing) return
    setPlaying(true)
  }
  return { view, t, reviewing, seek, step, live: () => setViewT(null), marks, playing: on, rate, setRate, play, pause: () => setPlaying(false) }
}
