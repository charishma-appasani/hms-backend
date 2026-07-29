import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { Env } from '../config/env.schema';
import {
  SUMMARY_TOOL_NAME,
  VISIT_SUMMARY_SYSTEM_PROMPT,
  VISIT_SUMMARY_TOOL,
  visitSummarySchema,
} from './summary.schema';
import {
  CHART_ANSWER_SYSTEM_PROMPT,
  CHART_ANSWER_TOOL,
  CHART_ANSWER_TOOL_NAME,
  chartAnswerSchema,
} from './chart-query.schema';
import {
  PATIENT_SUMMARY_SYSTEM_PROMPT,
  PATIENT_SUMMARY_TOOL,
  PATIENT_SUMMARY_TOOL_NAME,
  patientSummarySchema,
} from './patient-summary.schema';
import type {
  AiChartAnswerResult,
  AiPatientSummaryResult,
  AiProvider,
  AiSummaryResult,
  PatientDossier,
  PatientVisitInput,
} from './ai.types';

/** Bounded output. See docs/architecture/ai-features.md — an unset maxTokens reserves the
 * model's full context against the quota and is the top cause of surprise throttling. */
const MAX_OUTPUT_TOKENS = 1024;

/**
 * Real inference via the Bedrock Converse API. Non-streaming on purpose: the summary is
 * generated as a background job at check-in, so time-to-first-token buys nothing.
 *
 * Output is forced into the summary schema via tool-use and then re-validated with zod — model
 * output is untrusted input, tool-use constrains it but does not guarantee it.
 */
@Injectable()
export class BedrockAiProvider implements AiProvider {
  private readonly logger = new Logger(BedrockAiProvider.name);
  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;
  private readonly chartModelId: string;

  constructor(config: ConfigService<Env, true>) {
    // Falls back to the app's region, but is separately configurable: Anthropic models are not
    // invocable from every region, so inference may need to run in ap-south-1 while the rest of
    // the stack stays in ap-south-2. Both are in India, so residency is preserved either way.
    const region =
      config.get('BEDROCK_REGION', { infer: true }) ??
      config.getOrThrow('AWS_REGION');
    this.client = new BedrockRuntimeClient({
      region,
      maxAttempts: 5,
      retryMode: 'adaptive',
    });
    // Required whenever AI_ENABLED=true (enforced in env.schema) — see the doc on why this is
    // deployment configuration rather than a constant.
    this.modelId = config.getOrThrow('AI_SUMMARY_MODEL_ID');
    // Ask-this-chart may use a different model; defaults to the summary model when unset.
    this.chartModelId =
      config.get('AI_CHART_MODEL_ID', { infer: true }) ?? this.modelId;
    this.logger.log(`Bedrock AI provider ready (region=${region})`);
  }

  async summariseVisit(dossier: PatientDossier): Promise<AiSummaryResult> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: VISIT_SUMMARY_SYSTEM_PROMPT }],
        messages: [
          {
            role: 'user',
            content: [
              {
                text: `Patient dossier:\n\n${JSON.stringify(dossier, null, 2)}`,
              },
            ],
          },
        ],
        inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 },
        toolConfig: {
          tools: [VISIT_SUMMARY_TOOL],
          // Force the tool — we want the structured shape, not a chat reply.
          toolChoice: { tool: { name: SUMMARY_TOOL_NAME } },
        },
      }),
    );

    const toolUse = response.output?.message?.content?.find(
      (block) => block.toolUse?.name === SUMMARY_TOOL_NAME,
    )?.toolUse;
    if (!toolUse) {
      throw new Error(
        `Model did not call ${SUMMARY_TOOL_NAME} (stopReason=${response.stopReason})`,
      );
    }

    const parsed = visitSummarySchema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new Error(
        `Model output failed schema validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }

    return {
      summary: parsed.data,
      usage: {
        modelId: this.modelId,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      },
    };
  }

  async answerChartQuestion(
    dossier: PatientDossier,
    question: string,
  ): Promise<AiChartAnswerResult> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.chartModelId,
        system: [{ text: CHART_ANSWER_SYSTEM_PROMPT }],
        messages: [
          {
            role: 'user',
            content: [
              {
                // Dossier first, question last — the question is what to act on.
                text: `Patient dossier:\n\n${JSON.stringify(dossier, null, 2)}\n\nQuestion: ${question}`,
              },
            ],
          },
        ],
        inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0 },
        toolConfig: {
          tools: [CHART_ANSWER_TOOL],
          toolChoice: { tool: { name: CHART_ANSWER_TOOL_NAME } },
        },
      }),
    );

    const toolUse = response.output?.message?.content?.find(
      (block) => block.toolUse?.name === CHART_ANSWER_TOOL_NAME,
    )?.toolUse;
    if (!toolUse) {
      throw new Error(
        `Model did not call ${CHART_ANSWER_TOOL_NAME} (stopReason=${response.stopReason})`,
      );
    }

    const parsed = chartAnswerSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new Error(
        `Model output failed schema validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }

    return {
      answer: parsed.data,
      usage: {
        modelId: this.chartModelId,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      },
    };
  }

  async summariseVisitForPatient(
    input: PatientVisitInput,
  ): Promise<AiPatientSummaryResult> {
    const response = await this.client.send(
      new ConverseCommand({
        // Reuses the summary model — this is a low-volume, per-completed-visit call.
        modelId: this.modelId,
        system: [{ text: PATIENT_SUMMARY_SYSTEM_PROMPT }],
        messages: [
          {
            role: 'user',
            content: [
              {
                text: `Doctor's visit record:\n\n${JSON.stringify(input, null, 2)}`,
              },
            ],
          },
        ],
        inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 },
        toolConfig: {
          tools: [PATIENT_SUMMARY_TOOL],
          toolChoice: { tool: { name: PATIENT_SUMMARY_TOOL_NAME } },
        },
      }),
    );

    const toolUse = response.output?.message?.content?.find(
      (block) => block.toolUse?.name === PATIENT_SUMMARY_TOOL_NAME,
    )?.toolUse;
    if (!toolUse) {
      throw new Error(
        `Model did not call ${PATIENT_SUMMARY_TOOL_NAME} (stopReason=${response.stopReason})`,
      );
    }

    const parsed = patientSummarySchema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new Error(
        `Model output failed schema validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }

    return {
      summary: parsed.data,
      usage: {
        modelId: this.modelId,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      },
    };
  }
}
