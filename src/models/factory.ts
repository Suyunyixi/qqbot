import { AsyncLocalStorage } from 'node:async_hooks';
import { isAIMessage } from '@langchain/core/messages';
import { ChatOpenAI, ChatOpenAICompletions } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { readConfig } from '../config/settings.js';

/** Build a fresh model so edited configuration takes effect on the next run. */
export function makeModel(): ChatOpenAI | ChatAnthropic {
  const config = readConfig();
  if (config.model.provider === 'anthropic') {
    class ContextBoundAnthropic extends ChatAnthropic {
      override get profile() { return { ...super.profile, maxInputTokens: config.model.contextTokens }; }
    }
    return new ContextBoundAnthropic({ model: config.model.name, apiKey: config.model.apiKey, maxTokens: 4096, maxRetries: 1, clientOptions: { baseURL: config.model.baseUrl, timeout: config.model.timeoutMs } });
  }

  // DeepSeek's OpenAI-compatible thinking mode requires the original
  // reasoning_content on *every* prior assistant turn when tools are present.
  // LangChain stores it in additional_kwargs but its completions serializer does
  // not yet replay it. Keep it scoped to this invocation, including concurrent
  // groups, and restore it in the request without putting it in user-visible text.
  const reasoning = new AsyncLocalStorage<Array<string | undefined>>();
  class ReasoningCompletions extends ChatOpenAICompletions {
    override _generate(...args: Parameters<ChatOpenAICompletions['_generate']>) {
      const prior = args[0].filter(isAIMessage).map((message) => typeof message.additional_kwargs.reasoning_content === 'string' ? message.additional_kwargs.reasoning_content : undefined);
      return reasoning.run(prior, () => super._generate(...args));
    }
  }
  class ContextBoundOpenAI extends ChatOpenAI {
    override get profile() { return { ...super.profile, maxInputTokens: config.model.contextTokens }; }
  }
  const providerFetch: typeof fetch = (input, init) => {
    const prior = reasoning.getStore();
    if (prior && typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { tools?: unknown[]; messages?: Array<{ role?: string; reasoning_content?: string }> };
      if (Array.isArray(body.tools) && Array.isArray(body.messages)) {
        let index = 0;
        for (const message of body.messages) if (message.role === 'assistant') {
          const content = prior[index++];
          if (content !== undefined) message.reasoning_content = content;
        }
        return globalThis.fetch(input, { ...init, body: JSON.stringify(body) });
      }
    }
    return globalThis.fetch(input, init);
  };
  const fields = { model: config.model.name, apiKey: config.model.apiKey, timeout: config.model.timeoutMs, maxRetries: 1, configuration: { baseURL: config.model.baseUrl, fetch: providerFetch } };
  return new ContextBoundOpenAI({ ...fields, completions: new ReasoningCompletions(fields) });
}
