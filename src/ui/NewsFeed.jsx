import { clockAt } from './news.js'

const PaperIcon = ({ className = 'h-4 w-4' }) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 3h9v14H5a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1Z" />
    <path d="M13 7h3a1 1 0 0 1 1 1v7a2 2 0 0 1-2 2h-2" />
    <path d="M6 6.5h4M6 9.5h4M6 12.5h4" />
  </svg>
)

const BubbleIcon = ({ className = 'h-4 w-4' }) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 3.5c-3.9 0-7 2.6-7 5.9 0 1.7.9 3.3 2.300 4.300L4.500 17l3.300-1.600c.7.2 1.400.300 2.200.300 3.900 0 7-2.600 7-5.900S13.900 3.500 10 3.500Z" />
  </svg>
)

const SirenIcon = ({ className = 'h-4 w-4' }) => (
  <svg viewBox="0 0 20 20" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5.500 14v-3.500a4.500 4.500 0 0 1 9 0V14M3.500 16.500h13M4 14h12M10 2v1.500M3.500 5l1 1M16.500 5l-1 1" />
  </svg>
)

const EDGE = { bad: 'border-l-red-500', warn: 'border-l-amber-400', good: 'border-l-emerald-400', info: 'border-l-transparent' }
const HEAD = { bad: 'text-white', warn: 'text-white', good: 'text-emerald-200', info: 'text-slate-200' }

function Item({ it, startHour }) {
  const time = clockAt(startHour, it.t)
  if (it.kind === 'post')
    return (
      <li className="feed-item flex gap-2.5 border-l-2 border-l-transparent py-2 pr-2 pl-3">
        <BubbleIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        <div className="min-w-0">
          <div className="text-[11px] text-slate-500">
            {it.handle} · <span className="font-mono">{time}</span>
          </div>
          <div className="text-[13.5px] leading-snug text-slate-200 italic">“{it.text}”</div>
        </div>
      </li>
    )
  const bulletin = it.kind === 'bulletin'
  return (
    <li className={`feed-item flex gap-2.5 border-l-2 py-2 pr-2 pl-3 ${EDGE[it.level] ?? EDGE.info}`}>
      {bulletin ? <SirenIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-300/80" /> : <PaperIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />}
      <div className="min-w-0">
        <div className={`text-[11px] ${bulletin ? 'text-amber-200/70' : 'text-slate-500'}`}>
          {it.source} · <span className="font-mono">{time}</span>
        </div>
        <div className={`text-[14px] leading-snug font-bold ${HEAD[it.level] ?? HEAD.info}`}>{it.head}</div>
        {it.body && <div className="mt-0.5 text-[12.5px] leading-snug text-slate-400">{it.body}</div>}
      </div>
    </li>
  )
}

/** The feed, newest first. items: from buildFeed, oldest first. */
export function NewsFeed({ items, startHour, className = '' }) {
  if (!items.length) return <div className={`px-3 py-4 text-sm text-slate-500 ${className}`}>Nothing to report yet.</div>
  const shown = items.slice(-150).reverse()
  return (
    <ul className={`scroll-thin divide-y divide-slate-800/70 overflow-y-auto ${className}`}>
      {shown.map((it) => (
        <Item key={it.id} it={it} startHour={startHour} />
      ))}
    </ul>
  )
}

/**
 * The strip under the feed: the latest headline, as a TV channel would run
 * it. Red and "Breaking" for bad news, quieter otherwise. Clicking it opens
 * or folds the feed.
 */
export function Ticker({ items, startHour, open, onToggle }) {
  let last = null
  for (let i = items.length - 1; i >= 0 && !last; i--) if (items[i].kind !== 'post') last = items[i]
  const breaking = last?.level === 'bad'
  const tag = breaking ? 'Breaking' : last?.level === 'warn' ? 'Alert' : 'Latest'
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      title={open ? 'Fold the news feed' : 'Open the news feed'}
      className={`pointer-events-auto flex w-full items-stretch overflow-hidden rounded-xl text-left shadow-lg shadow-black/40 ring-1 transition ${breaking ? 'bg-slate-950/95 ring-red-500/80' : 'bg-slate-950/90 ring-slate-600/50'}`}
    >
      <span className={`flex shrink-0 items-center gap-1.5 px-3 text-[12px] font-black tracking-widest uppercase ${breaking ? 'bg-red-600 text-white' : last?.level === 'warn' ? 'bg-amber-500 text-slate-950' : 'bg-slate-700 text-slate-100'}`}>
        <span className={`h-2 w-2 rounded-full bg-current ${breaking ? 'animate-pulse' : ''}`} />
        {tag}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
        <span className="hidden shrink-0 text-[11px] font-bold tracking-wider text-slate-400 uppercase sm:inline">Metro Live</span>
        <span key={last?.id} className="fadein min-w-0 truncate text-[14px] font-semibold text-white">
          {last ? last.head : 'Standing by for the first reports'}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 border-l border-slate-700/70 px-3 font-mono text-[12px] text-slate-400">
        {last && <span>{clockAt(startHour, last.t)}</span>}
        <span className="text-slate-200">{items.length}</span>
        <span className={`text-xs transition-transform ${open ? '' : 'rotate-180'}`}>▾</span>
      </span>
    </button>
  )
}
