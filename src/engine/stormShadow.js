// The "what if" runs behind the typhoon's after-action report, each in its
// own worker (stormWorker.js): the same storm on the city as it was
// generated, with no upgrades and the default plan ('none'), and, when the
// player both planned and built, the same with their plan and warning
// upgrades but none of the works ('plan'). They keep pace with the live run;
// report(t) resolves with each one's StormRun.summary() at time t.

export class ShadowRuns {
  /** jobs: { name: { city, level, opts } } */
  constructor(jobs) {
    this.runs = {}
    for (const [name, job] of Object.entries(jobs)) {
      const r = { t: 0, summary: null, failed: false, waiting: null }
      try {
        r.worker = new Worker(new URL('./stormWorker.js', import.meta.url), { type: 'module' })
        r.worker.onmessage = (e) => this.onMessage(r, e.data)
        r.worker.onerror = (e) => this.fail(r, e.message)
        r.worker.postMessage({ type: 'start', ...job })
      } catch (err) {
        this.fail(r, String(err))
      }
      this.runs[name] = r
    }
    this.lastSync = -1
  }

  onMessage(r, m) {
    if (m.type === 'progress') r.t = m.t
    else if (m.type === 'summary') {
      r.summary = m.summary
      r.waiting?.(m.summary)
    } else if (m.type === 'error') this.fail(r, m.message)
  }

  fail(r, message) {
    if (r.failed) return
    r.failed = true
    console.warn('Typhoon comparison run failed:', message)
    r.worker?.terminate()
    r.waiting?.(null)
  }

  /** The live run has reached t (s); the shadows may catch up to it. */
  sync(t) {
    if (t - this.lastSync < 60) return
    this.lastSync = t
    for (const r of Object.values(this.runs)) if (!r.failed) r.worker.postMessage({ type: 'until', t })
  }

  /** Share of the way to time t the slowest shadow run has got (0–1). */
  progress(t) {
    const live = Object.values(this.runs).filter((r) => !r.failed)
    if (!live.length || t <= 0) return 1
    return Math.min(...live.map((r) => (r.summary ? 1 : Math.min(1, r.t / t))))
  }

  /** Every shadow run's summary at time t: { name: summary | null (it failed) }. */
  report(t) {
    return Promise.all(
      Object.entries(this.runs).map(
        ([name, r]) =>
          new Promise((resolve) => {
            if (r.failed) return resolve([name, null])
            r.summary = null
            r.waiting = (s) => resolve([name, s])
            r.worker.postMessage({ type: 'report', t })
          }),
      ),
    ).then((pairs) => Object.fromEntries(pairs))
  }

  stop() {
    for (const r of Object.values(this.runs)) {
      r.worker?.terminate()
      r.waiting?.(null)
      r.waiting = null
    }
  }
}
