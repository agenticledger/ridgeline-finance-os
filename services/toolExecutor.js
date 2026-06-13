const { getProviderForModel } = require('./llm');

const MAX_TOOL_OUTPUT_LENGTH = 20_000;
const MAX_TOOL_ITERATIONS = 10;

const handlers = new Map();

function registerToolHandler(prefix, handler) {
  handlers.set(prefix, handler);
}

async function executeToolCall(toolCall, context) {
  for (const [prefix, handler] of handlers.entries()) {
    if (toolCall.name.startsWith(prefix)) {
      try {
        let result = await handler(toolCall.name, toolCall.input, context);
        if (result.length > MAX_TOOL_OUTPUT_LENGTH) {
          result = result.substring(0, MAX_TOOL_OUTPUT_LENGTH) + '\n...[truncated]';
        }
        return result;
      } catch (err) {
        return `Error executing tool ${toolCall.name}: ${err.message || 'Unknown error'}`;
      }
    }
  }
  return `Tool not found: ${toolCall.name}`;
}

async function executeWithTools(params) {
  const { tools, model, apiKey, context } = params;
  const messages = [...params.messages];
  const provider = getProviderForModel(model);
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const result = tools.length > 0
      ? await provider.generateWithTools(messages, tools, model, apiKey)
      : await provider.generate(messages, model, apiKey);

    if (result.type !== 'tool_use' || result.toolCalls.length === 0) {
      return { result, messages };
    }

    messages.push({
      role: 'assistant',
      content: result.text || '',
      toolCalls: result.toolCalls,
    });

    for (const toolCall of result.toolCalls) {
      const toolResult = await executeToolCall(toolCall, context);
      messages.push({
        role: 'tool',
        content: toolResult,
        toolCallId: toolCall.id,
      });
    }
  }

  const finalResult = await provider.generate(messages, model, apiKey);
  return { result: finalResult, messages };
}

async function streamWithTools(params) {
  const { tools, model, apiKey, context, onChunk } = params;
  const messages = [...params.messages];
  const provider = getProviderForModel(model);
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const result = await provider.stream(messages, model, apiKey, onChunk, tools);

    if (result.type !== 'tool_use' || result.toolCalls.length === 0) {
      return { result, messages };
    }

    messages.push({
      role: 'assistant',
      content: result.text || '',
      toolCalls: result.toolCalls,
    });

    for (const toolCall of result.toolCalls) {
      const toolResult = await executeToolCall(toolCall, context);
      messages.push({
        role: 'tool',
        content: toolResult,
        toolCallId: toolCall.id,
      });
      onChunk({ type: 'tool', content: JSON.stringify({ id: toolCall.id, name: toolCall.name, result: toolResult.substring(0, 500) }) });
    }
  }

  const finalResult = await provider.stream(messages, model, apiKey, onChunk);
  return { result: finalResult, messages };
}

module.exports = { registerToolHandler, executeWithTools, streamWithTools };
