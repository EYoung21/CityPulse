"""Amazon Bedrock (Claude via the Converse API) for Ask Pulse.

Ask Pulse speaks the OpenAI chat shape everywhere (DeepSeek / Lambda / OpenAI),
including its tool-calling loop. Bedrock's Converse API uses a different
request/response shape, so this module translates OpenAI messages + tools
<-> Converse and returns the OpenAI ``message`` dict the rest of Ask Pulse
already consumes (``{"role": "assistant", "content": str|None, "tool_calls": [...]}``).

Auth is SigV4 via the standard AWS env (``AWS_ACCESS_KEY_ID`` / ``_SECRET`` /
``AWS_REGION``); boto3 resolves it. Enabled when ``PREFER_BEDROCK`` is truthy
and AWS creds are present — see :func:`bedrock_configured`. We route Ask Pulse
(low-volume, user-facing, quality-sensitive) here to get a strong Claude model
and dodge the DeepSeek reasoning-model empty-content bug; ingest/extraction
stays on the local provider.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Optional

_TRUTHY = {"1", "true", "yes", "on"}
DEFAULT_BEDROCK_PULSE_MODEL = "us.anthropic.claude-sonnet-4-6"

_client = None


class BedrockRetryableError(Exception):
    """Bedrock failed in a way Ask Pulse should fall back from (throttle/5xx)."""


def _bedrock_runtime():
    global _client
    if _client is None:
        import boto3  # lazy: only imported when Bedrock is actually used

        _client = boto3.client(
            "bedrock-runtime",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
    return _client


def bedrock_configured() -> bool:
    if os.environ.get("PREFER_BEDROCK", "").strip().lower() not in _TRUTHY:
        return False
    return bool(
        os.environ.get("AWS_ACCESS_KEY_ID", "").strip()
        and os.environ.get("AWS_SECRET_ACCESS_KEY", "").strip()
    )


def bedrock_pulse_model() -> str:
    return os.environ.get("PULSE_CHAT_BEDROCK_MODEL", "").strip() or DEFAULT_BEDROCK_PULSE_MODEL


# ── OpenAI -> Converse ────────────────────────────────────────────────

def _messages_to_converse(messages: list[dict[str, Any]]) -> tuple[list[dict], list[dict]]:
    """Returns (system_blocks, converse_messages). System turns are pulled out
    (Converse takes them as a top-level param); user/assistant/tool turns are
    translated and consecutive same-role turns are merged (Converse requires
    strict user/assistant alternation)."""
    system_blocks: list[dict] = []
    out: list[dict] = []

    for m in messages:
        role = m.get("role")
        if role == "system":
            txt = str(m.get("content") or "")
            if txt:
                system_blocks.append({"text": txt})
            continue

        if role == "tool":
            block = {
                "toolResult": {
                    "toolUseId": m.get("tool_call_id") or m.get("name") or "",
                    "content": [{"text": str(m.get("content") or "")}],
                }
            }
            _append_merged(out, "user", block)
            continue

        # user / assistant
        blocks: list[dict] = []
        content = m.get("content")
        if isinstance(content, str) and content.strip():
            blocks.append({"text": content})
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function") or {}
            args = fn.get("arguments")
            try:
                parsed = json.loads(args) if isinstance(args, str) else (args or {})
            except (json.JSONDecodeError, TypeError):
                parsed = {}
            blocks.append(
                {"toolUse": {"toolUseId": tc.get("id") or "", "name": fn.get("name") or "", "input": parsed}}
            )
        if not blocks:
            blocks = [{"text": ""}]  # Converse rejects empty content
        cr = "assistant" if role == "assistant" else "user"
        for b in blocks:
            _append_merged(out, cr, b)

    return system_blocks, out


def _append_merged(out: list[dict], role: str, block: dict) -> None:
    if out and out[-1]["role"] == role:
        out[-1]["content"].append(block)
    else:
        out.append({"role": role, "content": [block]})


def _flatten_tool_blocks(conv: list[dict]) -> list[dict]:
    """Collapse toolUse/toolResult blocks into plain text and merge by role.

    Converse requires ``toolConfig`` whenever the history contains tool blocks
    and has no ``toolChoice: none``. Ask Pulse's force-text round wants a plain
    answer with no further tool calls, so we strip the tool blocks (keeping the
    tool *result* text — the incident data — in context) and send no toolConfig,
    which leaves the model only able to answer in text."""
    out: list[dict] = []
    for m in conv:
        role = m["role"]
        parts: list[str] = []
        for b in m["content"]:
            if b.get("text"):
                parts.append(b["text"])
            elif "toolUse" in b:
                parts.append(f"(requested {b['toolUse'].get('name', '')})")
            elif "toolResult" in b:
                tparts = [c.get("text", "") for c in b["toolResult"].get("content", []) if c.get("text")]
                parts.append("Tool data: " + " ".join(tparts))
        text = " ".join(p for p in parts if p) or "(no content)"
        if out and out[-1]["role"] == role:
            out[-1]["content"][0]["text"] += " " + text
        else:
            out.append({"role": role, "content": [{"text": text}]})
    return out


def _tools_to_converse(tools: Optional[list[dict]], tool_choice: Any) -> Optional[dict]:
    if not tools:
        return None
    specs = []
    for t in tools:
        fn = t.get("function") or t
        specs.append(
            {
                "toolSpec": {
                    "name": fn.get("name"),
                    "description": fn.get("description") or "",
                    "inputSchema": {"json": fn.get("parameters") or {"type": "object", "properties": {}}},
                }
            }
        )
    cfg: dict[str, Any] = {"tools": specs}
    if isinstance(tool_choice, dict):
        name = (tool_choice.get("function") or {}).get("name")
        cfg["toolChoice"] = {"tool": {"name": name}} if name else {"auto": {}}
    elif tool_choice == "required" or tool_choice == "any":
        cfg["toolChoice"] = {"any": {}}
    else:
        cfg["toolChoice"] = {"auto": {}}
    return cfg


# ── Converse -> OpenAI ────────────────────────────────────────────────

def _message_from_converse(resp: dict) -> dict[str, Any]:
    blocks = (resp.get("output") or {}).get("message", {}).get("content", []) or []
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    for b in blocks:
        if "text" in b:
            text_parts.append(b["text"])
        elif "toolUse" in b:
            tu = b["toolUse"]
            tool_calls.append(
                {
                    "id": tu.get("toolUseId") or "",
                    "type": "function",
                    "function": {"name": tu.get("name") or "", "arguments": json.dumps(tu.get("input") or {})},
                }
            )
    msg: dict[str, Any] = {"role": "assistant", "content": "".join(text_parts) or None}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return msg


async def bedrock_chat_message(
    messages: list[dict[str, Any]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.25,
    max_tokens: int = 1400,
    tools: Optional[list[dict[str, Any]]] = None,
    tool_choice: Any = "auto",
    timeout: float = 75.0,
) -> dict[str, Any]:
    """Run one Ask Pulse turn on Bedrock Claude; returns the OpenAI message dict."""
    system_blocks, conv = _messages_to_converse(messages)
    if tool_choice == "none":
        conv = _flatten_tool_blocks(conv)
        tool_cfg = None
    else:
        tool_cfg = _tools_to_converse(tools, tool_choice)
    kwargs: dict[str, Any] = {
        "modelId": model or bedrock_pulse_model(),
        "messages": conv,
        "inferenceConfig": {"maxTokens": int(max_tokens), "temperature": float(temperature)},
    }
    if system_blocks:
        kwargs["system"] = system_blocks
    if tool_cfg:
        kwargs["toolConfig"] = tool_cfg

    try:
        resp = await asyncio.to_thread(lambda: _bedrock_runtime().converse(**kwargs))
    except Exception as e:  # noqa: BLE001 — classify boto errors
        code = ""
        response = getattr(e, "response", None)
        if isinstance(response, dict):
            code = (response.get("Error") or {}).get("Code", "")
        if code in {
            "ThrottlingException",
            "ServiceUnavailableException",
            "ModelTimeoutException",
            "InternalServerException",
        }:
            raise BedrockRetryableError(f"{code}: {e}") from e
        raise
    return _message_from_converse(resp)
