// xterm.js arrives from a CDN script tag, so the browser has Terminal as a
// global rather than something the client imports. Only the parts the bozo
// mirror actually uses are declared.
declare class Terminal {
  constructor(options?: {
    cursorBlink?: boolean
    disableStdin?: boolean
    fontFamily?: string
    fontSize?: number
    scrollback?: number
    theme?: Record<string, string>
  })
  open(parent: HTMLElement): void
  resize(cols: number, rows: number): void
  write(data: string | Uint8Array): void
  reset(): void
}
