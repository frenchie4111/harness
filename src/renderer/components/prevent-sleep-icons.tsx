import { Zap, Infinity as InfinityIcon, Timer } from 'lucide-react'
import type { PreventSleepIcon } from '../prevent-sleep'

/** Maps a prevent-sleep icon key to its lucide glyph. Shared by the
 *  upper-right status icon and the cycle toast so they always agree. */
export function PreventSleepGlyph({
  icon,
  className
}: {
  icon: PreventSleepIcon
  className?: string
}): JSX.Element {
  switch (icon) {
    case 'agents':
      return <Zap className={className} />
    case 'always':
      return <InfinityIcon className={className} />
    case 'temporary':
      return <Timer className={className} />
  }
}
