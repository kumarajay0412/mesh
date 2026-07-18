import type { Provider } from './types'
import { claudeProvider } from './claude'
import { codexProvider } from './codex'

const providers: Record<'claude' | 'codex', () => Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
}

export function getProvider(id: 'claude' | 'codex'): Provider {
  return providers[id]()
}
