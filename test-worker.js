import { AuthStorage } from "./extensions/tau/node_modules/@mariozechner/pi-coding-agent/dist/core/auth-storage.js";
import { ModelRegistry } from "./extensions/tau/node_modules/@mariozechner/pi-coding-agent/dist/core/model-registry.js";
import { getOAuthProvider } from "./extensions/tau/node_modules/@mariozechner/pi-ai/dist/index.js";

async function main() {
    const auth = new AuthStorage();
    const modelRegistry = new ModelRegistry(auth);
    
    console.log("has google-antigravity oauth?", !!getOAuthProvider("google-antigravity"));
    const key = await auth.getApiKey("google-antigravity");
    console.log("key from auth:", key ? "YES" : "NO");
    
    const models = modelRegistry.getAll();
    const model = models.find(m => m.provider === "google-antigravity");
    console.log("model exists:", !!model);
    
    if (model) {
        const keyFromRegistry = await modelRegistry.getApiKey(model);
        console.log("key from registry:", keyFromRegistry ? "YES" : "NO");
    }
}

main().catch(console.error);
