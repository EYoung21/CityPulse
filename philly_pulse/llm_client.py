"""Provider-agnostic OpenAI-compatible chat-completion client.

This is the *only* place in the codebase that should construct the
HTTP request to a chat-completion API. Everything else — incident
extraction (``llm.py``), AI plausibility check (``verifier.py``),
auto-verify second opinion (``auto_verify.py``), and the
``/api/summary`` endpoint — calls :func:`chat_completion` here.

Ask Pulse (``/api/pulse-chat``) uses :func:`pulse_chat_completion` instead:
same primary stack as below, with an optional ``DEEPSEEK_API_KEY`` fallback
when Lambda returns 5xx / 429 / transport errors (ingest is unchanged).

Provider resolution (highest priority first, evaluated at call time
so env edits don't require a process restart):

    1. ``LLM_BASE_URL`` + ``LLM_API_KEY`` + ``LLM_MODEL`` (explicit override)
    2. Lambda Inference API — when ``LAMBDA_API_KEY`` is set
       - base URL: ``LAMBDA_BASE_URL`` env or ``https://api.lambda.ai/v1``
       - model:    ``LAMBDA_MODEL`` env or ``llama3.3-70b-instruct-fp8``
    3. OpenAI — when ``OPENAI_API_KEY`` is set
       - base URL: ``OPENAI_BASE_URL`` env or ``https://api.openai.com/v1``
       - model:    ``OPENAI_MODEL`` env or ``gpt-4o-mini``

If none of the above is configured, :func:`chat_completion` raises
:class:`LLMConfigError`. The wrapper at each call site then translates
that into its own domain-specific error (e.g. ``LLMError`` in ``llm.py``).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


# Defaults that callers can override via env vars. Kept as module-level
# constants so they're discoverable in one place.
DEFAULT_LAMBDA_BASE_URL = "https://api.lambda.ai/v1"
DEFAULT_LAMBDA_MODEL = "llama3.3-70b-instruct-fp8"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
DEFAULT_DEEPSEEK_MODEL = "deepseek-chat"


class LLMConfigError(RuntimeError):
    """Raised when no LLM provider is configured."""


class LLMHTTPError(RuntimeError):
    """Raised when the upstream chat-completion call returns non-200."""

    def __init__(self, status_code: int, body: str, *, provider: str):
        super().__init__(f"{provider} returned {status_code}: {body}")
        self.status_code = status_code
        self.body = body
        self.provider = provider


@dataclass(frozen=True)
class ProviderConfig:
    """Resolved (provider, base_url, api_key, default_model) tuple."""

    name: str
    base_url: str  # Always ends without trailing slash.
    api_key: str
    default_model: str

    @property
    def chat_completions_url(self) -> str:
        return f"{self.base_url.rstrip('/')}/chat/completions"


def _resolve_provider() -> Optional[ProviderConfig]:
    """Resolve the active provider from environment variables.

    Returns ``None`` if nothing is configured. The caller decides
    whether that's fatal (most callers raise) or fall-throughable
    (e.g. ``/api/summary`` degrades to a static summary).
    """

    # 1. Explicit override — useful for self-hosted vLLM / TGI / Ollama.
    explicit_key = os.environ.get("LLM_API_KEY", "").strip()
    explicit_url = os.environ.get("LLM_BASE_URL", "").strip()
    if explicit_key and explicit_url:
        return ProviderConfig(
            name=os.environ.get("LLM_PROVIDER_NAME", "custom"),
            base_url=explicit_url,
            api_key=explicit_key,
            default_model=os.environ.get("LLM_MODEL", DEFAULT_LAMBDA_MODEL),
        )

    # 2. Lambda Inference API — preferred when a Lambda key is present.
    lambda_key = os.environ.get("LAMBDA_API_KEY", "").strip()
    if lambda_key:
        return ProviderConfig(
            name="lambda",
            base_url=os.environ.get("LAMBDA_BASE_URL", DEFAULT_LAMBDA_BASE_URL).strip(),
            api_key=lambda_key,
            default_model=os.environ.get("LAMBDA_MODEL", DEFAULT_LAMBDA_MODEL).strip(),
        )

    # 3. OpenAI — legacy fallback. Kept so old deployments keep working
    #    while the env is being migrated.
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if openai_key:
        return ProviderConfig(
            name="openai",
            base_url=os.environ.get("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL).strip(),
            api_key=openai_key,
            default_model=os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL).strip(),
        )

    return None


def is_configured() -> bool:
    """Cheap check for the health endpoint and graceful-degrade paths."""
    return _resolve_provider() is not None


def _deepseek_pulse_fallback_config() -> Optional[ProviderConfig]:
    """Optional DeepSeek API for Ask Pulse only when Lambda/OpenAI primary fails."""
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        return None
    return ProviderConfig(
        name="deepseek",
        base_url=os.environ.get("DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL).strip(),
        api_key=key,
        default_model=os.environ.get("DEEPSEEK_MODEL", DEFAULT_DEEPSEEK_MODEL).strip(),
    )


def is_deepseek_pulse_fallback_configured() -> bool:
    return _deepseek_pulse_fallback_config() is not None


def active_provider_name() -> str:
    """``"lambda"`` / ``"openai"`` / ``"custom"`` / ``"none"``."""
    cfg = _resolve_provider()
    return cfg.name if cfg else "none"


def active_model() -> str:
    """The model id that ``chat_completion`` will hit when invoked
    without an explicit ``model`` argument. Returns empty string when
    nothing is configured."""
    cfg = _resolve_provider()
    return cfg.default_model if cfg else ""


async def _post_chat_completion(
    cfg: ProviderConfig,
    messages: list[dict[str, Any]],
    *,
    model: Optional[str],
    temperature: float,
    max_tokens: int,
    timeout: float,
    response_format: Optional[dict[str, Any]],
    extra_payload: Optional[dict[str, Any]] = None,
) -> str:
    payload: dict[str, Any] = {
        "model": model or cfg.default_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if response_format is not None:
        payload["response_format"] = response_format
    if extra_payload:
        payload.update(extra_payload)

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            cfg.chat_completions_url,
            headers={
                "Authorization": f"Bearer {cfg.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )

    if resp.status_code != 200:
        body = resp.text
        snippet = body[:400] + ("…" if len(body) > 400 else "")
        logger.warning(
            "LLM call to %s (%s) failed: HTTP %d — %s",
            cfg.name, payload["model"], resp.status_code, snippet,
        )
        raise LLMHTTPError(resp.status_code, body, provider=cfg.name)

    body = resp.json()
    try:
        return body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise LLMHTTPError(
            200,
            f"unexpected response shape: {body!r}",
            provider=cfg.name,
        ) from e


def _choice_message_from_body(body: dict[str, Any], *, provider: str) -> dict[str, Any]:
    try:
        msg = body["choices"][0]["message"]
        if not isinstance(msg, dict):
            raise TypeError("message not a dict")
        return msg
    except (KeyError, IndexError, TypeError) as e:
        raise LLMHTTPError(
            200,
            f"unexpected response shape: {body!r}",
            provider=provider,
        ) from e


async def _post_chat_completion_message(
    cfg: ProviderConfig,
    messages: list[dict[str, Any]],
    *,
    model: Optional[str],
    temperature: float,
    max_tokens: int,
    timeout: float,
    tools: Optional[list[dict[str, Any]]] = None,
    tool_choice: Any = "auto",
) -> dict[str, Any]:
    """POST chat/completions and return the assistant ``message`` object (may include ``tool_calls``)."""
    payload: dict[str, Any] = {
        "model": model or cfg.default_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if tools is not None:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            cfg.chat_completions_url,
            headers={
                "Authorization": f"Bearer {cfg.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )

    if resp.status_code != 200:
        body = resp.text
        snippet = body[:400] + ("…" if len(body) > 400 else "")
        logger.warning(
            "LLM call to %s (%s) failed: HTTP %d — %s",
            cfg.name, payload["model"], resp.status_code, snippet,
        )
        raise LLMHTTPError(resp.status_code, body, provider=cfg.name)

    body = resp.json()
    return _choice_message_from_body(body, provider=cfg.name)


def _pulse_chat_provider_chain(
    local_model: Optional[str],
) -> list[tuple[ProviderConfig, Optional[str]]]:
    """Ordered ``(provider, model)`` list to try for Ask Pulse.

    DeepSeek goes FIRST when ``DEEPSEEK_API_KEY`` is set, so the user-facing chat
    uses the fast cloud API instead of the GPU-contended local Ollama (which the
    ingest / extraction pipeline keeps to itself via :func:`chat_completion`).
    The local provider stays as a fallback for when DeepSeek is unreachable.
    """
    chain: list[tuple[ProviderConfig, Optional[str]]] = []
    ds_cfg = _deepseek_pulse_fallback_config()
    if ds_cfg is not None:
        ds_model = (os.environ.get("PULSE_CHAT_DEEPSEEK_MODEL") or "").strip() or ds_cfg.default_model
        chain.append((ds_cfg, ds_model))
    local_cfg = _resolve_provider()
    if local_cfg is not None:
        chain.append((local_cfg, local_model))
    return chain


async def pulse_chat_completion_message(
    messages: list[dict[str, Any]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.25,
    max_tokens: int = 1400,
    timeout: float = 75.0,
    tools: Optional[list[dict[str, Any]]] = None,
    tool_choice: Any = "auto",
) -> dict[str, Any]:
    """Ask Pulse multi-turn (returns raw message dict). Prefers DeepSeek when
    configured, then the local provider — see :func:`_pulse_chat_provider_chain`."""
    chain = _pulse_chat_provider_chain(model)
    if not chain:
        raise LLMConfigError(
            "No LLM provider configured. Set DEEPSEEK_API_KEY (preferred for Ask "
            "Pulse), LAMBDA_API_KEY, or OPENAI_API_KEY."
        )
    for idx, (cfg, mdl) in enumerate(chain):
        is_last = idx == len(chain) - 1
        try:
            return await _post_chat_completion_message(
                cfg,
                messages,
                model=mdl,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=timeout,
                tools=tools,
                tool_choice=tool_choice,
            )
        except LLMHTTPError as e:
            if is_last or not _pulse_primary_should_fallback_http(e):
                raise
            logger.warning(
                "Pulse chat (tools) provider %s failed (%s); trying next: %s",
                cfg.name, e.status_code, e,
            )
        except httpx.RequestError as e:
            if is_last:
                raise
            logger.warning("Pulse chat (tools) provider %s transport error; trying next: %s", cfg.name, e)
    raise LLMConfigError("Ask Pulse: provider chain exhausted without a response.")


async def chat_completion(
    messages: list[dict[str, Any]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.0,
    max_tokens: int = 300,
    response_format: Optional[dict[str, Any]] = None,
    timeout: float = 30.0,
    extra_payload: Optional[dict[str, Any]] = None,
) -> str:
    """POST a chat-completion request and return the assistant's text content.

    Raises :class:`LLMConfigError` if no provider env is set and
    :class:`LLMHTTPError` for non-200 responses. Network/decoding failures
    propagate as the underlying ``httpx`` / ``ValueError`` exception so
    the caller can decide what's fatal vs retryable.
    """

    cfg = _resolve_provider()
    if cfg is None:
        raise LLMConfigError(
            "No LLM provider configured. Set LAMBDA_API_KEY (preferred) "
            "or OPENAI_API_KEY in the environment."
        )

    return await _post_chat_completion(
        cfg,
        messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout,
        response_format=response_format,
        extra_payload=extra_payload,
    )


def _pulse_primary_should_fallback_http(err: LLMHTTPError) -> bool:
    """Retry Ask Pulse on upstream overload / gateway / rate-limit errors."""
    if err.status_code == 200:
        return False
    if err.status_code >= 500:
        return True
    if err.status_code in (408, 429):
        return True
    return False


async def pulse_chat_completion(
    messages: list[dict[str, Any]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.25,
    max_tokens: int = 1400,
    timeout: float = 75.0,
) -> str:
    """Ask Pulse: prefers DeepSeek when configured, then the local provider.

    Used only by ``POST /api/pulse-chat``. Ingest and extraction keep using
    :func:`chat_completion` (local provider only), so routing Ask Pulse to
    DeepSeek keeps the user-facing chat off the GPU-contended local Ollama
    without changing pipeline behavior. See :func:`_pulse_chat_provider_chain`.
    """
    chain = _pulse_chat_provider_chain(model)
    if not chain:
        raise LLMConfigError(
            "No LLM provider configured. Set DEEPSEEK_API_KEY (preferred for Ask "
            "Pulse), LAMBDA_API_KEY, or OPENAI_API_KEY."
        )
    for idx, (cfg, mdl) in enumerate(chain):
        is_last = idx == len(chain) - 1
        try:
            return await _post_chat_completion(
                cfg,
                messages,
                model=mdl,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=timeout,
                response_format=None,
                extra_payload=None,
            )
        except LLMHTTPError as e:
            if is_last or not _pulse_primary_should_fallback_http(e):
                raise
            logger.warning("Pulse chat provider %s failed (%s); trying next: %s", cfg.name, e.status_code, e)
        except httpx.RequestError as e:
            if is_last:
                raise
            logger.warning("Pulse chat provider %s transport error; trying next: %s", cfg.name, e)
    raise LLMConfigError("Ask Pulse: provider chain exhausted without a response.")


def chat_completion_sync(
    messages: list[dict[str, Any]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.0,
    max_tokens: int = 300,
    response_format: Optional[dict[str, Any]] = None,
    timeout: float = 30.0,
    extra_payload: Optional[dict[str, Any]] = None,
) -> str:
    """Synchronous twin of :func:`chat_completion`.

    Used by code paths that aren't (yet) async — currently the
    ``auto_verify.run_llm_audit`` second-opinion check, which is invoked
    from CLI scripts where adding an event loop would be over-engineering.
    """

    cfg = _resolve_provider()
    if cfg is None:
        raise LLMConfigError(
            "No LLM provider configured. Set LAMBDA_API_KEY (preferred) "
            "or OPENAI_API_KEY in the environment."
        )

    payload: dict[str, Any] = {
        "model": model or cfg.default_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if response_format is not None:
        payload["response_format"] = response_format
    if extra_payload:
        payload.update(extra_payload)

    with httpx.Client(timeout=timeout) as client:
        resp = client.post(
            cfg.chat_completions_url,
            headers={
                "Authorization": f"Bearer {cfg.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )

    if resp.status_code != 200:
        body = resp.text
        snippet = body[:400] + ("…" if len(body) > 400 else "")
        logger.warning(
            "LLM call to %s (%s) failed: HTTP %d — %s",
            cfg.name, payload["model"], resp.status_code, snippet,
        )
        raise LLMHTTPError(resp.status_code, body, provider=cfg.name)

    body = resp.json()
    try:
        return body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise LLMHTTPError(
            200,
            f"unexpected response shape: {body!r}",
            provider=cfg.name,
        ) from e
