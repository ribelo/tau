import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ServiceMap, Layer } from "effect";

export class PiAPI extends ServiceMap.Service<PiAPI, ExtensionAPI>()("PiAPI") {}

export const PiAPILive = (pi: ExtensionAPI) => Layer.succeed(PiAPI, pi);
