"""Unit tests for wp_monitor — no hardware or PipeWire daemon required.

Tests the pure-Python helpers (_collect_node, _proxy_properties) and the
signal declarations on WpMonitor. No live PipeWire connection needed.
"""

import unittest
from unittest.mock import MagicMock, patch


class CollectNodeTestCase(unittest.TestCase):
    """Tests for _collect_node()."""

    @staticmethod
    def _make_props(**kwargs) -> MagicMock:
        m = MagicMock()
        def _get(key, _default=''):
            return kwargs.get(key, _default)
        m.get.side_effect = _get
        return m

    def test_returns_none_when_name_is_empty(self):
        from src.wp_monitor import _collect_node
        props = self._make_props(**{'node.name': '', 'media.class': 'Audio/Sink'})
        self.assertIsNone(_collect_node(props))

    def test_returns_none_for_non_audio_class(self):
        from src.wp_monitor import _collect_node
        props = self._make_props(**{'node.name': 'test', 'media.class': 'Video/Sink'})
        self.assertIsNone(_collect_node(props))

    def test_returns_node_dict_for_audio_sink(self):
        from src.wp_monitor import _collect_node
        props = self._make_props(**{
            'node.name': 'alsa_output.usb-DAC.analog-stereo',
            'node.description': 'USB DAC',
            'media.class': 'Audio/Sink',
        })
        result = _collect_node(props)
        self.assertEqual(result['name'], 'alsa_output.usb-DAC.analog-stereo')
        self.assertEqual(result['description'], 'USB DAC')
        self.assertEqual(result['media_class'], 'Audio/Sink')

    def test_returns_node_dict_for_audio_source(self):
        from src.wp_monitor import _collect_node
        props = self._make_props(**{
            'node.name': 'alsa_input.usb-mic',
            'node.description': 'USB Microphone',
            'media.class': 'Audio/Source',
        })
        result = _collect_node(props)
        self.assertIsNotNone(result)
        self.assertEqual(result['name'], 'alsa_input.usb-mic')

    def test_returns_node_dict_for_audio_duplex(self):
        from src.wp_monitor import _collect_node
        props = self._make_props(**{
            'node.name': 'bluez_output.12_34_56_78_9A_BC.a2dp-sink',
            'node.description': 'BT Headset',
            'media.class': 'Audio/Duplex',
        })
        result = _collect_node(props)
        self.assertEqual(result['media_class'], 'Audio/Duplex')

    def test_uses_name_as_fallback_description(self):
        from src.wp_monitor import _collect_node
        props = self._make_props(**{'node.name': 'unknown_node', 'media.class': 'Audio/Sink'})
        result = _collect_node(props)
        self.assertEqual(result['description'], 'unknown_node')


class ProxyPropertiesTestCase(unittest.TestCase):
    """Tests for _proxy_properties()."""

    def test_returns_get_properties_result_on_success(self):
        from src.wp_monitor import _proxy_properties
        mock_props = MagicMock()
        mock_proxy = MagicMock()
        mock_proxy.get_properties.return_value = mock_props

        result = _proxy_properties(mock_proxy)
        self.assertEqual(result, mock_props)
        mock_proxy.get_properties.assert_called_once()

    def test_falls_back_to_proxy_props_on_typeerror(self):
        from src.wp_monitor import _proxy_properties
        mock_proxy = MagicMock()
        mock_proxy.get_properties.side_effect = TypeError()
        fallback = MagicMock()
        mock_proxy.props = MagicMock(properties=fallback)

        result = _proxy_properties(mock_proxy)
        self.assertEqual(result, fallback)

    def test_returns_empty_props_when_both_fail(self):
        from src.wp_monitor import _proxy_properties
        from gi.repository import Wp
        mock_proxy = MagicMock()
        mock_proxy.get_properties.side_effect = TypeError()
        mock_proxy.props = MagicMock(properties=None)

        result = _proxy_properties(mock_proxy)
        self.assertIsNotNone(result)


