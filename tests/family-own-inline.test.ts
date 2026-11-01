/**
 * 家族节接管 own 卡内联直挂的源码结构钉（2026-11-02 own-tab 批量修复）。
 *
 * FamilySection 为 tab-switch 型（tablist + activeId + 单 tabpanel），与接管注册同在
 * client/index.ts；用源码结构钉把「own 卡作首 tab 内联直挂 + 账本去重」钉死，
 * 谁把「靠账本“含自己的”」（= 空白缺陷）接回来这里立刻红。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

describe('mcp-registry 家族接管 own 卡内联直挂（tab-switch）', () => {
  it('FamilySection 把 own 作首行内联、own id 已在账本则去重', () => {
    expect(SRC).toMatch(/contributors\.filter\(c => c\.id !== ownId\)/)
    expect(SRC).toMatch(/effective === ownId && renderOwn/)
  })

  it('接管 inject 面提供 ownId/ownLabel + renderOwn(SettingsCard, configScopeLive)', () => {
    expect(SRC).toMatch(/ownId: ID,/)
    expect(SRC).toMatch(/renderOwn: function \(\): any \{ return React\.createElement\(SettingsCard, \{ scope: configScopeLive\(ctx\) \}\)/)
  })
})
