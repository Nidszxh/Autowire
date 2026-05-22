"""Unit tests for daemon routing logic — no hardware or WirePlumber required."""

import os
import tempfile
import unittest
from unittest.mock import MagicMock, call, patch

# conftest.py inserts the project root; import via the src package
from src import config_mgr, daemon


class SetSystemDefaultTestCase(unittest.TestCase):
    @patch('src.daemon.subprocess.run')
    def test_calls_wpctl_with_correct_args(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)
        result = daemon.set_system_default('alsa_output.usb-DAC.analog-stereo')
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        self.assertEqual(args, ['wpctl', 'set-default', 'alsa_output.usb-DAC.analog-stereo'])
        self.assertTrue(result)

    @patch('src.daemon.subprocess.run')
    def test_returns_false_on_wpctl_error(self, mock_run):
        import subprocess
        mock_run.side_effect = subprocess.CalledProcessError(1, 'wpctl', stderr='No such node')
        result = daemon.set_system_default('bad_node')
        self.assertFalse(result)

    @patch('src.daemon.subprocess.run', side_effect=FileNotFoundError)
    def test_returns_false_when_wpctl_not_found(self, _mock_run):
        result = daemon.set_system_default('some_node')
        self.assertFalse(result)

    def test_returns_false_for_empty_node_name(self):
        result = daemon.set_system_default('')
        self.assertFalse(result)


class SetBtProfileTestCase(unittest.TestCase):
    @patch('src.daemon.subprocess.run')
    def test_calls_wpctl_with_correct_args(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)
        result = daemon.set_bt_profile(42, 'a2dp-sink-aac')
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        self.assertEqual(args, ['wpctl', 'set-profile', '42', 'a2dp-sink-aac'])
        self.assertTrue(result)

    @patch('src.daemon.subprocess.run')
    def test_returns_false_on_wpctl_error(self, mock_run):
        import subprocess
        mock_run.side_effect = subprocess.CalledProcessError(1, 'wpctl', stderr='No such device')
        result = daemon.set_bt_profile(42, 'a2dp-sink-aac')
        self.assertFalse(result)

    @patch('src.daemon.subprocess.run', side_effect=FileNotFoundError)
    def test_returns_false_when_wpctl_not_found(self, _mock_run):
        result = daemon.set_bt_profile(42, 'a2dp-sink-aac')
        self.assertFalse(result)

    def test_returns_false_for_empty_profile(self):
        result = daemon.set_bt_profile(42, '')
        self.assertFalse(result)

    def test_returns_false_for_zero_id(self):
        result = daemon.set_bt_profile(0, 'a2dp-sink-aac')
        self.assertFalse(result)

    def test_returns_false_for_negative_id(self):
        result = daemon.set_bt_profile(-1, 'a2dp-sink-aac')
        self.assertFalse(result)


class BtCardNameTestCase(unittest.TestCase):
    def test_bt_output_node(self):
        self.assertEqual(
            daemon._bt_card_name('bluez_output.12_34_56_78_9A_BC.a2dp-sink'),
            'bluez_card.12_34_56_78_9A_BC',
        )

    def test_bt_input_node(self):
        self.assertEqual(
            daemon._bt_card_name('bluez_input.12_34_56_78_9A_BC.handsfree-headset'),
            'bluez_card.12_34_56_78_9A_BC',
        )

    def test_non_bt_node_returns_none(self):
        self.assertIsNone(daemon._bt_card_name('alsa_output.usb-DAC.analog-stereo'))

    def test_empty_string_returns_none(self):
        self.assertIsNone(daemon._bt_card_name(''))


class CheckAndRouteDeviceTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp()
        config_mgr.CONFIG_DIR = self._tmpdir
        config_mgr.CONFIG_FILE = os.path.join(self._tmpdir, 'profiles.json')
        daemon._last_routed.clear()

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    @patch('src.daemon.set_system_default')
    def test_matching_profile_triggers_both_actions(self, mock_set):
        config_mgr.save_profile(
            'Desk Setup', 'trigger_dock',
            'sink_usb', 'source_headset',
            is_active=True,
        )
        result = daemon.check_and_route_device('trigger_dock')
        self.assertTrue(result)
        mock_set.assert_has_calls([
            call('sink_usb'),
            call('source_headset'),
        ], any_order=False)

    @patch('src.daemon.set_system_default')
    def test_unknown_node_is_ignored(self, mock_set):
        config_mgr.save_profile('Home', 'trigger_home', 'sink', 'src')
        result = daemon.check_and_route_device('unknown_device_node')
        self.assertFalse(result)
        mock_set.assert_not_called()

    @patch('src.daemon.set_system_default')
    def test_only_matching_profile_fires(self, mock_set):
        config_mgr.save_profile('A', 'trigger_a', 'sink_a', 'src_a')
        config_mgr.save_profile('B', 'trigger_b', 'sink_b', 'src_b', is_active=True)
        daemon.check_and_route_device('trigger_b')
        mock_set.assert_has_calls([call('sink_b'), call('src_b')])
        self.assertEqual(mock_set.call_count, 2)

    @patch('src.daemon.set_system_default')
    def test_empty_sink_skipped(self, mock_set):
        config_mgr.save_profile('NoSink', 'trigger_x', '', 'source_y', is_active=True)
        daemon.check_and_route_device('trigger_x')
        mock_set.assert_called_once_with('source_y')

    @patch('src.daemon.set_system_default')
    def test_no_profiles_returns_false(self, mock_set):
        config_mgr.initialize_config()
        result = daemon.check_and_route_device('any_node')
        self.assertFalse(result)
        mock_set.assert_not_called()

    @patch('src.daemon.set_system_default')
    @patch('src.daemon.set_bt_profile')
    def test_bt_profile_applied_for_bt_node(self, mock_bt, mock_default):
        mock_monitor = MagicMock()
        mock_monitor.get_device_global_id.return_value = 55
        config_mgr.save_profile(
            'Headphones', 'bluez_output.12_34_56_78_9A_BC.a2dp-sink',
            '', '', 'a2dp-sink-aac',
            is_active=True,
        )
        result = daemon.check_and_route_device(
            'bluez_output.12_34_56_78_9A_BC.a2dp-sink',
            monitor=mock_monitor,
        )
        self.assertTrue(result)
        mock_monitor.get_device_global_id.assert_called_once_with(
            'bluez_card.12_34_56_78_9A_BC'
        )
        mock_bt.assert_called_once_with(55, 'a2dp-sink-aac')

    @patch('src.daemon.set_system_default')
    @patch('src.daemon.set_bt_profile')
    def test_bt_profile_skipped_when_no_monitor(self, mock_bt, mock_default):
        config_mgr.save_profile(
            'Headphones', 'bluez_output.12_34_56_78_9A_BC.a2dp-sink',
            'some_sink', '', 'a2dp-sink-aac',
            is_active=True,
        )
        result = daemon.check_and_route_device(
            'bluez_output.12_34_56_78_9A_BC.a2dp-sink',
            monitor=None,
        )
        self.assertTrue(result)
        mock_bt.assert_not_called()

    @patch('src.daemon.set_system_default')
    @patch('src.daemon.set_bt_profile')
    def test_bt_profile_skipped_for_non_bt_node(self, mock_bt, mock_default):
        mock_monitor = MagicMock()
        config_mgr.save_profile('USB', 'alsa_input.usb-mic', '', '', 'a2dp-sink-aac', is_active=True)
        daemon.check_and_route_device('alsa_input.usb-mic', monitor=mock_monitor)
        mock_bt.assert_not_called()

    @patch('src.daemon.set_system_default')
    @patch('src.daemon.set_bt_profile')
    def test_bt_profile_skipped_when_empty(self, mock_bt, mock_default):
        config_mgr.save_profile('Headphones', 'bluez_output.aa_bb_cc_dd_ee_ff.a2dp-sink', '', '', '', is_active=True)
        daemon.check_and_route_device('bluez_output.aa_bb_cc_dd_ee_ff.a2dp-sink')
        mock_bt.assert_not_called()


if __name__ == '__main__':
    unittest.main()
