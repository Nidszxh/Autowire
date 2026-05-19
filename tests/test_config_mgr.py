"""Unit tests for config_mgr — no hardware or WirePlumber required."""

import json
import os
import tempfile
import unittest

from src import config_mgr


class ConfigMgrTestCase(unittest.TestCase):
    def setUp(self):
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
        config_mgr.initialize_config()
        with open(config_mgr.CONFIG_FILE, encoding='utf-8') as fh:
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

    def test_save_same_trigger_different_name_creates_multiple(self):
        """Multiple profiles can share the same trigger device."""
        config_mgr.save_profile('AAC High Quality', 'bt_headset', 'sink', 'mic', 'a2dp-sink-aac')
        config_mgr.save_profile('HSP for Calls', 'bt_headset', 'sink', 'mic', 'handsfree-headset')
        profiles = config_mgr.load_profiles()
        self.assertEqual(len(profiles), 2)
        names = {p['profile_name'] for p in profiles}
        self.assertEqual(names, {'AAC High Quality', 'HSP for Calls'})
        triggers = {p['trigger_device_name'] for p in profiles}
        self.assertEqual(triggers, {'bt_headset'})

    def test_save_same_trigger_and_name_replaces(self):
        """Saving with the same trigger+name updates in-place."""
        config_mgr.save_profile('My Profile', 'trigger', 'sink_a', 'src_a')
        config_mgr.save_profile('My Profile', 'trigger', 'sink_b', 'src_b')
        profiles = config_mgr.load_profiles()
        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[0]['actions']['default_sink'], 'sink_b')

    def test_save_multiple_profiles_different_triggers(self):
        config_mgr.save_profile('A', 'trigger_1', 'sink_1', 'src_1')
        config_mgr.save_profile('B', 'trigger_2', 'sink_2', 'src_2')
        self.assertEqual(len(config_mgr.load_profiles()), 2)

    def test_save_with_bt_profile(self):
        config_mgr.save_profile('BT', 'trigger_bt', 'sink', 'src', 'a2dp-sink-aac')
        profiles = config_mgr.load_profiles()
        self.assertEqual(profiles[0]['actions']['bt_profile'], 'a2dp-sink-aac')

    def test_save_default_bt_profile_is_empty(self):
        config_mgr.save_profile('NoBT', 'trigger_x', 'sink', 'src')
        profiles = config_mgr.load_profiles()
        self.assertEqual(profiles[0]['actions']['bt_profile'], '')

    # ── get ─────────────────────────────────────────────────────────────────

    def test_get_profile_by_trigger_and_name(self):
        config_mgr.save_profile('Home', 'trigger_home', 'sink', 'src')
        config_mgr.save_profile('Work', 'trigger_work', 'sink2', 'src2')
        p = config_mgr.get_profile('trigger_home', 'Home')
        self.assertIsNotNone(p)
        self.assertEqual(p['profile_name'], 'Home')

    def test_get_profile_returns_none_for_unknown_trigger(self):
        self.assertIsNone(config_mgr.get_profile('nonexistent_trigger', 'any_name'))

    def test_get_profile_returns_none_for_unknown_name(self):
        config_mgr.save_profile('Existing', 'trigger', 'sink', 'src')
        self.assertIsNone(config_mgr.get_profile('trigger', 'NonExistent'))

    def test_get_profiles_for_trigger_returns_all_matching(self):
        config_mgr.save_profile('AAC', 'bt_headset', 'sink', 'mic', 'a2dp-sink-aac')
        config_mgr.save_profile('HSP', 'bt_headset', 'sink', 'mic', 'handsfree-headset')
        config_mgr.save_profile('Unrelated', 'other_device', 'sink', 'mic')
        results = config_mgr.get_profiles_for_trigger('bt_headset')
        self.assertEqual(len(results), 2)
        names = {p['profile_name'] for p in results}
        self.assertEqual(names, {'AAC', 'HSP'})

    def test_get_profiles_for_trigger_returns_empty_for_unknown(self):
        self.assertEqual(config_mgr.get_profiles_for_trigger('unknown'), [])

    # ── delete ──────────────────────────────────────────────────────────────

    def test_delete_profile_removes_one_specific_entry(self):
        config_mgr.save_profile('Home', 'trigger_home', 'sink', 'src')
        config_mgr.save_profile('Work', 'trigger_home', 'sink2', 'src2')
        result = config_mgr.delete_profile('trigger_home', 'Home')
        self.assertTrue(result)
        profiles = config_mgr.load_profiles()
        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[0]['profile_name'], 'Work')

    def test_delete_nonexistent_profile_returns_false(self):
        result = config_mgr.delete_profile('ghost_trigger', 'ghost_name')
        self.assertFalse(result)

    def test_delete_does_not_affect_other_profiles(self):
        config_mgr.save_profile('A', 'trigger_a', 's', 'src')
        config_mgr.save_profile('B', 'trigger_b', 's', 'src')
        config_mgr.delete_profile('trigger_a', 'A')
        profiles = config_mgr.load_profiles()
        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[0]['profile_name'], 'B')

    def test_delete_wrong_name_returns_false(self):
        config_mgr.save_profile('My Profile', 'trigger_x', 'sink', 'src')
        result = config_mgr.delete_profile('trigger_x', 'Wrong Name')
        self.assertFalse(result)
        self.assertEqual(len(config_mgr.load_profiles()), 1)

    # ── resilience ──────────────────────────────────────────────────────────

    def test_load_returns_empty_list_on_corrupt_file(self):
        config_mgr.initialize_config()
        with open(config_mgr.CONFIG_FILE, 'w', encoding='utf-8') as fh:
            fh.write('{ not valid json }}}')
        self.assertEqual(config_mgr.load_profiles(), [])

    def test_atomic_write_leaves_no_temp_file_on_success(self):
        config_mgr.save_profile('X', 'trigger_x', 'sink', 'src')
        temps = [f for f in os.listdir(self._tmpdir) if f.startswith('.profiles_')]
        self.assertEqual(temps, [], 'Temp file should be cleaned up after successful write')


if __name__ == '__main__':
    unittest.main()