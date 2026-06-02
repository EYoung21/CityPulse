"""Deterministic anti-hallucination guard for scanner transcripts.

CityPulse transcribes noisy police-radio audio (faster-whisper) and an LLM
classifies each line into an incident category. Two routine radio behaviors can
fool that pipeline into inventing serious incidents:

  * Phonetic spelling. Officers spell names/streets letter-by-letter with the
    APCO/police and NATO phonetic alphabets ("Bird" = Boy-Ida-Robert-David).
    Noisy ASR can mangle one spelled letter into a severe-sounding word
    ("murder"), and the LLM then classifies the whole transmission as e.g.
    violent_weapon.
  * Unit-number readbacks. Bare numeric strings ("1205, 2000") are unit IDs,
    not incidents.

SAFETY FIRST. Missing a real shooting is far worse than letting one bad row
through, so this guard is deliberately narrow and biased toward keeping:

  * INCIDENT-KEYWORD VETO. If the line contains ANY concrete incident word
    (shots, shooting, gun, stabbing, robbery, armed, victim, ...), the guard
    NEVER suppresses -- even when a suspect/street name is spelled out right
    after it. A lone "murdered" in gibberish is deterministically
    indistinguishable from a real terse "stabbing" call, so we do not try to
    out-guess it here; that semantic case is handled by the extraction prompt,
    which has the full context. This guard only catches lines that carry a
    SEVERE category yet contain NO incident word at all and are dominated by
    phonetic spelling / unit numbers -- i.e. pure administrative chatter the
    model mislabeled.

The extraction prompt (llm._build_system_prompt) is the primary defense; this
module is a zero-false-negative backstop for the unambiguous chatter case.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Categories where a false positive is most harmful (a fake shooting/murder).
# The guard only ever acts on these; everything else is left untouched.
SEVERE_CATEGORIES = frozenset(
    {"violent_weapon", "violent_no_weapon", "shots_heard", "robbery"}
)

# APCO/police + NATO phonetic alphabets, plus common department variants.
_PHONETIC = frozenset(
    {
        # APCO / police
        "adam", "boy", "charles", "david", "edward", "frank", "george",
        "henry", "ida", "john", "king", "lincoln", "mary", "nora", "ocean",
        "paul", "queen", "robert", "sam", "tom", "union", "victor", "william",
        "young", "zebra",
        # NATO
        "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf",
        "hotel", "india", "juliet", "juliett", "kilo", "lima", "mike",
        "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango",
        "uniform", "whiskey", "yankee", "zulu",
        # common department variants
        "nancy", "sammy", "xray", "x-ray",
    }
)

# Concrete incident words. If ANY appears, the guard never suppresses -- the line
# is treated as a possible real incident regardless of how much spelling/number
# chatter surrounds it. Includes decoded radio codes for severe events.
_INCIDENT_KEYWORDS = frozenset(
    {
        # firearms / shooting
        "shot", "shots", "shooting", "shooter", "shootout", "fired", "gun",
        "guns", "gunshot", "gunshots", "gunfire", "firearm", "firearms",
        "pistol", "rifle", "shotgun", "revolver", "handgun", "armed", "weapon",
        "weapons", "gunpoint", "sniper", "gsw", "pgun", "pwea", "gunsht",
        # edged / other weapons (nouns -- the verbs stab/cutting are below)
        "knife", "knives", "machete", "blade", "sword", "hatchet", "axe",
        "cleaver", "slash", "slashing", "strapped",
        # violence
        "murder", "murdered", "homicide", "stab", "stabbed", "stabbing",
        "stabbings", "assault", "assaulted", "fight", "fighting", "cutting",
        "beaten", "battery", "victim", "wounded", "bleeding",
        # robbery / burglary
        "robbery", "robbed", "robbing", "holdup", "robp", "burglary",
        "burglar", "carjacking", "carjack",
    }
)

# Decoded radio codes can fuse to adjacent digits in ASR output ("pgun123").
# Scanned as substrings so a real coded call is never wrongly suppressed.
_GLUED_CODES = ("pgun", "pwea", "robp", "gunsht")

# Acknowledgements / procedural words. Tracked for visibility only; they do NOT
# count toward the admin-dominance fraction, because "copy"/"okay" routinely
# bracket real incident reports too.
_ACK = frozenset(
    {
        "okay", "ok", "copy", "roger", "affirmative", "affirm", "negative",
        "standby", "clear", "received", "acknowledged", "correct", "10-4",
        "104",
    }
)

# Spoken-number words, so a unit-number readback counts the same whether ASR
# emits "1205" or "twelve oh five". Keeps suppression stable across ASR styles.
_NUMBER_WORDS = frozenset(
    {
        "zero", "oh", "one", "two", "three", "four", "five", "six", "seven",
        "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
        "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
        "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
        "hundred", "thousand",
    }
)

_TOKEN_RE = re.compile(r"[A-Za-z0-9\-]+")

# Both must hold (alongside no incident keyword) for suppression.
_MIN_PHONETIC_RUN = 4  # consecutive phonetic-alphabet words = active spelling
_MIN_ADMIN_FRACTION = 0.6  # phonetic + number share of the whole line
_MIN_TOKENS = 6  # don't judge very short fragments


def _tokens(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text or "")]


def _is_number(tok: str) -> bool:
    return tok.isdigit() or tok in _NUMBER_WORDS


@dataclass
class GuardResult:
    suppress: bool
    reason: str
    metrics: dict = field(default_factory=dict)


def assess(text: str, category: str) -> GuardResult:
    """Decide whether a severe extraction is pure spelling/number chatter.

    Suppresses ONLY when the category is severe, the line contains NO concrete
    incident word, and it is dominated by phonetic spelling + unit numbers.
    """
    if category not in SEVERE_CATEGORIES:
        return GuardResult(False, "category_not_severe")

    toks = _tokens(text)
    total = len(toks)
    if total < _MIN_TOKENS:
        return GuardResult(False, "too_short_to_assess", {"total": total})

    # VETO: any real incident word -> never suppress (zero false negatives).
    # This is an intentional safety trade-off. A severe word embedded in spelling
    # chatter (the bird->murder case) is deterministically indistinguishable from
    # a real terse "stabbing, suspect <spelled name>" call -- both are a severe
    # word plus a phonetic run -- so suppressing the former would also drop the
    # latter. We therefore never suppress when an incident word is present and
    # defer that case to the extraction prompt, which has the full context. The
    # guard only catches severe lines with NO incident word at all.
    if any(t in _INCIDENT_KEYWORDS for t in toks) or any(
        code in t for t in toks for code in _GLUED_CODES
    ):
        return GuardResult(False, "incident_keyword_present", {"total": total})

    phonetic = number = ack = 0
    max_run = run = 0
    for t in toks:
        if t in _PHONETIC:
            phonetic += 1
            run += 1
            max_run = max(max_run, run)
        else:
            run = 0
        if _is_number(t):
            number += 1
        if t in _ACK:
            ack += 1

    fraction = (phonetic + number) / total  # ack deliberately excluded
    metrics = {
        "total": total,
        "phonetic": phonetic,
        "number": number,
        "ack": ack,
        "max_phonetic_run": max_run,
        "admin_fraction": round(fraction, 3),
    }

    if max_run >= _MIN_PHONETIC_RUN and fraction >= _MIN_ADMIN_FRACTION:
        return GuardResult(
            True,
            f"phonetic_spelling_dominant(run={max_run},frac={fraction:.2f})",
            metrics,
        )
    return GuardResult(False, "ok", metrics)
