// Untyped vendor (ADR-010). Minimal declarations for what we actually
// use; the shape is checked by runtime tests (guac-repo/guac-bridge)
// and e2e, not by types.
declare module 'guacamole-common-js' {
  export interface GuacStatus { code: number, message?: string }
  export interface Display {
    getElement: () => HTMLElement
    scale: (s: number) => void
    getWidth: () => number
    getHeight: () => number
    onresize: ((width: number, height: number) => void) | null
  }
  export class Client {
    constructor(tunnel: unknown)
    getDisplay(): Display
    connect(data?: string): void
    disconnect(): void
    sendMouseState(state: unknown): void
    sendKeyEvent(pressed: number, keysym: number): void
    sendSize(width: number, height: number): void
    onstatechange: ((state: number) => void) | null
    onerror: ((status: GuacStatus) => void) | null
  }
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- ambient mirror of a vendor class, not our design
  export class WebSocketTunnel { constructor(url: string) }
  // guacd protocol parser (used by the server-side net bridge, repositories/guac.ts):
  // stream → instructions. 1.5.0-ESM has no static toInstruction — we encode ourselves.
  export class Parser {
    oninstruction: ((opcode: string, params: string[]) => void) | null
    receive: (packet: string, isBuffer?: boolean) => void
  }
  export class Mouse {
    constructor(el: HTMLElement)
    onmousedown: ((s: unknown) => void) | null
    onmouseup: ((s: unknown) => void) | null
    onmousemove: ((s: unknown) => void) | null
  }
  export class Keyboard {
    constructor(el: HTMLElement | Document)
    onkeydown: ((keysym: number) => void) | null
    onkeyup: ((keysym: number) => void) | null
  }
  const Guacamole: {
    Client: typeof Client
    WebSocketTunnel: typeof WebSocketTunnel
    Mouse: typeof Mouse
    Keyboard: typeof Keyboard
    Parser: typeof Parser
  }
  export default Guacamole
}
