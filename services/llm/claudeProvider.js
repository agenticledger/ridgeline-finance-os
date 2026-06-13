const Anthropic = require('@anthropic-ai/sdk');

class ClaudeProvider {
  constructor() {
    this.id = 'anthropic';
  }

  async generate(messages, model, apiKey) {
    return this.generateWithTools(messages, [], model, apiKey);
  }

  async generateWithTools(messages, tools, model, apiKey) {
    const client = new Anthropic({ apiKey });

    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemText = systemMessages.map((m) => m.content).join('\n\n');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const anthropicMessages = this._toAnthropicMessages(nonSystemMessages);
    const anthropicTools = tools.length > 0 ? this._toAnthropicTools(tools) : undefined;

    const params = {
      model,
      max_tokens: 4096,
      messages: anthropicMessages,
    };

    if (systemText) {
      params.system = systemText;
    }
    if (anthropicTools && anthropicTools.length > 0) {
      params.tools = anthropicTools;
    }

    const response = await client.messages.create(params);

    const textBlocks = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text);

    const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');

    const toolCalls = toolUseBlocks.map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }));

    return {
      type: toolCalls.length > 0 ? 'tool_use' : 'text',
      text: textBlocks.join('\n'),
      toolCalls,
      stopReason: response.stop_reason || 'end_turn',
    };
  }

  async stream(messages, model, apiKey, onChunk, tools) {
    const client = new Anthropic({ apiKey });

    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemText = systemMessages.map((m) => m.content).join('\n\n');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const anthropicMessages = this._toAnthropicMessages(nonSystemMessages);
    const anthropicTools = tools && tools.length > 0 ? this._toAnthropicTools(tools) : undefined;

    const params = {
      model,
      max_tokens: 4096,
      messages: anthropicMessages,
      stream: true,
    };
    if (systemText) {
      params.system = systemText;
    }
    if (anthropicTools && anthropicTools.length > 0) {
      params.tools = anthropicTools;
    }

    let fullText = '';
    const toolCalls = [];
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';

    const stream = client.messages.stream(params);

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          currentToolId = block.id;
          currentToolName = block.name;
          currentToolInput = '';
          onChunk({ type: 'tool', content: JSON.stringify({ id: block.id, name: block.name }) });
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          fullText += delta.text;
          onChunk({ type: 'delta', content: delta.text });
        } else if (delta.type === 'input_json_delta') {
          currentToolInput += delta.partial_json || '';
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolId) {
          try {
            const input = currentToolInput ? JSON.parse(currentToolInput) : {};
            toolCalls.push({ id: currentToolId, name: currentToolName, input });
          } catch {
            toolCalls.push({ id: currentToolId, name: currentToolName, input: {} });
          }
          currentToolId = '';
          currentToolName = '';
          currentToolInput = '';
        }
      }
    }

    const finalMessage = await stream.finalMessage();

    onChunk({ type: 'final', content: fullText });

    return {
      type: toolCalls.length > 0 ? 'tool_use' : 'text',
      text: fullText,
      toolCalls,
      stopReason: finalMessage.stop_reason || 'end_turn',
    };
  }

  _toAnthropicMessages(messages) {
    const result = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (msg.images && msg.images.length > 0) {
          const content = [];
          for (const img of msg.images) {
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: img.mimeType, data: img.data },
            });
          }
          content.push({ type: 'text', text: msg.content });
          result.push({ role: 'user', content });
        } else {
          result.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const content = [];
          if (msg.content) {
            content.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            });
          }
          result.push({ role: 'assistant', content });
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }
      } else if (msg.role === 'tool') {
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId || '',
              content: msg.content,
            },
          ],
        });
      }
    }

    return result;
  }

  _toAnthropicTools(tools) {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
}

module.exports = { ClaudeProvider };
