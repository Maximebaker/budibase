import * as automationUtils from "../../automationUtils"
import type {
  AgentStepInputs,
  AgentStepOutputs,
  AgentDecisionLog,
  AutomationStepInputBase,
  ToolMetadata,
} from "@budibase/types"
import { ai } from "@budibase/pro"
import { helpers } from "@budibase/shared-core"
import sdk from "../../../sdk"
import {
  ToolLoopAgent,
  stepCountIs,
  readUIMessageStream,
  UIMessage,
  Output,
  jsonSchema,
} from "ai"
import { v4 } from "uuid"
import { isProdWorkspaceID } from "../../../db/utils"
import tracer from "dd-trace"
import env from "../../../environment"

const buildAgentDecisionLog = ({
  enabledTools,
  assistantMessage,
  modelId,
  modelName,
  baseUrl,
}: {
  enabledTools?: ToolMetadata[]
  assistantMessage?: UIMessage
  modelId?: string
  modelName?: string
  baseUrl?: string
}): AgentDecisionLog => {
  const toolCallCounts = new Map<string, number>()
  for (const part of assistantMessage?.parts || []) {
    const partType =
      part && typeof part === "object" && "type" in part ? part.type : undefined
    if (
      typeof partType === "string" &&
      (partType.startsWith("tool-") || partType === "dynamic-tool")
    ) {
      const toolName =
        "toolName" in part && typeof part.toolName === "string"
          ? part.toolName
          : undefined
      if (!toolName) {
        continue
      }
      toolCallCounts.set(toolName, (toolCallCounts.get(toolName) || 0) + 1)
    }
  }

  const usedTools = Array.from(toolCallCounts.entries()).map(
    ([name, count]) => ({
      name,
      count,
    })
  )

  return {
    enabledTools,
    usedTools: usedTools.length > 0 ? usedTools : undefined,
    model:
      modelId || modelName || baseUrl
        ? {
            id: modelId,
            name: modelName,
            baseUrl,
          }
        : undefined,
  }
}

export async function run({
  inputs,
  appId,
}: {
  inputs: AgentStepInputs
} & AutomationStepInputBase): Promise<AgentStepOutputs> {
  const { agentId, prompt, useStructuredOutput, outputSchema } = inputs
  let enabledTools: ToolMetadata[] | undefined
  let modelId: string | undefined
  let modelName: string | undefined
  let baseUrl: string | undefined

  if (!agentId) {
    return {
      success: false,
      response: "Agent step failed: No agent selected",
    }
  }

  if (!prompt) {
    return {
      success: false,
      response: "Agent step failed: No prompt provided",
    }
  }

  const sessionId = v4()

  return tracer.llmobs.trace(
    { kind: "agent", name: "automation.agent", sessionId },
    async agentSpan => {
      try {
        const agentConfig = await sdk.ai.agents.getOrThrow(agentId)
        const allTools = await sdk.ai.agents.getAvailableToolsMetadata(
          agentConfig.aiconfig
        )
        const enabledToolNames = new Set(agentConfig.enabledTools || [])
        enabledTools =
          enabledToolNames.size > 0
            ? allTools.filter(tool => enabledToolNames.has(tool.name))
            : allTools

        tracer.llmobs.annotate(agentSpan, {
          inputData: prompt,
          metadata: {
            agentId,
            agentName: agentConfig.name,
            appId,
            isForkedProcess: env.isInThread(),
            forkedProcessName: process.env.FORKED_PROCESS_NAME || "main",
          },
        })

        if (appId && isProdWorkspaceID(appId) && agentConfig.live !== true) {
          tracer.llmobs.annotate(agentSpan, {
            outputData: "Agent is paused",
            tags: { error: "agent_paused" },
          })
          return {
            success: false,
            response:
              "Agent is paused. Set it live to use it in published automations.",
          }
        }

        const { systemPrompt, tools } =
          await sdk.ai.agents.buildPromptAndTools(agentConfig)

        const modelConfig = await sdk.aiConfigs.getLiteLLMModelConfigOrThrow(
          agentConfig.aiconfig
        )
        modelId = modelConfig.modelId
        modelName = modelConfig.modelName
        baseUrl = modelConfig.baseUrl
        const { apiKey } = modelConfig

        tracer.llmobs.annotate(agentSpan, {
          metadata: {
            modelId,
            modelName,
            baseUrl,
            envLiteLLMUrl: env.LITELLM_URL,
            toolCount: Object.keys(tools).length,
          },
        })

        const litellm = ai.createLiteLLMOpenAI({
          apiKey,
          baseUrl,
          fetch: sdk.ai.agents.createLiteLLMFetch(sessionId),
        })

        let outputOption = undefined
        if (
          useStructuredOutput &&
          outputSchema &&
          Object.keys(outputSchema).length > 0
        ) {
          const normalizedSchema =
            helpers.structuredOutput.normalizeSchemaForStructuredOutput(
              outputSchema
            )
          outputOption = Output.object({ schema: jsonSchema(normalizedSchema) })
        }

        const agent = new ToolLoopAgent({
          model: litellm.chat(modelId),
          instructions: systemPrompt || undefined,
          tools,

          stopWhen: stepCountIs(30),
          providerOptions: {
            litellm: ai.getLiteLLMProviderOptions(modelName),
          },
          output: outputOption,
        })

        const streamResult = await agent.stream({ prompt })

        let assistantMessage: UIMessage | undefined
        for await (const uiMessage of readUIMessageStream({
          stream: streamResult.toUIMessageStream({ sendReasoning: true }),
        })) {
          assistantMessage = uiMessage
        }

        const responseText = await streamResult.text
        const usage = await streamResult.usage
        const output = outputOption
          ? ((await streamResult.output) as Record<string, any>)
          : undefined

        tracer.llmobs.annotate(agentSpan, {
          outputData: responseText,
          metadata: { stepCount: assistantMessage?.parts?.length ?? 0 },
        })

        return {
          success: true,
          response: responseText,
          usage,
          message: assistantMessage,
          output,
          agentTrace: buildAgentDecisionLog({
            enabledTools,
            assistantMessage,
            modelId,
            modelName,
            baseUrl,
          }),
        }
      } catch (err: any) {
        const errorMessage = automationUtils.getError(err)

        tracer.llmobs.annotate(agentSpan, {
          outputData: errorMessage,
          tags: {
            error: "1",
            "error.type": err?.name || "UnknownError",
          },
        })

        console.error("Agent step failed", {
          agentId,
          appId,
          liteLLMUrl: env.LITELLM_URL,
          errorName: err?.name,
          errorMessage,
        })

        return {
          success: false,
          response: errorMessage,
          agentTrace: buildAgentDecisionLog({
            enabledTools,
            modelId,
            modelName,
            baseUrl,
          }),
        }
      }
    }
  )
}
