const on = process.stdout.isTTY && !process.env.NO_COLOR
const ESC = '\u001b'
const wrap = (code: number) => (s: string) => (on ? `${ESC}[${code}m${s}${ESC}[0m` : s)
export const bold = wrap(1)
export const dim = wrap(2)
export const green = wrap(32)
export const yellow = wrap(33)
export const red = wrap(31)
