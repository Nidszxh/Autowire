const { GLib, GObject } = imports.gi;

print('[WpMonitor] module loaded');

var WpMonitor = null;

function get_audio_nodes_sync() {
    return get_mock_nodes();
}

function get_mock_nodes() {
    print('[WpMonitor] Using mock audio nodes');
    return [
        { name: 'bluez_output.12_34_56_78_90_AB.a2dp-sink', description: 'WH-1000XM4', media_class: 'Audio/Sink' },
        { name: 'alsa_output.pci-0000_00_1f.3.analog-stereo', description: 'Built-in Audio Analog Stereo', media_class: 'Audio/Sink' },
        { name: 'bluez_input.12_34_56_78_90_AB.a2dp-sink', description: 'WH-1000XM4 Mic', media_class: 'Audio/Source' },
        { name: 'alsa_input.pci-0000_00_1f.3.analog-stereo', description: 'Built-in Microphone', media_class: 'Audio/Source' },
    ];
}