import { Effect } from "effect";
import { AgentWorker } from "./src/agent/worker.js";
import { initAgentRuntime } from "./src/agent/runtime.js";

async function main() {
    try {
        initAgentRuntime({});
        const workerEffect = AgentWorker.make({
            definition: {
                name: "test",
                description: "test",
                models: [
                    { model: "google-antigravity/gemini-3.1-pro-high" }
                ],
                sandbox: { filesystemMode: "workspace-write", networkMode: "allow-all", approvalPolicy: "never", approvalTimeoutSeconds: 60 },
                systemPrompt: "test"
            },
            depth: 1,
            cwd: process.cwd(),
            parentSessionId: "123",
            parentSandboxConfig: { filesystemMode: "workspace-write", networkMode: "allow-all", approvalPolicy: "never", approvalTimeoutSeconds: 60 },
            parentModel: undefined,
            approvalBroker: undefined,
        });
        
        const worker = await Effect.runPromise(workerEffect);
        console.log("Worker created successfully");
        
        await Effect.runPromise(worker.prompt("hello"));
        console.log("prompt finished");
        
        // Wait for worker to finish
        const sleep = () => new Promise(r => setTimeout(r, 1000));
        await sleep();
        await sleep();
        await sleep();
        
        const finalStatus = await Effect.runPromise(worker.status);
        console.log(finalStatus);
    } catch (e) {
        console.error("make error", e);
    }
}

main().catch(console.error);
