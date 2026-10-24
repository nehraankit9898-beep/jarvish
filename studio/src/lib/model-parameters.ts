/** Shared request options for Chat Completions and connection probes. */
export function chatCompletionParameters(model: string, temperature: number, maxTokens?: number) {
  // Also works for gateways exposing OpenAI's namespaced model IDs. Do not
  // apply these restrictions to unrelated models (e.g. grok or DeepSeek).
  const id = model.replace(/^openai\//, '');
  const reasoning = /^(o[134](?:-|$)|gpt-5(?:[.-]|$))/i.test(id);
  return {
    ...(!reasoning ? { temperature } : {}),
    ...(maxTokens !== undefined
      ? reasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }
      : {}),
  };
}

/** Drop an orphan assistant prefix after truncating history. Keep systems. */
export function userFirstHistory<T extends { role: string }>(messages: T[]): T[] {
  const firstUser = messages.findIndex((message) => message.role === 'user');
  return messages.filter((message, index) => message.role === 'system' || (firstUser >= 0 && index >= firstUser));
}
