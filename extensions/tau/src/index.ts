import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { startTau } from "./app.js";
import { validateAgentDefinitionsAtStartup } from "./agent/startup-validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, "..", "skills");

export default async function tau(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => ({
		skillPaths: [skillsDir],
	}));

	const { ready } = startTau(pi);
	await ready;
	void validateAgentDefinitionsAtStartup(process.cwd());
}
