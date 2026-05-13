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


if __name__ == "__main__":
    unittest.main()
