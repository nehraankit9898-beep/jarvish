# -*- coding: utf-8 -*-
"""
AgentScope Bridge Runner — AgentScope Studio (Next.js UI) <-> AgentScope Python
--------------------------------------------------------------------------------
The Studio server spawns this script with a JSON payload on stdin:

{
  "prompt": "...",
  "agentName": "...",
  "systemPrompt": "...",
  "provider": "openai|deepseek|qwen|kimi|grok|ollama|custom|gemini|anthropic|zai",
  "apiKey": "...",            # optional for ollama/custom
  "model": "...",
  "baseUrl": "...",           # optional override (OpenAI-compatible)
  "temperature": 0.7
}

It maps the Studio connection onto REAL AgentScope classes:
  - OpenAI-compatible providers -> OpenAICredential + OpenAIChatModel
  - Gemini                      -> GeminiCredential + GeminiChatModel
  - Anthropic                   -> AnthropicCredential + AnthropicChatModel
creates an agentscope Agent, runs `await agent.reply(Msg(...))` and prints:

{"ok": true, "agent": "...", "text": "...", "usage": {...}}
{"ok": false, "error": "...", "installHint": "..."}

Run: python3 python-bridge/runner.py < payload.json
"""

import asyncio
import json
import sys
import traceback

INSTALL_HINT = (
    "AgentScope Python installed nahi hai. Isi repo ke 'agentscope' folder me: "
    "pip install -e ./agentscope  (ya pip install agentscope) — phir Studio restart karo."
)


def build_model(payload):
    """Map the Studio provider onto a real AgentScope ChatModel."""
    provider = (payload.get("provider") or "openai").lower()
    api_key = payload.get("apiKey") or ""
    model_name = payload.get("model") or ""
    base_url = payload.get("baseUrl") or None
    temperature = float(payload.get("temperature") or 0.7)

    # --- OpenAI-compatible family (real AgentScope classes) ---
    if provider in ("openai", "deepseek", "qwen", "kimi", "grok", "ollama", "custom", "zai"):
        from agentscope.credential import OpenAICredential
        from agentscope.model import OpenAIChatModel

        defaults = {
            "deepseek": "deepseek-chat",
            "qwen": "qwen-plus",
            "kimi": "moonshot-v1-8k",
            "grok": "grok-3",
            "ollama": "llama3.1",
            "openai": "gpt-4o-mini",
        }
        model_name = model_name or defaults.get(provider, "gpt-4o-mini")
        if provider in ("ollama", "custom") and not base_url:
            base_url = "http://localhost:11434/v1" if provider == "ollama" else None

        credential = OpenAICredential(
            api_key=api_key or "sk-local",
            **({"base_url": base_url} if base_url else {}),
        )
        model = OpenAIChatModel(
            credential=credential,
            model=model_name,
            stream=False,
            client_kwargs={"timeout": 120},
            extra_body={"temperature": temperature},
        )
        return model, model_name

    if provider == "gemini":
        from agentscope.credential import GeminiCredential
        from agentscope.model import GeminiChatModel

        # Retired models (Google shutdown) → current replacement.
        # gemini-2.0-flash ab 404 deta hai; official replacement gemini-3.8-flash.
        _RETIRED = {
            "gemini-2.0-flash": "gemini-3.8-flash",
            "gemini-2.0-flash-lite": "gemini-3.8-flash",
            "gemini-1.5-pro": "gemini-3.8-flash",
            "gemini-1.5-flash": "gemini-3.8-flash",
            "gemini-1.5-flash-latest": "gemini-3.8-flash",
            "gemini-1.5-pro-latest": "gemini-3.8-flash",
        }
        if not model_name or model_name in _RETIRED:
            model_name = _RETIRED.get(model_name, model_name) or "gemini-3.8-flash"
        credential = GeminiCredential(api_key=api_key)
        model = GeminiChatModel(credential=credential, model=model_name)
        return model, model_name

    if provider == "anthropic":
        from agentscope.credential import AnthropicCredential
        from agentscope.model import AnthropicChatModel

        model_name = model_name or "claude-sonnet-4-20250514"
        credential = AnthropicCredential(api_key=api_key)
        model = AnthropicChatModel(credential=credential, model=model_name)
        return model, model_name

    raise ValueError(f"Provider '{provider}' AgentScope me supported nahi hai")


async def run_agent(payload) -> dict:
    import agentscope
    from agentscope.agent import Agent
    from agentscope.message import Msg, TextBlock

    model, model_name = build_model(payload)

    agent = Agent(
        name=payload.get("agentName") or "StudioAgent",
        system_prompt=payload.get("systemPrompt") or "You are a helpful assistant.",
        model=model,
    )

    user_msg = Msg(
        name="user",
        role="user",
        content=[TextBlock(type="text", text=payload.get("prompt") or "Hello")],
    )

    reply: Msg = await agent.reply(user_msg)
    text = reply.get_text_content() or ""

    usage = {}
    try:
        if getattr(reply, "usage", None):
            usage = {
                "input_tokens": getattr(reply.usage, "input_tokens", None),
                "output_tokens": getattr(reply.usage, "output_tokens", None),
            }
    except Exception:
        pass

    return {
        "ok": True,
        "agentscopeVersion": getattr(agentscope, "__version__", "unknown"),
        "agent": payload.get("agentName") or "StudioAgent",
        "model": model_name,
        "text": text,
        "usage": usage,
    }


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw or "{}")
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"Bad JSON input: {exc}"}))
        return

    try:
        result = asyncio.run(run_agent(payload))
        print(json.dumps(result, ensure_ascii=False))
    except ImportError as exc:
        print(json.dumps({
            "ok": False,
            "error": f"Import failed: {exc}",
            "installHint": INSTALL_HINT,
        }, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc()[-1200:],
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
