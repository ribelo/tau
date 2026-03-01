import { AuthStorage } from "./extensions/tau/node_modules/@mariozechner/pi-coding-agent/dist/core/auth-storage.js";

async function main() {
    const auth = new AuthStorage();
    console.log("has auth?", auth.hasAuth("google-antigravity"));
    console.log("creds:", auth.get("google-antigravity"));
    const key = await auth.getApiKey("google-antigravity");
    console.log("key starts with:", key ? key.substring(0, 10) + "..." : undefined);
}

main().catch(console.error);