class WpMonitorSignalDeclarationsTestCase(unittest.TestCase):
    """Verify signal declarations by parsing the module source AST."""

    def test_all_signals_declared_in_gsignals_dict(self):
        import ast, inspect
        from src import wp_monitor
        src = inspect.getsource(wp_monitor)
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == '__gsignals__':
                        keys = [k.value for k in node.value.keys if isinstance(k, ast.Constant)]
                        self.assertIn('node-added', keys)
                        self.assertIn('node-removed', keys)
                        self.assertIn('device-added', keys)
                        self.assertIn('device-removed', keys)
                        return
        self.fail('__gsignals__ not found in source')

    def test_node_added_signal_declares_three_str_args(self):
        import ast, inspect
        from src import wp_monitor
        src = inspect.getsource(wp_monitor)
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == '__gsignals__':
                        for key, val in zip(node.value.keys, node.value.values):
                            if isinstance(key, ast.Constant) and key.value == 'node-added':
                                args_tuple = val.elts[2]
                                self.assertEqual(len(args_tuple.elts), 3)
                                for arg in args_tuple.elts:
                                    self.assertIsInstance(arg, ast.Name)
                                    self.assertEqual(arg.id, 'str')
                                return
        self.fail('node-added signal not found')

    def test_device_added_signal_declares_two_str_args_and_int(self):
        import ast, inspect
        from src import wp_monitor
        src = inspect.getsource(wp_monitor)
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == '__gsignals__':
                        for key, val in zip(node.value.keys, node.value.values):
                            if isinstance(key, ast.Constant) and key.value == 'device-added':
                                args_tuple = val.elts[2]
                                self.assertEqual(len(args_tuple.elts), 3)
                                self.assertEqual(args_tuple.elts[0].id, 'str')
                                self.assertEqual(args_tuple.elts[1].id, 'str')
                                self.assertEqual(args_tuple.elts[2].id, 'int')
                                return
        self.fail('device-added signal not found')


class WpMonitorInternalStateTestCase(unittest.TestCase):
    """Tests for WpMonitor state management (node/device dicts)."""

    def test_get_audio_nodes_returns_copy_of_nodes_dict(self):
        from src.wp_monitor import WpMonitor
        mock_self = MagicMock()
        mock_self._nodes.values.return_value = [
            {'name': 'sink1', 'description': 'Speaker', 'media_class': 'Audio/Sink'},
            {'name': 'mic1', 'description': 'Mic', 'media_class': 'Audio/Source'},
        ]
        result = WpMonitor.get_audio_nodes(mock_self)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]['name'], 'sink1')
        mock_self._nodes.clear.assert_not_called()
    """Tests for the audio media class filter."""

    def test_filter_accepts_audio_sink(self):
        from src.wp_monitor import _AUDIO_MEDIA_CLASSES
        self.assertIn('Audio/Sink', _AUDIO_MEDIA_CLASSES)

    def test_filter_accepts_audio_source(self):
        from src.wp_monitor import _AUDIO_MEDIA_CLASSES
        self.assertIn('Audio/Source', _AUDIO_MEDIA_CLASSES)

    def test_filter_accepts_audio_duplex(self):
        from src.wp_monitor import _AUDIO_MEDIA_CLASSES
        self.assertIn('Audio/Duplex', _AUDIO_MEDIA_CLASSES)

    def test_filter_rejects_video_sink(self):
        from src.wp_monitor import _AUDIO_MEDIA_CLASSES
        self.assertNotIn('Video/Sink', _AUDIO_MEDIA_CLASSES)

    def test_filter_is_frozenset(self):
        from src.wp_monitor import _AUDIO_MEDIA_CLASSES
        self.assertIsInstance(_AUDIO_MEDIA_CLASSES, frozenset)


if __name__ == '__main__':
    unittest.main()