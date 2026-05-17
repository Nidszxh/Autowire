"""AutowireWindow — main application window controller."""

from __future__ import annotations

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')

from gi.repository import Adw, Gtk

from . import config_mgr

RESOURCE_PATH = '/io/github/nidszxh/Autowire/window.ui'


@Gtk.Template(resource_path=RESOURCE_PATH)
class AutowireWindow(Adw.ApplicationWindow):
    __gtype_name__ = 'AutowireWindow'

    # Widgets bound from the Blueprint template
    add_button: Gtk.Button = Gtk.Template.Child()
    main_stack: Gtk.Stack = Gtk.Template.Child()
    profiles_page: Adw.PreferencesPage = Gtk.Template.Child()
    empty_add_button: Gtk.Button = Gtk.Template.Child()

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._profiles_group: Adw.PreferencesGroup | None = None
        self._connect_signals()
        self.refresh_profiles()

    # ── signal wiring ─────────────────────────────────────────────────────

    def _connect_signals(self) -> None:
        self.add_button.connect('clicked', self._on_add_clicked)
        self.empty_add_button.connect('clicked', self._on_add_clicked)

    # ── profile list ──────────────────────────────────────────────────────

    def refresh_profiles(self) -> None:
        """Reload all profiles from disk and repopulate the list."""
        if self._profiles_group is not None:
            self.profiles_page.remove(self._profiles_group)
            self._profiles_group = None

        profiles = config_mgr.load_profiles()

        if not profiles:
            self.main_stack.set_visible_child_name('empty')
            return

        self.main_stack.set_visible_child_name('profiles')

        group = Adw.PreferencesGroup(title='Audio Profiles')
        for profile in profiles:
            group.add(self._build_profile_row(profile))

        self.profiles_page.add(group)
        self._profiles_group = group

    def _build_profile_row(self, profile: dict) -> Adw.ActionRow:
        """Creates an ActionRow for a single profile entry."""
        trigger = profile.get('trigger_device_name', '')
        actions = profile.get('actions', {})
        subtitle_parts = []
        if actions.get('default_sink'):
            subtitle_parts.append(f"Out: {actions['default_sink'].split('.')[-1]}")
        if actions.get('default_source'):
            subtitle_parts.append(f"In: {actions['default_source'].split('.')[-1]}")

        row = Adw.ActionRow(
            title=profile.get('profile_name', 'Untitled'),
            subtitle=' · '.join(subtitle_parts) if subtitle_parts else trigger,
        )

        # Edit button
        edit_btn = Gtk.Button(
            icon_name='document-edit-symbolic',
            tooltip_text='Edit Profile',
            valign=Gtk.Align.CENTER,
        )
        edit_btn.add_css_class('flat')
        edit_btn.connect('clicked', self._on_edit_clicked, profile)
        row.add_suffix(edit_btn)

        # Delete button
        del_btn = Gtk.Button(
            icon_name='user-trash-symbolic',
            tooltip_text='Delete Profile',
            valign=Gtk.Align.CENTER,
        )
        del_btn.add_css_class('flat')
        del_btn.add_css_class('destructive-action')
        del_btn.connect('clicked', self._on_delete_clicked, profile)
        row.add_suffix(del_btn)

        row.set_activatable_widget(edit_btn)
        return row

    # ── event handlers ────────────────────────────────────────────────────

    def _on_add_clicked(self, _btn: Gtk.Button) -> None:
        from .profile_dialog import ProfileDialog
        dialog = ProfileDialog()
        dialog.connect('profile-saved', lambda _d: self.refresh_profiles())
        dialog.present(self)

    def _on_edit_clicked(self, _btn: Gtk.Button, profile: dict) -> None:
        from .profile_dialog import ProfileDialog
        dialog = ProfileDialog(profile=profile)
        dialog.connect('profile-saved', lambda _d: self.refresh_profiles())
        dialog.present(self)

    def _on_delete_clicked(self, _btn: Gtk.Button, profile: dict) -> None:
        trigger = profile.get('trigger_device_name', '')
        if not trigger:
            return

        # Confirm via an Adw.AlertDialog before deleting
        alert = Adw.AlertDialog(
            heading='Delete Profile?',
            body=f'"{profile.get("profile_name", "")}" will be permanently removed.',
        )
        alert.add_response('cancel', 'Cancel')
        alert.add_response('delete', 'Delete')
        alert.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE)
        alert.set_default_response('cancel')
        alert.set_close_response('cancel')

        def _on_response(_alert: Adw.AlertDialog, response: str) -> None:
            if response == 'delete':
                config_mgr.delete_profile(trigger)
                self.refresh_profiles()

        alert.connect('response', _on_response)
        alert.present(self)
