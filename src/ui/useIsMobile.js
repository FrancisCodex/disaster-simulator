import { useEffect, useState } from 'react'

// phones, and landscape phones whose height is the tight side
const MOBILE_QUERY = '(max-width: 767px), (max-height: 500px)'

/** True on small screens, where the HUD switches to its compact layout. */
export function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return mobile
}
