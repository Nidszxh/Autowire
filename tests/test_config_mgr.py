"""Unit tests for config_mgr — no hardware or WirePlumber required."""

import json
import os
import sys
import tempfile
import unittest

# conftest.py already inserts the project root; import via package
from src import config_mgr


class ConfigMgrTestCase(unittest.TestCase):
    def setUp(self):
        """Point config_mgr at a fresh temporary directory for each test."""
        self._tmpdir = tempfile.mkdtemp()
        config_mgr.CONFIG_DIR = self._tmpdir
        config_mgr.CONFIG_FILE = os.path.join(self._tmpdir, 'profiles.json')

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    # ── initialization ──────────────────────────────────────────────────────

    def test_initialize_creates_file(self):
        config_mgr.initialize_config()
        self.assertTrue(os.path.exists(config_mgr.CONFIG_FILE))

    def test_initialize_is_idempotent(self):
        config_mgr.initialize_config()
        config_mgr.initialize_config()  # should not raise
        with open(config_mgr.CONFIG_FILE) as fh:
            data = json.load(fh)
        self.assertEqual(data['profiles'], [])

    # ── save & load ─────────────────────────────────────────────────────────

    def test_save_and_load_profile(self):
        config_mgr.save_profile('Home Dock', 'trigger_node', 'sink_node', 'source_node')
        profiles = config_mgr.load_profiles()
        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[0]['profile_name'], 'Home Dock')
        self.assertEqual(profiles[0]['trigger_device_name'], 'trigger_node')
        self.assertEqual(profiles[0]['actions']['default_sink'], 'sink_node')
        self.assertEqual(profiles[0]['actions']['default_source'], 'source_node')

    def test_save_updates_existing_profile(self):
        config_mgr.save_profile('Old Name', 'trigger_node', 'sink_a', 'source_a')
        config_mgr.save_profile('New Name', 'trigger_node', 'sink_b', 'source_b')
        profiles = config_mgr.load_profiles()
        self.assertEqual(len(profiles), 1, 'Should update in-place, not duplicate')
        self.assertEqual(profiles[0]['profile_name'], 'New Name')
        self.assertEqual(profiles[0]['actions']['default_sink'], 'sink_b')

    def test_save_multiple_profiles(self):
        config_mgr.save_profile('A', 'trigger_1', 'sink_1', 'src_1')
        config_mgr.save_profile('B', 'trigger_2', 'sink_2', 'src_2')
        self.assertEqual(len(config_mgr.load_profiles()), 2)

    # ── get ─────────────────────────────────────────────────────────────────

    def test_get_profile_returns_correct_profile(self):
        config_mgr.save_profile('Home', 'trigger_home', 'sink', 'src')
        config_mgr.save_profile('Work', 'trigger_work', 'sink2', 'src2')
        p = config_mgr.get_profile('trigger_home')
        self.assertIsNotNone(p)
        self.assertEqual(p['profile_name'], 'Home')

    def test_get_profile_returns_none_for_unknown(self):
        self.assertIsNone(config_mgr.get_profile('nonexistent_trigger'))

    # ── delete ──────────────────────────────────────────────────────────────

    def test_delete_profile(self):
        config_mgr.save_profile('Home', 'trigger_home', 'sink', 'src')
        result = config_mgr.delete_profile('trigger_home')
        self.assertTrue(result)
        self.assertEqual(config_mgr.load_profiles(), [])

    def test_delete_nonexistent_profile_returns_false(self):
        result = config_mgr.delete_profile('ghost_trigger')
        self.assertFalse(result)

    def test_delete_does_not_affect_other_profiles(self):
        config_mgr.save_profile('A', 'trigger_a', 's', 'src')
        config_mgr.save_profile('B', 'trigger_b', 's', 'src')
        config_mgr.delete_profile('trigger_a')
        profiles = config_mgr.load_profiles()
        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[0]['profile_name'], 'B')

    # ── resilience ──────────────────────────────────────────────────────────

    def test_load_returns_empty_list_on_corrupt_file(self):
        config_mgr.initialize_config()
        with open(config_mgr.CONFIG_FILE, 'w') as fh:
            fh.write('{ not valid json }}}')
        self.assertEqual(config_mgr.load_profiles(), [])

    def test_atomic_write_leaves_no_temp_file_on_success(self):
        config_mgr.save_profile('X', 'trigger_x', 'sink', 'src')
        temps = [f for f in os.listdir(self._tmpdir) if f.startswith('.profiles_')]
        self.assertEqual(temps, [], 'Temp file should be cleaned up after successful write')


if __name__ == '__main__':
    unittest.main()
