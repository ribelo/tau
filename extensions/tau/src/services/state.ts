import { Context, Layer, SubscriptionRef } from "effect";

import { SandboxConfigRequired } from "../schemas/config.js";
import { DEFAULT_SANDBOX_CONFIG } from "../sandbox/config.js";

export class SandboxState extends Context.Tag("SandboxState")<
	SandboxState,
	SubscriptionRef.SubscriptionRef<SandboxConfigRequired>
>() {}

export const SandboxStateLive = Layer.effect(
	SandboxState,
	SubscriptionRef.make(DEFAULT_SANDBOX_CONFIG),
);
