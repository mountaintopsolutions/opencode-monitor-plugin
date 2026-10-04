import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const distTui = join(root, 'dist', 'tui.js')

describe('tui build output', () => {
  it('builds a solid-compiled dist/tui.js entry', async () => {
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'build-tui.mjs')], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(distTui)).toBe(true)
    expect(existsSync(join(root, 'dist', 'tui.jsx'))).toBe(false)
    const code = readFileSync(distTui, 'utf8')
    // Strip comments before checking for leftover JSX (comments may mention <spinner> etc.)
    const codeNoComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(codeNoComments).not.toMatch(/<[A-Za-z][\w.-]*[\s/>]/)
    expect(code).not.toMatch(/from ['"]\.\/status-store\.ts['"]/)
    expect(code).toMatch(/solid-js/)
    expect(code).toMatch(/@opentui\/solid/)
    const mod = await import(`${pathToFileURL(distTui).href}?t=${Date.now()}`)
    expect(mod.default.id).toBe('opencode-monitor-indicator')
    expect(typeof mod.default.tui).toBe('function')
    expect(typeof mod.tui).toBe('function')
  })

  // v2's TUI context has no theme, so any colour the v2 half passes is
  // `undefined`. OpenTUI 0.5 throws on that while rendering the job rows and
  // the throw takes the whole TUI down: the screen blanks as soon as a job is
  // active. The v2 half must therefore emit no colour props at all.
  it('v2 setup renders without colour props', async () => {
    const code = readFileSync(distTui, 'utf8')
    const v2 = code.slice(code.indexOf('const v2Scope'))
    expect(v2.length).toBeGreaterThan(0)
    expect(v2).not.toMatch(/\bfg:\s*/)
    expect(v2).not.toMatch(/style:\s*\{\s*fg/)
    expect(v2).not.toMatch(/"spinner"/)
  })
})
