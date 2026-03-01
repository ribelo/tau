import { AuthStorage } from './node_modules/@mariozechner/pi-coding-agent/dist/core/auth-storage.js';
import { ModelRegistry } from './node_modules/@mariozechner/pi-coding-agent/dist/core/model-registry.js';

const auth = new AuthStorage();
const reg = new ModelRegistry(auth);

// Simulate exactly what the worker does
const models = [
  { model: "google-antigravity/gemini-3.1-pro-high", thinking: "high" },
  { model: "openai-codex/gpt-5.2", thinking: "high" },
];

for (const spec of models) {
  console.log(`\n--- Testing: ${spec.model} ---`);
  
  // resolveModelPattern equivalent
  const allModels = reg.getAll();
  const slashIndex = spec.model.indexOf("/");
  const provider = spec.model.slice(0, slashIndex).toLowerCase();
  const modelId = spec.model.slice(slashIndex + 1).toLowerCase();
  
  const match = allModels.find(
    m => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId
  );
  console.log('resolveModelPattern result:', match ? `${match.provider}/${match.id}` : 'NOT FOUND');
  
  if (match) {
    const apiKey = await reg.getApiKey(match);
    console.log('getApiKey result:', apiKey ? 'GOT KEY' : 'UNDEFINED');
    const isOAuth = reg.isUsingOAuth(match);
    console.log('isUsingOAuth:', isOAuth);
  } else {
    // What findInitialModel would do - just try getting API key for provider
    const apiKey = await auth.getApiKey(provider);
    console.log('direct auth.getApiKey for provider:', apiKey ? 'GOT KEY' : 'UNDEFINED');
  }
}
