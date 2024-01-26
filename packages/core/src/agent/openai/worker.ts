// Assuming that the necessary interfaces and classes (like BaseTool, OpenAI, ChatMessage, CallbackManager, etc.) are defined elsewhere

import { randomUUID } from "crypto";
import { BaseTool } from "../../Tool";
import { CallbackManager } from "../../callbacks/CallbackManager";
import { AgentChatResponse, ChatResponseMode } from "../../engines/chat";
import {
  ChatMessage,
  ChatResponse,
  ChatResponseChunk,
  OpenAI,
} from "../../llm";
import { ChatMemoryBuffer } from "../../memory/ChatMemoryBuffer";
import { ObjectRetriever } from "../../objects/base";
import { ToolOutput } from "../../tools/types";
import { callToolWithErrorHandling } from "../../tools/utils";
import { AgentWorker, Task, TaskStep, TaskStepOutput } from "../types";
import { addUserStepToMemory, getFunctionByName } from "../utils";
import { OpenAIToolCall } from "./types/chat";
import { OpenAiFunction, toOpenAiTool } from "./utils";

const DEFAULT_MAX_FUNCTION_CALLS = 5;

/**
 * Call function.
 * @param tools: tools
 * @param toolCall: tool call
 * @param verbose: verbose
 * @returns: void
 */
async function callFunction(
  tools: BaseTool[],
  toolCall: OpenAIToolCall,
  verbose: boolean = false,
): Promise<[ChatMessage, ToolOutput]> {
  const id_ = toolCall.id;
  const functionCall = toolCall.function;
  const name = toolCall.function.name;
  const argumentsStr = toolCall.function.arguments;

  if (verbose) {
    console.log("=== Calling Function ===");
    console.log(`Calling function: ${name} with args: ${argumentsStr}`);
  }

  const tool = getFunctionByName(tools, name);
  const argumentDict = JSON.parse(argumentsStr);

  // Call tool
  // Use default error message
  const output = await callToolWithErrorHandling(tool, argumentDict, null);

  if (verbose) {
    console.log(`Got output ${output}`);
    console.log("==========================");
  }

  return [
    {
      content: String(output),
      role: "tool",
      additionalKwargs: {
        name,
        tool_call_id: id_,
      },
    },
    output,
  ];
}

type OpenAIAgentWorkerParams = {
  tools: BaseTool[];
  llm?: OpenAI;
  prefixMessages?: ChatMessage[];
  verbose?: boolean;
  maxFunctionCalls?: number;
  callbackManager?: CallbackManager | undefined;
  toolRetriever?: ObjectRetriever<BaseTool>;
};

/**
 * OpenAI agent worker.
 * This class is responsible for running the agent.
 */
export class OpenAIAgentWorker implements AgentWorker {
  private _llm: OpenAI;
  private _verbose: boolean;
  private _maxFunctionCalls: number;

  public prefixMessages: ChatMessage[];
  public callbackManager: CallbackManager | undefined;

  private _getTools: (input: string) => BaseTool[];

  /**
   * Initialize.
   */
  constructor({
    tools,
    llm,
    prefixMessages,
    verbose,
    maxFunctionCalls = DEFAULT_MAX_FUNCTION_CALLS,
    callbackManager,
    toolRetriever,
  }: OpenAIAgentWorkerParams) {
    this._llm = llm ?? new OpenAI({ model: "gpt-3.5-turbo-1106" });
    this._verbose = verbose || false;
    this._maxFunctionCalls = maxFunctionCalls;
    this.prefixMessages = prefixMessages || [];
    this.callbackManager = callbackManager || this._llm.callbackManager;

    if (tools.length > 0 && toolRetriever) {
      throw new Error("Cannot specify both tools and tool_retriever");
    } else if (tools.length > 0) {
      this._getTools = () => tools;
    } else if (toolRetriever) {
      // @ts-ignore
      this._getTools = (message: string) => toolRetriever.retrieve(message);
    } else {
      this._getTools = () => [];
    }
  }

  /**
   * Get all messages.
   * @param task: task
   * @returns: messages
   */
  public getAllMessages(task: Task): ChatMessage[] {
    return [
      ...this.prefixMessages,
      ...task.memory.get(),
      ...task.extraState.newMemory.get(),
    ];
  }

  /**
   * Get latest tool calls.
   * @param task: task
   * @returns: tool calls
   */
  public getLatestToolCalls(task: Task): OpenAIToolCall[] | null {
    const chatHistory: ChatMessage[] = task.extraState.newMemory.getAll();

    if (chatHistory.length === 0) {
      return null;
    }

    return chatHistory[chatHistory.length - 1].additionalKwargs?.toolCalls;
  }

  /**
   *
   * @param task
   * @param openaiTools
   * @param toolChoice
   * @returns
   */
  private _getLlmChatKwargs(
    task: Task,
    openaiTools: { [key: string]: any }[],
    toolChoice: string | { [key: string]: any } = "auto",
  ): { [key: string]: any } {
    const llmChatKwargs: { [key: string]: any } = {
      messages: this.getAllMessages(task),
    };

    if (openaiTools.length > 0) {
      llmChatKwargs.tools = openaiTools;
      llmChatKwargs.toolChoice = toolChoice;
    }

    return llmChatKwargs;
  }

