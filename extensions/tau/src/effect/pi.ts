import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Context, Layer } from "effect";

export class PiAPI extends Context.Tag("PiAPI")<PiAPI, ExtensionAPI>() {}

export const PiAPILive = (pi: ExtensionAPI) => Layer.succeed(PiAPI, pi);
