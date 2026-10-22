// The typhoon on a copy of the city, off the main thread, for the
// after-action report: the same StormRun the player watches, with nothing
// drawn. It keeps pace with the live run and never gets ahead of it, so that
// when the player ends the disaster the two can be compared at the same
// moment. Protocol:
//   → { type: 'start', city, level, opts }  build the run (opts as StormRun's, without fx)
//   → { type: 'until', t }                  the live run has reached t (s): catch up, no further
//   → { type: 'report', t }                 run to t and reply with the summary
//   ← { type: 'progress', t }               after each slice of work
//   ← { type: 'summary', summary }          StormRun.summary() at t
//   ← { type: 'error', message }

import { StormRun } from './stormRun.js'

let run = null
let limit = 0
let want = null // the time a report was asked for
let queued = false

function schedule() {
  if (queued) return
  queued = true
  setTimeout(work, 0)
}

function work() {
  queued = false
  if (!run) return
  try {
    const target = want ?? limit
    const t0 = performance.now()
    // slices of ~50 ms, so that messages get through
    while (run.time < target - 1e-3 && performance.now() - t0 < 50) {
      run.advance(Math.min(60, target - run.time), 1e9)
      // nobody reads the logs
      run.events.length = 0
      run.windDmg.events.length = 0
      run.impact.events.length = 0
      run.typhoon.events.length = 0
    }
    postMessage({ type: 'progress', t: run.time })
    if (want != null && run.time >= want - 1e-3) {
      postMessage({ type: 'summary', summary: run.summary() })
      want = null
    }
    if (run.time < (want ?? limit) - 1e-3) schedule()
  } catch (err) {
    run = null
    postMessage({ type: 'error', message: String(err?.stack || err) })
  }
}

self.onmessage = (e) => {
  const m = e.data
  try {
    if (m.type === 'start') {
      run = new StormRun(m.city, m.level, m.opts)
      limit = 0
      want = null
    } else if (m.type === 'until') {
      limit = Math.max(limit, m.t)
    } else if (m.type === 'report') {
      want = m.t
      limit = Math.max(limit, m.t)
    }
    schedule()
  } catch (err) {
    run = null
    postMessage({ type: 'error', message: String(err?.stack || err) })
  }
}
