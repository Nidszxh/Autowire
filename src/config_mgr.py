"""Profile storage for Autowire.

Profiles are persisted at $XDG_CONFIG_HOME/autowire/profiles.json
(defaults to ~/.config/autowire/profiles.json).

All writes are atomic: a temp file is written first, then renamed over the
target so a crash mid-write never corrupts an existing config.
"""

import json
import os
import tempfile

_XDG_CONFIG_HOME = os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config'))
CONFIG_DIR = os.path.join(_XDG_CONFIG_HOME, 'autowire')
CONFIG_FILE = os.path.join(CONFIG_DIR, 'profiles.json')


def initialize_config() -> None:
    """Creates the config directory and an empty profiles file if absent."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_FILE):
        _write_atomic({'profiles': []})


def load_profiles() -> list[dict]:
    """Returns the list of all saved profile dicts, or [] on any error."""
    initialize_config()
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as fh:
            return json.load(fh).get('profiles', [])
    except (json.JSONDecodeError, IOError, KeyError):
        return []


def get_profile(trigger_device_name: str) -> dict | None:
    """Returns the profile matching *trigger_device_name*, or None."""
    for p in load_profiles():
        if p.get('trigger_device_name') == trigger_device_name:
            return p
    return None


def save_profile(
    profile_name: str,
    trigger_device: str,
    default_sink: str,
    default_source: str,
    bt_profile: str = '',
) -> None:
    """Inserts or updates a profile rule, then persists atomically.

    *bt_profile* is the Bluetooth profile name (e.g. ``a2dp-sink-aac``)
    to switch to when the trigger device connects.  An empty string means
    "don't touch the BT profile".
    """
    profiles = load_profiles()

    for p in profiles:
        if p['trigger_device_name'] == trigger_device:
            p['profile_name'] = profile_name
            p['actions']['default_sink'] = default_sink
            p['actions']['default_source'] = default_source
            p['actions']['bt_profile'] = bt_profile
            break
    else:
        profiles.append({
            'profile_name': profile_name,
            'trigger_device_name': trigger_device,
            'actions': {
                'default_sink': default_sink,
                'default_source': default_source,
                'bt_profile': bt_profile,
            },
        })

    _write_atomic({'profiles': profiles})
    print(f'[Config] Saved profile: {profile_name!r}')


def delete_profile(trigger_device_name: str) -> bool:
    """Removes the profile for *trigger_device_name*. Returns True if found."""
    profiles = load_profiles()
    filtered = [p for p in profiles if p['trigger_device_name'] != trigger_device_name]
    if len(filtered) == len(profiles):
        return False
    _write_atomic({'profiles': filtered})
    print(f'[Config] Deleted profile for trigger: {trigger_device_name!r}')
    return True


def _write_atomic(data: dict) -> None:
    """Writes *data* as JSON to CONFIG_FILE via a temp-file rename."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=CONFIG_DIR, prefix='.profiles_', suffix='.json')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp_path, CONFIG_FILE)
    except Exception:
        # Clean up the temp file if the write failed
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
