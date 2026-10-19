import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateOpenAI, mockStreamText } = vi.hoisted(() => ({
  mockCreateOpenAI: vi.fn(() => {
    const provider = (model: string) => ({ modelId: model, provider: 'openai-compatible' });
    // streamChat calls `this.client.chat(model)`, not the bare callable — the
    // bare call routes to OpenAIResponsesModelId/`/v1/responses`, which most
    // OpenAI-compatible gateways (Ollama, vLLM, LiteLLM, ...) never implement.
    // `.chat()` routes to OpenAIChatModelId/`/v1/chat/completions`, which they
    // all support. See openai-compatible.ts's streamChat for the full story.
    provider.chat = (model: string) => ({ modelId: model, provider: 'openai-compatible' });
    provider.textEmbeddingModel = (model: string) => ({ modelId: model, type: 'embedding' });
    return provider;
  }),
  mockStreamText: vi.fn(() => ({ textStream: 'mock-stream' })),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI,
}));

vi.mock('ai', () => ({
  streamText: mockStreamText,
}));

import { OpenAICompatibleProvider } from './openai-compatible';
import {
  DEFAULT_OPENAI_CHAT_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from '../types';

describe('OpenAICompatibleProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructor throws when baseUrl is missing', () => {
    expect(() => new OpenAICompatibleProvider({ provider: 'openai' })).toThrow(
      'OpenAI-compatible provider requires baseUrl',
    );
  });

  it('constructor uses default chat model and embedding model when not provided', () => {
    const provider = new OpenAICompatibleProvider({
      provider: 'openai',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(provider.chatModel).toBe(DEFAULT_OPENAI_CHAT_MODEL);
    expect(provider.embeddingModel).toBe(DEFAULT_OPENAI_EMBEDDING_MODEL);
    expect(provider.embeddingDimensions).toBe(3072);
  });

  it('constructor uses provided chat model and embedding model', () => {
    const provider = new OpenAICompatibleProvider({
      provider: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      chatModel: 'custom-chat-model',
      embeddingModel: 'custom-embedding-model',
      embeddingDimensions: 1536,
    });
    expect(provider.chatModel).toBe('custom-chat-model');
    expect(provider.embeddingModel).toBe('custom-embedding-model');
    expect(provider.embeddingDimensions).toBe(1536);
  });

  it('constructor creates OpenAI client with baseURL and apiKey', () => {
    new OpenAICompatibleProvider({
      provider: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'sk-test',
    });
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'sk-test',
    });
  });

  it('streamChat delegates to streamText with correct default model', () => {
    const provider = new OpenAICompatibleProvider({
      provider: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      chatModel: 'gpt-4o',
    });
    const messages = [{ role: 'user', content: 'hello' }] as any;
    provider.streamChat({ messages });
    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelId: 'gpt-4o', provider: 'openai-compatible' },
        messages,
        temperature: 0.7,
        maxOutputTokens: 4096,
      }),
    );
  });

  it('streamChat uses custom model when specified in options', () => {
    const provider = new OpenAICompatibleProvider({
      provider: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      chatModel: 'gpt-4o',
    });
    provider.streamChat({ messages: [] as any, model: 'gpt-4o-mini' });
    const call = mockStreamText.mock.calls[0][0];
    expect(call.model).toEqual({ modelId: 'gpt-4o-mini', provider: 'openai-compatible' });
  });

  it('streamChat passes system prompt, temperature, maxOutputTokens, and onFinish', () => {
    const provider = new OpenAICompatibleProvider({
      provider: 'openai',
      baseUrl: 'http://localhost:11434/v1',
    });
    const onFinish = vi.fn();
    provider.streamChat({
      messages: [] as any,
      system: 'You are helpful.',
      temperature: 0.2,
      maxOutputTokens: 1024,
      onFinish,
    });
    const call = mockStreamText.mock.calls[0][0];
    expect(call.system).toBe('You are helpful.');
    expect(call.temperature).toBe(0.2);
    expect(call.maxOutputTokens).toBe(1024);
    expect(call.onFinish).toBe(onFinish);
  });
});
