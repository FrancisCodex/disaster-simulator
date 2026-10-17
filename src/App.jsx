import { useEffect, useRef, useState } from 'react'
import { Game } from './engine/game.js'
import Menu from './ui/Menu.jsx'
import PrepareHUD from './ui/PrepareHUD.jsx'
import SimHUD from './ui/SimHUD.jsx'
import Results from './ui/Results.jsx'
import { Notice } from './ui/common.jsx'

export default function App() {
  const mountRef = useRef(null)
  const [game, setGame] = useState(null)
  const [snap, setSnap] = useState(null)

  useEffect(() => {
    const game = new Game(mountRef.current)
    setGame(game)
    if (import.meta.env.DEV) window.__metrorisk = game // handy for debugging in the console
    let queued = false
    const unsub = game.subscribe(() => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        setSnap(game.snapshot())
      })
    })
    setSnap(game.snapshot())
    // re-render periodically so notices can expire
    const iv = setInterval(() => setSnap(game.snapshot()), 1000)
    return () => {
      clearInterval(iv)
      unsub()
      game.destroy()
    }
  }, [])

  return (
    <div className="relative h-full w-full overflow-hidden select-none">
      <div ref={mountRef} className="absolute inset-0" />
      {snap && game && (
        <>
          {snap.phase === 'menu' && <Menu onStart={(settings) => game.newGame(settings)} />}
          {snap.phase === 'prepare' && <PrepareHUD s={snap} game={game} />}
          {(snap.phase === 'sim' || snap.phase === 'results') && <SimHUD s={snap} game={game} />}
          {snap.phase === 'results' && <Results key={snap.results.dead + snap.results.hours} s={snap} game={game} />}
          <Notice notice={snap.notice} />
        </>
      )}
    </div>
  )
}
