import unittest

from philly_pulse import geocode, location_aliases, location_validate


class LocationPipelineTests(unittest.TestCase):
    def test_nyc_avenue_alias_expansion(self):
        alts = location_aliases.expand_location_aliases(
            "6th Ave and 14th St", city="nyc"
        )
        self.assertTrue(any("Avenue of the Americas" in a for a in alts))

    def test_transcript_geocode_candidates(self):
        cands = geocode.transcript_geocode_candidates(
            "units responding to 23rd and 6th avenue working fire"
        )
        self.assertTrue(any("23" in c and "6" in c for c in cands))

    def test_queries_do_not_duplicate_city_state_suffix(self):
        queries = geocode._make_queries(
            "1755 Gunbarrel Road, Chattanooga, TN",
            suffix=", Chattanooga, TN",
        )
        self.assertTrue(queries)
        self.assertFalse(any("TN, TN" in q for q in queries))
        self.assertFalse(any("Road Street" in q for q in queries))

    def test_room_only_location_is_vague(self):
        self.assertTrue(geocode._is_too_vague("room 10", ", Chattanooga, TN"))

    def test_validator_rejects_missing_transcript_ordinal(self):
        result = location_validate.validate_location(
            raw_text="working fire at West 23rd Street",
            location_text="6th Ave and 14th St, New York, NY",
            lat=40.737,
            lng=-73.998,
            feed_meta=None,
            city="nyc",
        )
        self.assertFalse(result.ok)

    def test_validator_accepts_matching_ordinal(self):
        result = location_validate.validate_location(
            raw_text="box assignment 14th and 6th",
            location_text="14th St and 6th Ave, New York, NY",
            lat=40.737,
            lng=-73.998,
            feed_meta=None,
            city="nyc",
        )
        self.assertTrue(result.ok)

    def test_validator_prefers_text_borough_over_feed_default(self):
        """Citywide-style feeds tag a default borough but dispatch names another."""
        centroid = location_aliases.borough_centroid("nyc", "Bronx")
        self.assertIsNotNone(centroid)
        lat, lng = centroid
        result = location_validate.validate_location(
            raw_text="10-75 working fire West Bronx",
            location_text="West Bronx, New York, NY",
            lat=lat,
            lng=lng,
            feed_meta={"borough": "Manhattan"},
            city="nyc",
        )
        self.assertTrue(result.ok, result.reason)


if __name__ == "__main__":
    unittest.main()
