"""Tests for philly_pulse.spelling_guard.

Run standalone:   venv_local/bin/python test_spelling_guard.py
Or with pytest:   pytest test_spelling_guard.py

Design under test: the guard is a ZERO-FALSE-NEGATIVE backstop. It suppresses a
severe extraction ONLY when the line has no concrete incident word and is
dominated by phonetic spelling / unit numbers. The bird/Calvin semantic case
(a lone mis-transcribed "murdered" in spelling chatter) is intentionally NOT
caught here -- it is handled by the extraction prompt -- because a deterministic
rule cannot tell it apart from a real terse "murdered"/"stabbing" call without
risking dropping real incidents.
"""
from philly_pulse import spelling_guard as sg

# The real failure: officer spelling "Bird"/"Calvin" + unit numbers, mis-heard
# so a lone "murdered" looked like a homicide.
CALVIN = (
    "Lesson being murdered, boy, young, rocketed, person in Calvin. "
    "Charlie, Adam Lincoln, Victor, Ida, Nora, Mississippi, 1205, 2000. Okay."
)

# Genuine severe incidents that ALSO spell a suspect/plate/street name. The
# adversarial review verified the earlier guard wrongly suppressed every one of
# these. They must all survive now (incident-keyword veto).
REAL_SEVERE_WITH_SPELLING = [
    ("Shots fired, suspect Boyd, Boy Ocean Young David", "violent_weapon"),
    ("Stabbing, suspect David Mary King John", "violent_weapon"),
    ("Armed robbery, plate Robert Adam Mary Paul", "robbery"),
    ("Shooting in progress suspect Mary Adam Sam Ocean Nora", "shots_heard"),
    ("Shots fired Dover David Ocean Victor Edward Robert", "shots_heard"),
    ("Need a wagon shooting victim John Adam Charles King Sam", "violent_weapon"),
    ("Copy shots fired Mary Frank Boy Adam okay", "violent_weapon"),
    ("1205 2000 shots fired Adam Boy Charles David", "violent_weapon"),
    ("Shooting Union King Mary Nora Victor", "violent_weapon"),
    # Edged-weapon / sniper nouns (the second-pass weapon-noun gap).
    ("man with a knife, boy ocean yankee david, twelve oh five", "violent_weapon"),
    ("sniper reported, adam boy charles david, twelve fifteen", "shots_heard"),
    ("machete attack, adam boy charles david, one two oh five", "violent_weapon"),
    ("slashing in progress, adam boy charles david edward", "violent_no_weapon"),
    # Decoded code fused to digits in ASR output must still veto.
    ("gunsht45 boy ida robert david king nora", "shots_heard"),
]


def test_calvin_relies_on_prompt_not_guard():
    # "murdered" is a concrete incident word, so the guard vetoes (keeps). The
    # prompt is what reclassifies this as admin_or_noise. Documenting the seam.
    r = sg.assess(CALVIN, "violent_weapon")
    assert not r.suppress
    assert r.reason == "incident_keyword_present"


def test_real_severe_with_spelling_all_survive():
    failures = []
    for text, cat in REAL_SEVERE_WITH_SPELLING:
        r = sg.assess(text, cat)
        if r.suppress:
            failures.append((text, r))
    assert not failures, f"guard wrongly suppressed real incidents: {failures}"


def test_pure_spelling_run_suppressed():
    # Severe category, NO incident word, dominated by spelling + units -> drop.
    r = sg.assess(
        "adam boy charlie david edward frank 1207 2000 copy", "violent_weapon"
    )
    assert r.suppress, r
    assert r.metrics["max_phonetic_run"] >= 4
    assert r.metrics["admin_fraction"] >= 0.6


def test_pure_spelling_with_spoken_numbers_suppressed():
    # Spoken-number readback counts like digits (ASR-style invariant).
    r = sg.assess(
        "adam boy charlie david edward frank twelve oh five two thousand",
        "violent_weapon",
    )
    assert r.suppress, r


def test_plain_shooting_survives():
    r = sg.assess(
        "shots fired, fourth and market, male with a handgun running eastbound",
        "violent_weapon",
    )
    assert not r.suppress, r


def test_non_severe_category_never_suppressed():
    r = sg.assess("adam boy charlie david edward frank 1207 copy", "disorder")
    assert not r.suppress
    assert r.reason == "category_not_severe"


def test_short_fragment_not_judged():
    r = sg.assess("adam boy charlie david", "violent_weapon")
    assert not r.suppress
    assert r.reason == "too_short_to_assess"


def test_terse_real_call_survives():
    # Guard leaves short real calls alone (too short); prompt classifies them.
    r = sg.assess("shots fired", "shots_heard")
    assert not r.suppress


def test_single_phonetic_word_in_real_incident_survives():
    r = sg.assess(
        "person stabbed near victor street, one male down, medic responding",
        "violent_weapon",
    )
    assert not r.suppress, r


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"FAIL {fn.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            print(f"ERROR {fn.__name__}: {e!r}")
    print(f"\n{passed}/{len(fns)} passed")
    raise SystemExit(0 if passed == len(fns) else 1)
