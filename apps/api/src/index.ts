import systemPrompt from "../../../prompts/system.md";
import soul from "../../../prompts/SOUL.md";
import { handleRequest } from "./app.ts";
import type { Env } from "./bindings.ts";

const prompt = `${systemPrompt.trim()}\n\n${soul.trim()}`;
export default {
  fetch(request: Request, env: Env) { return handleRequest(request, env, prompt); },
};
