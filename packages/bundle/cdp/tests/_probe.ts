import { CAPTCHA_SCAN_EXPRESSION } from '../src/captcha.ts'
const s = CAPTCHA_SCAN_EXPRESSION
const j = s.indexOf('const seenOverlay')
console.log(s.slice(j, j + 1800))
