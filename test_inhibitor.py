"""Tests for philly_pulse.inhibitor redact-and-publish PII guardrail.

Policy under test: the guardrail never blocks an incident. Real PII *values*
are masked out of the published transcript; police-dispatch artifacts that
merely look like PII are preserved; and a transcript that only *mentions* a
PII keyword (without a real value) publishes untouched.
"""
import asyncio
import unittest

from philly_pulse.inhibitor import check_incident, redact_pii, REDACTION_PLACEHOLDER


def _result(text: str):
    return asyncio.run(check_incident(text, "medical_priority", "123 Main St", 0.9))


class NeverBlocks(unittest.TestCase):
    def test_status_is_never_blocked(self):
        for t in [
            "Victim SSN is 123-45-6789",
            "call witness at 215-555-1234",
            "suspect used credit card 4111 1111 1111 1111",
            "suicidal veteran, threatening suicide, date of birth 5/12/1984",
        ]:
            self.assertNotEqual(_result(t).status, "blocked", t)


class RealPiiRedacted(unittest.TestCase):
    def test_phone_redacted_but_published(self):
        r = _result("call witness at 215-555-1234")
        self.assertEqual(r.status, "redacted")
        self.assertNotIn("215-555-1234", r.redacted_text)
        self.assertIn(REDACTION_PLACEHOLDER, r.redacted_text)

    def test_bare_phone_redacted(self):
        red, reasons = redact_pii("his number is 2155551234")
        self.assertIn("phone", reasons)
        self.assertNotIn("2155551234", red)

    def test_real_ssn_redacted(self):
        red, reasons = redact_pii("Victim SSN is 123-45-6789")
        self.assertIn("ssn", reasons)
        self.assertNotIn("123-45-6789", red)

    def test_real_credit_card_redacted(self):
        red, reasons = redact_pii("suspect used credit card 4111 1111 1111 1111")
        self.assertIn("payment_card", reasons)
        self.assertNotIn("4111 1111 1111 1111", red)

    def test_email_redacted(self):
        red, reasons = redact_pii("contact victim at jane.doe@example.com please")
        self.assertIn("email", reasons)
        self.assertNotIn("jane.doe@example.com", red)

    def test_dob_date_value_redacted(self):
        red, reasons = redact_pii("suspect LaCorey, date of birth 5/12/1984, fled")
        self.assertIn("date_of_birth", reasons)
        self.assertNotIn("5/12/1984", red)


class DispatchArtifactsPreserved(unittest.TestCase):
    def test_dispatch_911_code_preserved(self):
        red, reasons = redact_pii("911-43-2501 South 7 Street, cardiac emergency")
        self.assertEqual(reasons, [])
        self.assertIn("911-43-2501", red)

    def test_cardiac_not_payment_card(self):
        self.assertEqual(
            _result("3-13-B for the main cardiac emergency, 1203 Gainesboro").status,
            "passed",
        )

    def test_radio_repeat_digits_clean(self):
        self.assertEqual(
            _result("7-0-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1").status, "passed"
        )

    def test_unit_address_not_phone(self):
        self.assertEqual(_result("36-100, Hixson Pike, Suite 142").status, "passed")

    def test_extension_numbers_not_phone(self):
        self.assertEqual(_result("325-1600. 325-1600, okay").status, "passed")

    def test_nine_digit_case_number_clean(self):
        self.assertEqual(
            _result("case number 436494050 on Broad Street").status, "passed"
        )

    def test_ten_digit_id_starting_with_one_clean(self):
        self.assertEqual(
            _result("incident reference 1004325019 logged").status, "passed"
        )


class LiveProductionFalsePositivesNowPublish(unittest.TestCase):
    """Real emergencies the old block-everything inhibitor was killing."""

    def test_dob_cue_without_real_date_publishes_clean(self):
        # "send date of birth, 113,000" — no parseable date → nothing masked.
        r = _result("threatening suicide, vehicle crash, send date of birth, 113,000")
        self.assertEqual(r.status, "passed")

    def test_dob_mention_with_date_publishes_redacted(self):
        r = _result("assault, 16-year-old victim, suspect DOB 03/04/1990")
        self.assertEqual(r.status, "redacted")
        self.assertNotIn("03/04/1990", r.redacted_text)

    def test_case_number_phone_shape_publishes(self):
        # 10-digit "case number" gets masked, but the unresponsive-patient
        # incident still publishes (status != blocked).
        r = _result("77-year-old male, unresponsive, case number 2516525165")
        self.assertNotEqual(r.status, "blocked")


if __name__ == "__main__":
    unittest.main()
