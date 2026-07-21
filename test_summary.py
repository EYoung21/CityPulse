import asyncio
from fastapi import Response
from philly_pulse import server


def test_empty_city_summary_is_deterministic(monkeypatch) -> None:
    monkeypatch.setattr(
        server.store,
        "list_incidents_for_city",
        lambda _slug, **_kwargs: [],
    )

    result = asyncio.run(server.summary(Response(), city="philly"))

    assert result["summary"] == "No recent incidents to summarize."
    assert result["incident_count"] == 0
    assert result["meta"]["city"] == "philly"
