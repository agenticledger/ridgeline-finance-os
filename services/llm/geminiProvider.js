const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

class GeminiProvider {
  constructor() {
    this.id = 'google';
  }

  async generate(messages, model, apiKey) {
    return this.generateWithTools(messages, [], model, apiKey);
  }

  async generateWithTools(messages, tools, model, apiKey) {
    const genAI = new GoogleGenerativeAI(apiKey);

    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemText = systemMessages.map((m) => m.content).join('\n\n');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const modelOptions = { model };
    if (systemText) {
      modelOptions.systemInstruction = systemText;
    }

    const genModel = genAI.getGenerativeModel(modelOptions);

    const contents = this._toGeminiContents(nonSystemMessages);
    const geminiTools = tools.length > 0 ? this._toGeminiTools(tools) : undefined;

    const requestParams = { contents };
    if (geminiTools) {
      requestParams.tools = geminiTools;
    }

    const result = await genModel.generateContent(requestParams);
    const response = result.response;

    return this._parseResponse(response);
  }

  async stream(messages, model, apiKey, onChunk, tools) {
    const genAI = new GoogleGenerativeAI(apiKey);

    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemText = systemMessages.map((m) => m.content).join('\n\n');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const modelOptions = { model };
    if (systemText) {
      modelOptions.systemInstruction = systemText;
    }

    const genModel = genAI.getGenerativeModel(modelOptions);

    const contents = this._toGeminiContents(nonSystemMessages);
    const geminiTools = tools && tools.length > 0 ? this._toGeminiTools(tools) : undefined;

    const requestParams = { contents };
    if (geminiTools) {
      requestParams.tools = geminiTools;
    }

    const result = await genModel.generateContentStream(requestParams);

    let fullText = '';

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullText += text;
        onChunk({ type: 'delta', content: text });
      }
    }

    onChunk({ type: 'final', content: fullText });

    const response = await result.response;
    const finishReason = response.candidates?.[0]?.finishReason || 'STOP';

    return {
      type: 'text',
      text: fullText,
      toolCalls: [],
      stopReason: this._mapStopReason(finishReason),
    };
  }

  _parseResponse(response) {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const textParts = [];
    const toolCalls = [];

    for (const part of parts) {
      if (part.text) {
        textParts.push(part.text);
      }
      if (part.functionCall) {
        const fc = part.functionCall;
        toolCalls.push({
          id: crypto.randomUUID(),
          name: fc.name,
          input: fc.args || {},
        });
      }
    }

    const finishReason = candidate?.finishReason || 'STOP';

    return {
      type: toolCalls.length > 0 ? 'tool_use' : 'text',
      text: textParts.join('\n'),
      toolCalls,
      stopReason: this._mapStopReason(finishReason),
    };
  }

  _mapStopReason(reason) {
    switch (reason) {
      case 'STOP': return 'end_turn';
      case 'MAX_TOKENS': return 'max_tokens';
      case 'SAFETY': return 'safety';
      case 'RECITATION': return 'recitation';
      default: return reason.toLowerCase();
    }
  }

  _toGeminiContents(messages) {
    const result = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        const parts = [];
        if (msg.images && msg.images.length > 0) {
          for (const img of msg.images) {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
          }
        }
        parts.push({ text: msg.content });
        result.push({ role: 'user', parts });
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const parts = [];
          if (msg.content) {
            parts.push({ text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.input,
              },
            });
          }
          result.push({ role: 'model', parts });
        } else {
          result.push({
            role: 'model',
            parts: [{ text: msg.content }],
          });
        }
      } else if (msg.role === 'tool') {
        result.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.toolCallId || 'unknown',
                response: { result: msg.content },
              },
            },
          ],
        });
      }
    }

    return result;
  }

  _toGeminiTools(tools) {
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      },
    ];
  }
}

module.exports = { GeminiProvider };
