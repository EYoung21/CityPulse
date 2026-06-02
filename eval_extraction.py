"""Before/after eval for the Ask-Pulse-adjacent incident extraction fix.

Runs the OLD prompt vs the NEW (hardened) prompt against the real LLM on a
curated transcript set, then applies the deterministic spelling_guard to the NEW
result. Demonstrates the bird->murder false positive is fixed without
regressing real incidents.

Run:
  set -a; . ./.env; set +a
  venv_local/bin/python eval_extraction.py

It forces the OpenAI fallback (gpt-4o-mini) for a reproducible run regardless of
the custom/Lambda env wiring. Prod may use Lambda llama-3.3-70b; the prompt
guidance + guard help regardless of model.
"""
import asyncio
import json
import os

# Pick a reachable provider for the eval. The configured primary is a local
# ollama tunnel (not reachable here) and the OpenAI key is dead, so route the
# "custom" provider slot at DeepSeek (valid key, OpenAI-compatible, already used
# by the product) when available; otherwise fall through to whatever is set.
os.environ.pop("LAMBDA_API_KEY", None)
_ds = os.environ.get("DEEPSEEK_API_KEY", "").strip()
if _ds:
    os.environ["LLM_API_KEY"] = _ds
    os.environ["LLM_BASE_URL"] = os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com/v1"
    os.environ["LLM_MODEL"] = os.environ.get("DEEPSEEK_MODEL") or "deepseek-v4-flash"
    os.environ["LLM_PROVIDER_NAME"] = "deepseek"

from philly_pulse import llm, llm_client, spelling_guard  # noqa: E402

NEW_PROMPT = llm._build_system_prompt(llm._default_city_context, feed_label=None)


def _old_prompt() -> str:
    """Reconstruct the pre-fix prompt by removing the two inserted blocks."""
    p = NEW_PROMPT
    i = p.index("## Scanner reality")
    j = p.index("## Common Radio Codes")
    p = p[:i] + p[j:]
    k = p.index("## Examples")
    p = p[:k].rstrip() + "\n"
    return p


OLD_PROMPT = _old_prompt()

# (label, transcript, what we hope to see)
CASES = [
    (
        "BUG: bird/calvin spelling -> murder",
        "Lesson being murdered, boy, young, rocketed, person in Calvin. "
        "Charlie, Adam Lincoln, Victor, Ida, Nora, Mississippi, 1205, 2000. Okay.",
        "should NOT be violent_weapon",
    ),
    (
        "pure phonetic spelling + units",
        "adam boy charlie david edward frank, 1207, 2000, copy",
        "admin_or_noise",
    ),
    (
        "unit check-in",
        "Adam twelve, in service, ten eight, returning to the district",
        "admin_or_noise",
    ),
    (
        "REAL plain shooting (no regression)",
        "shots fired, fourth and market, male with a handgun running eastbound",
        "violent_weapon",
    ),
    (
        "REAL shooting + spelled suspect name (no false negative)",
        "shots fired at fourth and market, male with a handgun fled on foot "
        "eastbound, suspect last name charlie adam lincoln victor ida nora, "
        "wearing a red hoodie, units responding code three",
        "violent_weapon",
    ),
    (
        "TERSE real shooting + spelled name (review blocker case)",
        "Shots fired, suspect Boyd, Boy Ocean Young David",
        "violent_weapon / shots_heard, guard must NOT suppress",
    ),
    (
        "TERSE bare call (under-reporting check)",
        "shots fired",
        "severe (shots_heard), not admin_or_noise",
    ),
    (
        "EDGED weapon (weapon-noun gap check)",
        "man with a knife, fifth and chestnut, threatening people",
        "violent_weapon, guard must NOT suppress",
    ),
    (
        "REAL garbled prod violent_weapon",
        "We have a person with a gun at the hotel, three people shot inside, "
        "shooter still on location, multiple medics requested",
        "violent_weapon",
    ),
    (
        "REAL medical",
        "Engine five and medic to nineteen hundred Laguna for a code three "
        "stroke response",
        "medical_priority",
    ),
]


async def _classify(system_prompt: str, transcript: str) -> dict:
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": transcript},
    ]
    try:
        content = await llm_client.chat_completion(
            messages,
            temperature=0.0,
            max_tokens=600,  # room for reasoning models (deepseek-v4-flash) to finish JSON
            timeout=60,
            response_format={"type": "json_object"},
        )
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:120]}
    content = content.strip()
    if content.startswith("```"):
        content = "\n".join(
            l for l in content.split("\n") if not l.startswith("```")
        ).strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass
    # Robust fallback: some models prepend reasoning/text; grab the first
    # balanced {...} object.
    start = content.find("{")
    if start != -1:
        depth = 0
        for i in range(start, len(content)):
            if content[i] == "{":
                depth += 1
            elif content[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(content[start : i + 1])
                    except json.JSONDecodeError:
                        break
    return {"error": "bad json", "raw": content[:160]}


def _fmt(d: dict) -> str:
    if "error" in d:
        return f"ERROR({d['error']})"
    rel = d.get("is_dispatch_relevant")
    cat = d.get("severity_category")
    conf = d.get("confidence")
    return f"rel={rel} cat={cat} conf={conf}"


async def main():
    print(f"provider={llm_client.active_provider_name()} model={llm_client.active_model()}")
    print(f"OLD prompt {len(OLD_PROMPT)} chars | NEW prompt {len(NEW_PROMPT)} chars\n")
    print("=" * 100)
    for label, transcript, expect in CASES:
        old = await _classify(OLD_PROMPT, transcript)
        new = await _classify(NEW_PROMPT, transcript)
        new_cat = new.get("severity_category", "") if "error" not in new else ""
        guard = spelling_guard.assess(transcript, new_cat)
        final_cat = "admin_or_noise (guarded)" if guard.suppress else new_cat
        print(f"\n### {label}")
        print(f"    transcript: {transcript[:90]}{'...' if len(transcript) > 90 else ''}")
        print(f"    expect:     {expect}")
        print(f"    OLD prompt: {_fmt(old)}")
        print(f"    NEW prompt: {_fmt(new)}")
        print(f"    + guard:    suppress={guard.suppress} ({guard.reason}) -> FINAL cat={final_cat}")
    print("\n" + "=" * 100)


if __name__ == "__main__":
    asyncio.run(main())
