# Changelog

All notable changes to Autowire are documented here.

## [Unreleased]

### Added
- **`is_active` profile field** — each profile has an `is_active` boolean. Only one profile per trigger device can be active at a time. When saving with `is_active=True`, all sibling profiles for that trigger are automatically deactivated.
- **Multi-profile per trigger** — multiple profiles can now be defined for the same trigger device (e.g. "AAC for Music" and "HSP for Calls"). Uniqueness is enforced on the `(trigger_device_name, profile_name)` pair.
- **`active_row` SwitchRow** in `profile_dialog.blp` — "Activate on Connect" toggle in the profile create/edit dialog. Saving with it enabled marks the profile as active.
- **Star toggle in profile list** — on rows with multiple profiles for the same trigger, a toggle button (`emblem-ok-symbolic` when active, `pan-down-symbolic` when inactive) allows quick switching of the active profile without opening the dialog.
- **`emblem-ok-symbolic` indicator** — active profiles now show a checkmark icon in accent color in the main list view.
- **`config_mgr.get_active_profile(trigger)`** — returns the active profile for a given trigger, or None.
- **`config_mgr.set_active_profile(trigger, profile_name)`** — sets the active profile for a trigger, deactivating all siblings.
- **`config_mgr.get_profiles_for_trigger(trigger)`** — returns all profiles for a given trigger device.
- **Daemon startup routing** — on daemon startup, iterates all currently connected audio nodes via `monitor.get_audio_nodes()` and routes each one immediately, before entering the event loop.

### Changed
- **`config_mgr.load_profiles()`** now migrates old profiles (adds `is_active: false`).
- **`config_mgr.save_profile()`** signature extended with `is_active` parameter. When `is_active=True`, deactivates all sibling profiles for that trigger before saving.
- **`config_mgr.get_profile()`** now takes both `(trigger_device_name, profile_name)` as arguments.
- **`config_mgr.delete_profile()`** now takes both `(trigger_device_name, profile_name)` as arguments.
- **`daemon.check_and_route_device()`** now skips any profile where `is_active != True`. Only the active profile for a trigger fires.
- **`window.py` profile list** — profiles are now grouped by `trigger_device_name`, with each trigger as a separate `Adw.PreferencesGroup` with its name as the section title.
- **`profile_dialog.py`** — `_on_devices_loaded()` now schedules `_on_devices_loaded_idle()` via `GLib.idle_add()` to defer `_validate()` and `_prefill()` until after the combo model change has propagated, ensuring the `notify::selected` signal fires correctly.

### Fixed
- **`Adw.PreferencesGroup` title** — constructor `title=` argument is broken in GTK4. Now uses `set_title()` after construction instead.
- **`wp_monitor.py` module-level scope** — removed duplicate `_proxy_properties` function at module level that shadowed the class method, causing syntax errors. Refactored to a single module-level `_fetch_node_props()` with `_proxy_properties` as an exported alias.
- **`profile_dialog.py` missing `_on_combo_changed` body** — the signal handler method body was missing, breaking the save button enable/disable logic.
- **`config_mgr.load_profiles()` migration write-back** — was mutating the list but never writing it back to disk. Now calls `_write_atomic()` on migration.

### Documentation
- **AGENTS.md** — complete rewrite with precise architecture, module API summaries, daemon flow diagrams, and GTK4 quirks.
- **README.md** — updated features, test count (60), architecture diagram, project structure.
- **CONTRIBUTING.md** — updated test counts, project layout, added Profile Activation section, added profile config debug tip.
- **docs/architecture.md** — complete rewrite with current API signatures, multi-profile model, grouped UI description, and startup routing documentation.