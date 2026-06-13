const OpenAI = require('openai');

class OpenAIProvider {
  constructor() {
    this.id = 'openai';
  }

  async generate(messages, model, apiKey) {
    return this.generateWithTools(messages, [], model, apiKey);
  }

  async generateWithTools(messages, tools, model, apiKey) {
    const client = new OpenAI({ apiKey });

    const openaiMessages = this._toOpenAIMessages(messages);
    const openaiTools = tools.length > 0 ? this._toOpenAITools(tools) : undefined;

    const params = {
      model,
      max_tokens: 4096,
      messages: openaiMessages,
    };
    if (openaiTools && openaiTools.length > 0) {
      params.tools = openaiTools;
    }

    const response = await client.chat.completions.create(params);
    const choice = response.choices[0];
    const message = choice.message;

    const text = message.content || '';
    const toolCalls = (message.tool_calls || [])
      .filter((tc) => tc.type === 'function')
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      }));

    return {
      type: toolCalls.length > 0 ? 'tool_use' : 'text',
      text,
      toolCalls,
      stopReason: this._mapFinishReason(choice.finish_reason),
    };
  }

  async stream(messages, model, apiKey, onChunk, tools) {
    const client = new OpenAI({ apiKey });

    const openaiMessages = this._toOpenAIMessages(messages);
    const openaiTools = tools && tools.length > 0 ? this._toOpenAITools(tools) : undefined;

    const params = {
      model,
      max_tokens: 4096,
      messages: openaiMessages,
      stream: true,
    };
    if (openaiTools && openaiTools.length > 0) {
      params.tools = openaiTools;
    }

    const stream = await client.chat.completions.create(params);

    let fullText = '';
    let finishReason = 'end_turn';
    const toolCallAccumulators = new Map();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        fullText += delta.content;
        onChunk({ type: 'delta', content: delta.content });
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallAccumulators.has(tc.index)) {
            toolCallAccumulators.set(tc.index, {
              id: tc.id || '',
              name: tc.function?.name || '',
              arguments: '',
            });
          }
          const acc = toolCallAccumulators.get(tc.index);
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }

      if (choice.finish_reason) {
        finishReason = this._mapFinishReason(choice.finish_reason);
      }
    }

    const toolCalls = [];
    for (const [, acc] of toolCallAccumulators) {
      toolCalls.push({
        id: acc.id,
        name: acc.name,
        input: JSON.parse(acc.arguments || '{}'),
      });
    }

    onChunk({ type: 'final', content: fullText });

    return {
      type: toolCalls.length > 0 ? 'tool_use' : 'text',
      text: fullText,
      toolCalls,
      stopReason: finishReason,
    };
  }

  _toOpenAIMessages(messages) {
    return messages.map((msg) => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content };
      }

      if (msg.role === 'user') {
        if (msg.images && msg.images.length > 0) {
          const content = msg.images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.data}` },
          }));
          content.push({ type: 'text', text: msg.content });
          return { role: 'user', content };
        }
        return { role: 'user', content: msg.content };
      }

      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.toolCallId || '',
          content: msg.content,
        };
      }

      // assistant
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          })),
        };
      }

      return { role: 'assistant', content: msg.content };
    });
  }

  _toOpenAITools(tools) {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  _mapFinishReason(reason) {
    if (!reason) return 'end_turn';
    switch (reason) {
      case 'stop': return 'end_turn';
      case 'tool_calls': return 'tool_use';
      case 'length': return 'max_tokens';
      case 'content_filter': return 'content_filter';
      default: return reason;
    }
  }
}

module.exports = { OpenAIProvider };
