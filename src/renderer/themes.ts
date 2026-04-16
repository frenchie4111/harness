export interface ThemeOption {
  id: string
  label: string
  description: string
  swatches: string[]
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'dark',
    label: 'Dark',
    description: 'Neutral dark \u2014 the default Harness look.',
    swatches: ['#0a0a0a', '#262626', '#d4d4d4', '#22c55e']
  },
  {
    id: 'dracula',
    label: 'Dracula',
    description: 'The iconic purple-tinted dark theme.',
    swatches: ['#282a36', '#44475a', '#f8f8f2', '#bd93f9']
  },
  {
    id: 'nord',
    label: 'Nord',
    description: 'Arctic, north-bluish clean and elegant.',
    swatches: ['#2e3440', '#434c5e', '#d8dee9', '#88c0d0']
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    description: 'Retro groove warm earth tones.',
    swatches: ['#282828', '#3c3836', '#ebdbb2', '#fabd2f']
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    description: 'Inspired by the neon lights of downtown Tokyo.',
    swatches: ['#1a1b26', '#292e42', '#c0caf5', '#7aa2f7']
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Soothing pastel theme, mocha flavor.',
    swatches: ['#1e1e2e', '#313244', '#cdd6f4', '#cba6f7']
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    description: 'Atom\u2019s classic dark theme.',
    swatches: ['#282c34', '#3e4451', '#abb2bf', '#61afef']
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    description: 'Ethan Schoonover\u2019s classic low-contrast dark palette.',
    swatches: ['#002b36', '#073642', '#93a1a1', '#268bd2']
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    description: 'The light half of Solarized \u2014 easy on the eyes in daylight.',
    swatches: ['#fdf6e3', '#eee8d5', '#657b83', '#268bd2']
  }
]
