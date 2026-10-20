import { useIsMobile } from './useIsMobile.js'
import { REPO_URL } from './links.js'

/** The GitHub mark (octocat silhouette). */
export function GitHubMark({ className = 'h-4 w-4' }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/** Small round link to the repository, for tight spots (phone top bars, mid-size screens). */
export function RepoIcon({ className = '' }) {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="View the source on GitHub"
      aria-label="View the source on GitHub"
      className={`panel pointer-events-auto grid place-items-center text-slate-400 transition hover:text-white ${className}`}
    >
      <GitHubMark />
    </a>
  )
}

/** The full card: who made it and where the code lives. Muted until hovered so it stays out of the way. */
function RepoCard({ className = '' }) {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`panel pointer-events-auto group flex items-center gap-2.5 px-3 py-2 opacity-75 transition hover:opacity-100 ${className}`}
    >
      <GitHubMark className="h-5 w-5 shrink-0 text-slate-300 group-hover:text-white" />
      <span className="leading-tight">
        <span className="block text-[10px] tracking-wide text-slate-400 uppercase">Open source · made by FrancisCodex</span>
        <span className="block text-[12px] font-semibold text-slate-200 group-hover:text-white">
          disaster-simulator <span className="text-slate-400 group-hover:text-sky-300">↗</span>
        </span>
      </span>
    </a>
  )
}

/**
 * Credit in the bottom-right corner on desktop. While preparing, the centred
 * tool bar reaches the corner on mid-size screens, so it shrinks to an icon
 * there. Phones put the icon in their top bar instead (see the mobile HUDs).
 */
export default function RepoCredit({ phase }) {
  const mobile = useIsMobile()
  if (mobile || phase === 'results') return null
  return (
    <div className="pointer-events-none absolute right-3 bottom-3">
      {phase === 'prepare' ? (
        <>
          <RepoCard className="hidden 2xl:flex" />
          <RepoIcon className="h-9 w-9 2xl:hidden" />
        </>
      ) : (
        <RepoCard />
      )}
    </div>
  )
}
