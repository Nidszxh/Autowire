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
            profiles = json.load(fh).get('profiles', [])
    except (json.JSONDecodeError, IOError, KeyError):
        return []

    for p in profiles:
        if 'is_active' not in p:
            p['is_active'] = False

    return profiles


def get_profile(trigger_device_name: str, profile_name: str) -> dict | None:
    """Returns the profile matching *trigger_device_name* and *profile_name*, or None."""
    for p in load_profiles():
        if p.get('trigger_device_name') == trigger_device_name and p.get('profile_name') == profile_name:
            return p
    return None


def get_profiles_for_trigger(trigger_device_name: str) -> list[dict]:
    """Returns all profiles that have *trigger_device_name* as their trigger."""
    return [p for p in load_profiles() if p.get('trigger_device_name') == trigger_device_name]


def get_active_profile(trigger_device_name: str) -> dict | None:
    """Returns the active profile for *trigger_device_name*, or None."""
    for p in load_profiles():
        if p.get('trigger_device_name') == trigger_device_name and p.get('is_active'):
            return p
    return None


def set_active_profile(trigger_device_name: str, profile_name: str) -> None:
    """Sets the active profile for a trigger, deactivating all others."""
    profiles = load_profiles()
    for p in profiles:
        if p.get('trigger_device_name') == trigger_device_name:
            p['is_active'] = p.get('profile_name') == profile_name
    _write_atomic({'profiles': profiles})


def save_profile(
    profile_name: str,
    trigger_device: str,
    default_sink: str,
    default_source: str,
    bt_profile: str = '',
    is_active: bool = False,
) -> None:
    """Adds a new profile rule (allows multiple profiles per trigger device).

    Uniqueness is enforced on the (trigger_device_name, profile_name) pair.
    If a profile with the same name already exists for this trigger, it is
    replaced with the new values.

    When *is_active* is True, all other profiles for the same trigger are
    deactivated first to ensure only one active profile per trigger.
    """
    profiles = load_profiles()

    for i, p in enumerate(profiles):
        if p.get('trigger_device_name') == trigger_device and p.get('profile_name') == profile_name:
            profiles[i] = {
                'profile_name': profile_name,
                'trigger_device_name': trigger_device,
                'is_active': is_active,
                'actions': {
                    'default_sink': default_sink,
                    'default_source': default_source,
                    'bt_profile': bt_profile,
                },
            }
            if is_active:
                for j, other in enumerate(profiles):
                    if j != i and other.get('trigger_device_name') == trigger_device:
                        profiles[j]['is_active'] = False
            _write_atomic({'profiles': profiles})
            print(f'[Config] Updated profile: {profile_name!r} for {trigger_device!r}')
            return

    if is_active:
        for p in profiles:
            if p.get('trigger_device_name') == trigger_device:
                p['is_active'] = False

    profiles.append({
        'profile_name': profile_name,
        'trigger_device_name': trigger_device,
        'is_active': is_active,
        'actions': {
            'default_sink': default_sink,
            'default_source': default_source,
            'bt_profile': bt_profile,
        },
    })
    _write_atomic({'profiles': profiles})
    print(f'[Config] Saved profile: {profile_name!r} for {trigger_device!r}')


def delete_profile(trigger_device_name: str, profile_name: str) -> bool:
    """Removes the profile matching *trigger_device_name* and *profile_name*.
    
    Returns True if found and removed.
    """
    profiles = load_profiles()
    filtered = [
        p for p in profiles
        if not (p.get('trigger_device_name') == trigger_device_name and p.get('profile_name') == profile_name)
    ]
    if len(filtered) == len(profiles):
        return False
    _write_atomic({'profiles': filtered})
    print(f'[Config] Deleted profile: {profile_name!r} for {trigger_device_name!r}')
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
