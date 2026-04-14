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
  size?: number
}

export function RepoIcon({ repoName, size = 16 }: RepoIconProps): JSX.Element {
  const fontSize = Math.round(size * 0.6)
  return (
    <span
      className={`inline-flex items-center justify-center rounded-sm text-white font-bold shrink-0 ${repoColor(repoName)}`}
      style={{ width: size, height: size, fontSize, lineHeight: 1 }}
      title={repoName}
    >
      {repoLetter(repoName)}
    </span>
  )
}
