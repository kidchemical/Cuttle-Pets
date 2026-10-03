"""CLI exit codes: agents script on them, so success must report zero."""
import argparse
import io
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from cli import cuttle_pet


class ReportTests(unittest.TestCase):
    def test_ok_true_reports_zero(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cuttle_pet._report({"ok": True}), 0)

    def test_ok_false_reports_nonzero(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cuttle_pet._report({"ok": False}), 1)

    def test_bare_settings_dict_reports_zero(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cuttle_pet._report({"pinned": False}), 0)

    def test_error_key_reports_nonzero(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(
                cuttle_pet._report({"ok": True, "error": "nope"}), 1)

    def test_settings_write_end_to_end(self):
        ns = argparse.Namespace(key="pinned", value="false", func=None)
        with patch.object(cuttle_pet, "_request",
                          return_value={"pinned": False}) as req:
            with redirect_stdout(io.StringIO()):
                code = cuttle_pet.cmd_settings(ns)
        req.assert_called_once_with("POST", "/settings", {"pinned": False})
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
