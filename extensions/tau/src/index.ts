import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { runTau } from "./app.js";
import { validateAgentDefinitionsAtStartup } from "./agent/startup-validation.js";

export default function tau(pi: ExtensionAPI) {
	runTau(pi);
	void validateAgentDefinitionsAtStartup(process.cwd());
}
