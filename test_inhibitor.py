"""Tests for philly_pulse.inhibitor dispatch-aware PII guardrails."""

import asyncio
import unittest

from philly_pulse.inhibitor import check_incident


def _check(text: str) -> str:
    return asyncio.run(
        check_incident(text, "medical_priority", "123 Main St", 0.9)
    ).status


class InhibitorDispatchExemptions(unittest.TestCase):
    def test_dispatch_911_code_not_ssn(self):
        self.assertEqual(
            _check("911-43-2501-South 7-Street, cardiac emergency en route"),
            "passed",
        )

    def test_real_ssn_still_blocked(self):
        self.assertEqual(_check("Victim SSN is 123-45-6789"), "blocked")

    def test_plain_nine_digits_without_context_passes(self):
        self.assertEqual(_check("case number 436494050 on Broad Street"), "passed")

    def test_plain_nine_digits_with_ssn_context_blocked(self):
        self.assertEqual(_check("his ssn is 436494050"), "blocked")

    def test_cardiac_emergency_not_payment_card(self):
        self.assertEqual(
            _check(
                "3-13-B for the main cardiac emergency, 1203, Gainesboro, Rose. "
                "3-13-B for the main cardiac emergency"
            ),
            "passed",
        )

    def test_radio_repeat_digits_not_payment_card(self):
        self.assertEqual(
            _check("7-0-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1"),
            "passed",
        )

    def test_real_credit_card_blocked(self):
        self.assertEqual(
            _check("suspect used credit card 4111 1111 1111 1111"),
            "blocked",
        )

    def test_unit_address_not_phone(self):
        self.assertEqual(
            _check("36-100, Hixson Pike, Suite 142, at the Dispatch center"),
            "passed",
        )

    def test_extension_style_numbers_not_phone(self):
        self.assertEqual(_check("325-1600. 325-1600, okay."), "passed")

    def test_real_phone_blocked(self):
        self.assertEqual(_check("call witness at 215-555-1234"), "blocked")

    def test_bare_ten_digit_phone_blocked(self):
        # Regression: separator-less phone used to leak through.
        self.assertEqual(_check("his number is 2155551234"), "blocked")

    def test_eleven_digit_phone_with_country_code_blocked(self):
        self.assertEqual(_check("reach him at 12155551234"), "blocked")

    def test_ten_digit_id_starting_with_one_not_phone(self):
        # NANP area codes never start with 0/1, so long IDs don't false-trip.
        self.assertEqual(_check("incident reference 1004325019 logged"), "passed")


if __name__ == "__main__":
    unittest.main()
