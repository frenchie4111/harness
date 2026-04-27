// POSIX single-quote escaping. Safe to splice into a shell command line
// because nothing inside single quotes is interpreted (no command
// substitution, no `$`, no backticks). Embedded single quotes are
// handled with the standard `'\''` close/escape/reopen trick.
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
