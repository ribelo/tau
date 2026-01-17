# sandbox (tau pi extension)

Sandboxing + approvals for model tool calls (work-in-progress).

Install globally by symlinking this directory into pi’s global extensions folder:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/extensions/sandbox" ~/.pi/agent/extensions/sandbox
```

Then enable it in your pi settings if needed (depends on your pi setup).

This repo MUST NOT contain a repo-local `.pi/extensions` directory.
