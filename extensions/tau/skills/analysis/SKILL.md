---
name: analysis
description: FINE framework for analyzing problems, designs, and decisions.
---

# Analysis (FINE)

Structured approach to analyze any problem.

## F - Find the Point

- **Goal**: What are we solving? Real requirements, not fantasy.
- **Context**: Where does this fit? Right place to solve it?
- **Scope**: What are boundaries? Keep blast radius small.

If goal isn't clear in one sentence, already a clusterfuck.

## I - Identify the Idea

- **Core**: Explain in one sentence. If you can't, too complicated.
- **Alternatives**: Simpler, more boring way? Standard beats custom.
- **Abstractions**: Each layer fights for its life. Radically simpler?

## N - Nail the Narrative

Can sleep-deprived human understand at 3AM during outage?

- **Clarity**: Named what it is? No `AbstractDataProcessorFactory`.
- **Simplicity**: Follow without PhD in made-up framework?
- **Consistency**: Fits with rest of system or special snowflake?

## E - Expose the Edges

Find how this breaks in real world:

- **Failure modes**: Network, disk full, API down, malicious input
- **Error handling**: Fails loudly or silently corrupts?
- **Resources**: Leaking memory, connections, handles?
- **Stress**: 100x traffic, regional outage, deprecated dependency

## Output Formats

**Reviews:**
1. CRITICAL FLAWS - Must fix now
2. SIMPLIFICATION - Boring alternative exists
3. NEXT STEPS - How to unfuck it

**Design Questions:**
1. THE REAL PROBLEM - What you're actually solving
2. THE SIMPLE WAY - Without complexity
3. THE TRAPS - Common fuckups

**General:**
1. STRAIGHT ANSWER - No fluff
2. WHY IT MATTERS - Real consequences
3. WATCH OUT FOR - Hidden gotchas
