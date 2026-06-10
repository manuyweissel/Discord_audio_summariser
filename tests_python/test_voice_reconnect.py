from __future__ import annotations

import unittest

from summarise_bot.bot import SummariseBotRuntime


def _close_error(code: object) -> RuntimeError:
    return RuntimeError(
        "Voice websocket closed before session was ready; session_id=g:c "
        f"phase=voice_websocket_closed last_opcode=8 close_code={code} history=..."
    )


class IsFatalCloseTests(unittest.TestCase):
    def test_dave_required_and_auth_failures_are_fatal(self) -> None:
        self.assertTrue(SummariseBotRuntime._is_fatal_close(_close_error(4017)))
        self.assertTrue(SummariseBotRuntime._is_fatal_close(_close_error(4004)))

    def test_transient_closes_are_not_fatal(self) -> None:
        for code in (4014, 4015, 4009, 1006):
            self.assertFalse(SummariseBotRuntime._is_fatal_close(_close_error(code)), code)

    def test_timeout_without_close_code_is_not_fatal(self) -> None:
        self.assertFalse(
            SummariseBotRuntime._is_fatal_close(
                RuntimeError("Timed out waiting for voice session readiness; ... close_code=None ...")
            )
        )


if __name__ == "__main__":
    unittest.main()
