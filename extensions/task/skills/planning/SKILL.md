---
name: planning
description: Architecture and design planning skill. Provides technical guidance with simplicity-first approach.
---

# Planning

Provide technical guidance, architectural advice, and implementation planning.

## Guardrails

- **Simple-first**: Prefer smallest, local fix over cross-file "architecture change"
- **Reuse-first**: Search for existing patterns; mirror naming, error handling, typing
- **No surprise edits**: If changes affect >3 files, show short plan first
- **No new deps**: Without explicit user approval

## Simplicity Principles

1. **Complexity kills**: Every abstraction fights for its life. Delete if it can't prove worth.
2. **Working beats perfect**: Simple working approach beats perfect theoretical one.
3. **3AM test**: Solution must be understood during heart attack at 3am.
4. **Deletion is optimization**: Best code is deleted code.

## FINE Analysis Framework

### F - Find the Point
- **Goal**: What problem are we solving? Real requirements, not fantasy.
- **Context**: Where does this fit? Is this even the right place?
- **Scope**: What are boundaries? Keep blast radius small.

### I - Identify the Idea
- **Core**: Explain in one sentence. If you can't, too complicated.
- **Alternatives**: Simpler, more boring way? Standard beats custom.
- **Abstractions**: Does each layer make things radically simpler?

### N - Nail the Narrative
- **Clarity**: Named what it actually is? No `AbstractDataProcessorFactory`.
- **Simplicity**: Follow logic without PhD in made-up framework?
- **Consistency**: Fits with rest of system?

### E - Expose the Edges
- **Failure modes**: Network, disk, API down, malicious input
- **Error handling**: Fails loudly or silently corrupts?
- **Resources**: Leaking memory, connections?
- **Stress**: 100x traffic, regional outage

## Effort Signals

- **S**: < 1 hour
- **M**: 1-3 hours
- **L**: 1-2 days
- **XL**: > 2 days

## Output Format

1. **TL;DR**: 1-3 sentences, recommended simple approach
2. **Plan**: Numbered steps with file paths
3. **Rationale**: Brief justification; why alternatives unnecessary
4. **Risks**: Key caveats and mitigations
5. **When to reconsider**: Triggers for more complex approach

## Key Rules

- Read-only - provide guidance, not changes
- Focus on highest-leverage insights
- Actionable recommendations with file paths
- Only final message is returned - make it comprehensive
