"""Native file drag source for the isolated Linux engine fixture."""
import pathlib
import sys
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, Gtk

uri = pathlib.Path(sys.argv[1]).resolve(strict=True).as_uri()
window = Gtk.Window(title='Capabilities file source')
window.set_default_size(160, 80)
window.move(1110, 100)
button = Gtk.Button(label='Drag fixture file')
button.drag_source_set(Gdk.ModifierType.BUTTON1_MASK,
                       [Gtk.TargetEntry.new('text/uri-list', 0, 0)], Gdk.DragAction.COPY)
button.connect('drag-begin', lambda *_: print('drag-begin', flush=True))
button.connect('drag-end', lambda *_: print('drag-end', flush=True))
button.connect('drag-failed', lambda _button, _context, result: print('drag-failed', result.value_nick, flush=True) or False)
def provide(_button, _context, data, _info, _time):
    data.set_uris([uri])
    print('drag-data-get', data.get_target().name(), bytes(data.get_data()), flush=True)
button.connect('drag-data-get', provide)
window.add(button)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
