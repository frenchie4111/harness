const COLORS = [
  'bg-red-600',
  'bg-orange-600',
  'bg-amber-600',
  'bg-yellow-600',
  'bg-lime-600',
  'bg-green-600',
  'bg-emerald-600',
  'bg-teal-600',
  'bg-cyan-600',
  'bg-sky-600',
  'bg-blue-600',
  'bg-indigo-600',
  'bg-violet-600',
  'bg-purple-600',
  'bg-fuchsia-600',
  'bg-pink-600',
  'bg-rose-600'
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