  /**
   * Process message.
   * @param task: task
   * @param chatResponse: chat response
   * @returns: agent chat response
   */
  private _processMessage(
    task: Task,
    chatResponse: ChatResponse,
  ): AgentChatResponse | AsyncIterable<ChatResponseChunk> {
    const aiMessage = chatResponse.message;
    task.extraState.newMemory.put(aiMessage);
    return new AgentChatResponse(aiMessage.content, task.extraState.sources);
  }

  /**
   * Get agent response.
   * @param task: task
   * @param mode: mode
   * @param llmChatKwargs: llm chat kwargs
   * @returns: agent chat response
   */
  private async _getAgentResponse(
    task: Task,
    mode: ChatResponseMode,
    llmChatKwargs: any,
  ): Promise<AgentChatResponse> {
    if (mode === ChatResponseMode.WAIT) {
      const chatResponse = await this._llm.chat({
        stream: false,
        ...llmChatKwargs,
      });

      // @ts-ignore
      return this._processMessage(task, chatResponse);
    } else {
      throw new Error("Not implemented");
    }
  }

  /**
   * Call function.
   * @param tools: tools
   * @param toolCall: tool call
   * @param memory: memory
   * @param sources: sources
   * @returns: void
   */
  async callFunction(
    tools: BaseTool[],
    toolCall: OpenAIToolCall,
    memory: ChatMemoryBuffer,
    sources: ToolOutput[],
  ): Promise<void> {
    const functionCall = toolCall.function;

    if (!functionCall) {
      throw new Error("Invalid tool_call object");
    }

    const functionMessage = await callFunction(tools, toolCall, this._verbose);

    const message = functionMessage[0];
    const toolOutput = functionMessage[1];

    sources.push(toolOutput);
    memory.put(message);
  }

  /**
   * Initialize step.
   * @param task: task
   * @param kwargs: kwargs
   * @returns: task step
   */
  initializeStep(task: Task, kwargs?: any): TaskStep {
    const sources: ToolOutput[] = [];

    const newMemory = new ChatMemoryBuffer();

    const taskState = {
      sources,
      nFunctionCalls: 0,
      newMemory,
    };

    task.extraState = {
      ...task.extraState,
      ...taskState,
    };

    return new TaskStep(task.taskId, randomUUID(), task.input);
  }

  /**
   * Should continue.
   * @param toolCalls: tool calls
   * @param nFunctionCalls: number of function calls
   * @returns: boolean
   */
  private _shouldContinue(
    toolCalls: OpenAIToolCall[] | null,
    nFunctionCalls: number,
  ): boolean {
    if (nFunctionCalls > this._maxFunctionCalls) {
      return false;
    }

    if (!toolCalls || toolCalls.length === 0) {
      return false;
    }

    return true;
  }

  /**
   * Get tools.
   * @param input: input
   * @returns: tools
   */
  getTools(input: string): BaseTool[] {
    return this._getTools(input);
  }

  private async _runStep(
    step: TaskStep,
    task: Task,
    mode: ChatResponseMode = ChatResponseMode.WAIT,
    toolChoice: string | { [key: string]: any } = "auto",
  ): Promise<TaskStepOutput> {
    const tools = this.getTools(task.input);

    let openaiTools: OpenAiFunction[] = [];

    if (step.input) {
      addUserStepToMemory(step, task.extraState.newMemory, this._verbose);
    }

    if (step.input) {
      openaiTools = tools.map((tool) =>
        toOpenAiTool({
          name: tool.metadata.name,
          description: tool.metadata.description,
          parameters: tool.metadata.parameters,
        }),
      );
    }

    const llmChatKwargs = this._getLlmChatKwargs(task, openaiTools, toolChoice);

    const agentChatResponse = await this._getAgentResponse(
      task,
      mode,
      llmChatKwargs,
    );

    const latestToolCalls = this.getLatestToolCalls(task) || [];

    let isDone: boolean;
    let newSteps: TaskStep[] = [];

    if (
      !this._shouldContinue(latestToolCalls, task.extraState.nFunctionCalls)
    ) {
      isDone = true;
      newSteps = [];
    } else {
      isDone = false;
      for (const toolCall of latestToolCalls) {
        await this.callFunction(
          tools,
          toolCall,
          task.extraState.newMemory,
          task.extraState.sources,
        );
        task.extraState.nFunctionCalls += 1;
      }

      newSteps = [step.getNextStep(randomUUID(), undefined)];
    }

    return new TaskStepOutput(agentChatResponse, step, newSteps, isDone);
  }

  /**
   * Run step.
   * @param step: step
   * @param task: task
   * @param kwargs: kwargs
   * @returns: task step output
   */
  async runStep(
    step: TaskStep,
    task: Task,
    kwargs?: any,
  ): Promise<TaskStepOutput> {
    const toolChoice = kwargs?.toolChoice || "auto";
    return this._runStep(step, task, ChatResponseMode.WAIT, toolChoice);
  }

  /**
   * Stream step.
   * @param step: step
   * @param task: task
   * @param kwargs: kwargs
   * @returns: task step output
   */
  async streamStep(
    step: TaskStep,
    task: Task,
    kwargs?: any,
  ): Promise<TaskStepOutput> {
    const toolChoice = kwargs?.toolChoice || "auto";
    return this._runStep(step, task, ChatResponseMode.STREAM, toolChoice);
  }

  /**
   * Finalize task.
   * @param task: task
   * @param kwargs: kwargs
   * @returns: void
   */
  finalizeTask(task: Task, kwargs?: any): void {
    task.memory.set(task.memory.get().concat(task.extraState.newMemory.get()));
    task.extraState.newMemory.reset();
  }
}
