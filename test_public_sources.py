import unittest

from philly_pulse.public_sources import (
    classify_event,
    parse_chattanooga,
    parse_chesco,
    parse_montco,
    parse_notify_nyc,
    parse_sf_fire,
    parse_sf_police,
    public_coordinates,
    public_location,
)


class PrivacyReductionTests(unittest.TestCase):
    def test_exact_address_becomes_hundred_block_and_unit_is_removed(self):
        self.assertEqual(
            public_location("2917 Kings Point Rd Apt 4B"),
            "2900 block Kings Point Rd",
        )

    def test_intersection_is_preserved(self):
        self.assertEqual(
            public_location("17TH ST \\ SHOTWELL ST"),
            "17TH ST & SHOTWELL ST",
        )

    def test_coordinates_are_rounded(self):
        self.assertEqual(
            public_coordinates(35.09736, -85.219751),
            (35.097, -85.22),
        )
        self.assertEqual(public_coordinates(float("nan"), -85.2), (None, None))

    def test_sensitive_events_are_suppressed(self):
        for label in (
            "Amber Alert",
            "juvenile missing",
            "domestic assault",
            "suicidal person",
            "well being check",
            "overdose",
        ):
            self.assertIsNone(classify_event(label), label)

    def test_no_weapon_is_not_misclassified_as_weapon(self):
        self.assertEqual(classify_event("FIGHT NO WEAPON"), "violent_no_weapon")


class StructuredParserTests(unittest.TestCase):
    def test_chattanooga_redacts_address_and_rounds_coordinates(self):
        rows = [{
            "master_incident_id": 99,
            "creation": "2026-07-27T00:43:45.000Z",
            "type_description": "Vehicle Accident -",
            "location": "2917 KINGS POINT RD APT 4B",
            "latitude": 35.09736,
            "longitude": -85.219751,
            "status": "Queued",
            "agency_type": "Law",
        }]
        [incident] = parse_chattanooga(rows)
        self.assertEqual(incident.location_text, "2900 block KINGS POINT RD")
        self.assertEqual((incident.lat, incident.lng), (35.097, -85.22))
        self.assertEqual(incident.severity_category, "traffic_crash_no_injury")

    def test_sf_police_drops_sensitive_calls(self):
        rows = [
            {
                "id": "1",
                "received_datetime": "2026-07-26T21:29:17.000",
                "call_type_final_desc": "ASSAULT",
                "sensitive_call": True,
            },
            {
                "id": "2",
                "received_datetime": "2026-07-26T21:29:17.000",
                "call_type_final_desc": "ROBBERY",
                "sensitive_call": False,
                "intersection_name": "17TH ST \\ SHOTWELL ST",
                "intersection_point": {
                    "coordinates": [-122.416227271, 37.763635137],
                },
            },
        ]
        incidents = parse_sf_police(rows)
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0].source_key, "2")
        self.assertEqual(incidents[0].severity_category, "robbery")

    def test_sf_fire_deduplicates_units_and_generalizes_medical_details(self):
        base = {
            "incident_number": "26104969",
            "received_dttm": "2026-07-26T03:22:19.000",
            "call_type": "Medical Incident",
            "address": "LARKIN ST/OLIVE ST",
            "case_location": {"coordinates": [-122.417805819, 37.784709804]},
        }
        incidents = parse_sf_fire([{**base, "unit_id": "M1"}, {**base, "unit_id": "E1"}])
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0].event_type, "Medical response")

    def test_montco_rss_parses_cross_street(self):
        xml = """<?xml version="1.0"?><rss><channel><item>
        <title>Traffic: VEHICLE ACCIDENT -</title>
        <description>MAIN ST &amp; WALNUT ST; NORRISTOWN; 2026-07-27 @ 00:20:01;</description>
        </item></channel></rss>"""
        [incident] = parse_montco(xml)
        self.assertEqual(incident.city, "philly")
        self.assertEqual(incident.location_text, "MAIN ST & WALNUT ST, NORRISTOWN")

    def test_chesco_html_parses_active_fire(self):
        html = """<table class="main"><tr>
        <td>F26040627</td><td>STRUCTURE FIRE</td><td>DAVOS CT / GENDRY DR</td>
        <td>Caln Township</td><td>07-27-2026 00:36:11</td><td>38</td>
        </tr></table>"""
        [incident] = parse_chesco(html)
        self.assertEqual(incident.severity_category, "fire_hazmat")
        self.assertEqual(incident.location_text, "DAVOS CT & GENDRY DR, Caln Township")

    def test_notify_nyc_drops_person_alerts_but_keeps_traffic(self):
        xml = """<rss><channel>
        <item><title>Notify NYC - Silver Alert - Person (BK)</title>
        <description>Silver Alert for a missing person.</description>
        <pubDate>Mon, 27 Jul 2026 04:00:00 GMT</pubDate></item>
        <item><title>Notify NYC - Traffic Delays - Cross Island Parkway (QN)</title>
        <description>Due to a vehicle collision, expect delays on Cross Island Parkway in Queens.</description>
        <guid>traffic-1</guid><pubDate>Mon, 27 Jul 2026 04:01:00 GMT</pubDate></item>
        </channel></rss>"""
        incidents = parse_notify_nyc(xml)
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0].source_key, "traffic-1")
        self.assertEqual(incidents[0].severity_category, "traffic_crash_no_injury")


if __name__ == "__main__":
    unittest.main()
