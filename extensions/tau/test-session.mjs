import { AuthStorage } from './node_modules/@mariozechner/pi-coding-agent/dist/core/auth-storage.js';
import { ModelRegistry } from './node_modules/@mariozechner/pi-coding-agent/dist/core/model-registry.js';
import { SessionManager } from './node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js';
import { createAgentSession } from './node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.js';

const auth = new AuthStorage();
const reg = new ModelRegistry(auth);

// Test 1: create session WITHOUT model (what happens when resolveModelPattern returns undefined)
console.log('--- Test: session without explicit model ---');
try {
  const { session, modelFallbackMessage } = await createAgentSession({
    authStorage: auth,
    modelRegistry: reg,
    sessionManager: SessionManager.inMemory(process.cwd()),
    // no model - simulates resolveModelPattern returning undefined
  });
  console.log('Session created, model:', session.agent?.state?.model?.provider + '/' + session.agent?.state?.model?.id);
  console.log('modelFallbackMessage:', modelFallbackMessage);

  // Try prompting
  try {
    await session.prompt("hi");
  } catch(e) {
    console.log('prompt error:', e.message?.substring(0, 100));
  }
} catch(e) {
  console.log('createAgentSession error:', e.message?.substring(0, 100));
}

// Test 2: create session WITH explicit model  
console.log('\n--- Test: session with openai-codex/gpt-5.2 ---');
try {
  const model = reg.find('openai-codex', 'gpt-5.2');
  console.log('found model:', model?.provider + '/' + model?.id);
  const { session } = await createAgentSession({
    authStorage: auth,
    modelRegistry: reg,
    model,
    sessionManager: SessionManager.inMemory(process.cwd()),
  });
  console.log('Session created OK');
} catch(e) {
  console.log('error:', e.message?.substring(0, 100));
}
