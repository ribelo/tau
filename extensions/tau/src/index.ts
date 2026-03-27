import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { runTau } from "./app.js";
import { validateAgentDefinitionsAtStartup } from "./agent/startup-validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, "..", "skills");

export default function tau(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => ({
		skillPaths: [skillsDir],
	}));

	runTau(pi);
	void validateAgentDefinitionsAtStartup(process.cwd());
}
