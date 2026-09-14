from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from summarise_bot.single_instance import AlreadyRunningError, SingleInstanceLock

ROOT = Path(__file__).resolve().parent.parent


class SingleInstanceLockTests(unittest.TestCase):
    def test_second_lock_in_another_process_is_refused(self):
        # Must be a separate process: flock is per-open-file-description, so a second
        # acquire inside the SAME process would succeed and prove nothing.
        with TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "bot.lock"
            held = SingleInstanceLock(lock_path).acquire()
            try:
                probe = subprocess.run(
                    [sys.executable, "-c",
                     "import sys; sys.path.insert(0, sys.argv[1]);"
                     "from summarise_bot.single_instance import SingleInstanceLock, AlreadyRunningError;"
                     "\ntry:\n"
                     "    SingleInstanceLock(__import__('pathlib').Path(sys.argv[2])).acquire()\n"
                     "    print('ACQUIRED')\n"
                     "except AlreadyRunningError as e:\n"
                     "    print('REFUSED', e.pid)\n",
                     str(ROOT), str(lock_path)],
                    capture_output=True, text=True, timeout=60,
                )
                self.assertIn("REFUSED", probe.stdout, probe.stderr)
                self.assertIn(str(os.getpid()), probe.stdout)
            finally:
                held.release()

    def test_lock_is_reusable_once_released(self):
        with TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "bot.lock"
            SingleInstanceLock(lock_path).acquire().release()
            second = SingleInstanceLock(lock_path)
            second.acquire()  # must not raise
            second.release()

    def test_records_the_holding_pid(self):
        with TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "bot.lock"
            lock = SingleInstanceLock(lock_path).acquire()
            try:
                self.assertEqual(lock_path.read_text().strip(), str(os.getpid()))
            finally:
                lock.release()

    def test_error_message_names_the_pid_and_how_to_stop_it(self):
        error = AlreadyRunningError("4321", Path("/tmp/bot.lock"))
        self.assertIn("4321", str(error))
        self.assertIn("kill 4321", str(error))
        self.assertIn("4006", str(error))


if __name__ == "__main__":
    unittest.main()
