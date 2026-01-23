import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { runTau } from "./app.js";

export default function tau(pi: ExtensionAPI) {
	// Initialize the Effect-based part of the extension
	// All services (Sandbox, Beads, Footer, etc.) are now managed by Effect
	runTau(pi);
}
