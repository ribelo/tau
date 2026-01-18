/**
 * TEST: Does ASRT work without HOME spoofing?
 * 
 * This script tests if we can use ASRT with symlinked ~/.claude
 * WITHOUT changing process.env.HOME.
 * 
 * If this works: we can simplify sandbox-bash.ts significantly
 * If this fails: we need the HOME spoofing workaround
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function main() {
  const home = os.homedir();
  const claudePath = path.join(home, ".claude");
  
  console.log("=== ASRT Symlink Test ===");
  console.log(`HOME: ${home}`);
  console.log(`~/.claude exists: ${fs.existsSync(claudePath)}`);
  
  if (fs.existsSync(claudePath)) {
    const isSymlink = fs.lstatSync(claudePath).isSymbolicLink();
    console.log(`~/.claude is symlink: ${isSymlink}`);
    if (isSymlink) {
      console.log(`~/.claude target: ${fs.realpathSync(claudePath)}`);
    }
  }
  
  // Try to load ASRT
  let mgr;
  try {
    const mod = await import("@anthropic-ai/sandbox-runtime");
    mgr = mod.SandboxManager;
    console.log("ASRT loaded successfully");
  } catch (err) {
    console.error("ASRT not available:", err);
    process.exit(1);
  }
  
  // Resolve workspace path
  const workspaceRoot = process.cwd();
  let realWorkspace = workspaceRoot;
  try {
    realWorkspace = fs.realpathSync(workspaceRoot);
  } catch {}
  
  console.log(`Workspace: ${workspaceRoot}`);
  console.log(`Resolved workspace: ${realWorkspace}`);
  
  // Build allowWrite with resolved paths
  const allowWrite = ["/tmp", realWorkspace];
  
  // If .claude is symlinked, resolve and add its target
  if (fs.existsSync(claudePath) && fs.lstatSync(claudePath).isSymbolicLink()) {
    const realClaude = fs.realpathSync(claudePath);
    allowWrite.push(realClaude);
    console.log(`Added resolved .claude target: ${realClaude}`);
  }
  
  console.log(`\nallowWrite: ${JSON.stringify(allowWrite)}`);
  console.log(`\nAttempting wrapWithSandbox WITHOUT changing HOME...`);
  
  try {
    const wrapped = await mgr.wrapWithSandbox("echo 'hello from sandbox'", "bash", {
      network: { allowedDomains: [], deniedDomains: ["*"] },
      filesystem: {
        denyRead: [],
        allowWrite,
        denyWrite: [],
        allowGitConfig: true,
      },
      mandatoryDenySearchDepth: 2,
    });
    
    console.log("\n✅ SUCCESS! ASRT wrapped command without HOME spoofing:");
    console.log(wrapped.slice(0, 200) + "...");
    
  } catch (err) {
    console.error("\n❌ FAILED! ASRT requires HOME spoofing:");
    console.error(err);
    process.exit(1);
  }
}

main();
