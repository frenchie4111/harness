const COLORS = [
  'bg-teal-400/60',
  'bg-cyan-400/60',
  'bg-sky-400/60',
  'bg-blue-400/60',
  'bg-indigo-400/60',
  'bg-violet-400/60',
  'bg-purple-400/60',
  'bg-fuchsia-400/60',
  'bg-pink-400/60',
  'bg-slate-400/60'
]

const TEXT_COLORS = [
  'text-teal-400',
  'text-cyan-400',
  'text-sky-400',
  'text-blue-400',
  'text-indigo-400',
  'text-violet-400',
  'text-purple-400',
  'text-fuchsia-400',
  'text-pink-400',
  'text-slate-400'
]

function hashString(s: string): number {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function repoColor(repoName: string): string {
  return COLORS[hashString(repoName) % COLORS.length]
}

export function repoNameColor(repoName: string): string {
  return TEXT_COLORS[hashString(repoName) % TEXT_COLORS.length]
}

export function repoLetter(repoName: string): string {
  return (repoName[0] || '?').toUpperCase()
}

interface RepoIconProps {
  repoName: string
  /** Box is 1em × 1em and the letter is 60% of that, so callers control
   *  size via a font-size class (e.g. `text-sm`, `text-lg`). Without a
   *  class it inherits the surrounding text-size. */
  className?: string
}

export function RepoIcon({ repoName, className }: RepoIconProps): JSX.Element {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-sm text-white font-bold shrink-0 ${repoColor(repoName)} ${className ?? ''}`}
      style={{ width: '1em', height: '1em', lineHeight: 1 }}
      title={repoName}
    >
      <span style={{ fontSize: '0.6em', lineHeight: 1 }}>{repoLetter(repoName)}</span>
    </span>
  )
}
