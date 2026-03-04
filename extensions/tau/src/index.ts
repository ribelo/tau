import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { runTau } from "./app.js";
import { validateAgentDefinitionsAtStartup } from "./agent/startup-validation.js";

export default function tau(pi: ExtensionAPI) {
	validateAgentDefinitionsAtStartup(process.cwd());
	runTau(pi);
}
