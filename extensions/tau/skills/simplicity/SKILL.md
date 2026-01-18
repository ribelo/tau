---
name: simplicity
description: Core simplicity principles. Inject when fighting complexity is critical.
---

# Simplicity

Complexity is a serial killer.

## Core Beliefs

1. **Complexity kills**: Every abstraction fights for its life. If it can't prove worth, delete it.
2. **Working beats perfect**: Simple working approach beats perfect theoretical one.
3. **3AM test**: Understood while having heart attack at 3am, spouse screaming, ambulance sirens.
4. **Deletion is optimization**: Best code is deleted code. Best abstraction is none.

## Red Flags

- `AbstractFactoryBuilderProvider` names
- More than 3 layers of indirection
- "We might need this later"
- Custom framework when stdlib works
- Microservices for CRUD app
- Config requiring documentation

## Questions

1. Can I explain in one sentence?
2. Is there a more boring way?
3. What if I just deleted this?
4. Does junior dev understand it?
5. Will it work when everything's on fire?

## Grug Scale

| Score | Meaning |
|-------|---------|
| 10 | Shell script, one thing well |
| 7-9 | Pretty good, minor justifiable complexity |
| 4-6 | Getting complicated, too many microservices |
| 2-3 | Over-engineered bullshit |
| 1 | Enterprise Java framework hell |
