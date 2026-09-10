import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "./config.js";

let client: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({ region: config.awsRegion });
  }
  return client;
}

export interface LLMDecisionCallResult {
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  guardrailIntervened: boolean;
  guardrailAction?: string;
}

export class GuardrailBlockedError extends Error {
  constructor(public readonly action: string) {
    super(`Bedrock Guardrail blocked this request/response (action: ${action})`);
    this.name = "GuardrailBlockedError";
  }
}

export async function callBedrockDecision(prompt: string): Promise<LLMDecisionCallResult> {
  const command = new ConverseCommand({
    modelId: config.bedrockModelId,
    messages: [{ role: "user", content: [{ text: prompt }] }],
    ...(config.bedrockGuardrailId && config.bedrockGuardrailVersion
      ? {
          guardrailConfig: {
            guardrailIdentifier: config.bedrockGuardrailId,
            guardrailVersion: config.bedrockGuardrailVersion,
            trace: "enabled",
          },
        }
      : {}),
  });

  const response: ConverseCommandOutput = await getClient().send(command);

  const guardrailTrace = (response as any).trace?.guardrail;
  const guardrailAction: string | undefined =
    guardrailTrace?.actionReason ??
    (response.stopReason === "guardrail_intervened" ? "guardrail_intervened" : undefined);

  if (response.stopReason === "guardrail_intervened") {
    throw new GuardrailBlockedError(guardrailAction ?? "unknown");
  }

  const textContent = response.output?.message?.content?.find((c) => "text" in c);
  const rawText = textContent && "text" in textContent ? textContent.text ?? "" : "";

  return {
    rawText,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
    totalTokens: response.usage?.totalTokens ?? 0,
    guardrailIntervened: false,
    guardrailAction,
  };
}
