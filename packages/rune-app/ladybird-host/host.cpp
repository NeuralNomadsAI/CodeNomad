#include <AK/Base64.h>
#include <AK/JsonArray.h>
#include <AK/JsonObject.h>
#include <AK/LexicalPath.h>
#include <AK/Utf8View.h>
#include <LibCore/EventLoop.h>
#include <LibCore/Promise.h>
#include <LibGfx/ImageFormats/PNGWriter.h>
#include <LibGfx/ShareableBitmap.h>
#include <LibGfx/SystemTheme.h>
#include <LibIPC/File.h>
#include <LibMain/Main.h>
#include <LibURL/Parser.h>
#include <LibWebCommon/WebView/AccessibilityNodeData.h>
#include <LibWebView/Application.h>
#include <LibWebView/HeadlessWebView.h>
#include <LibWebView/PageBackingStores.h>
#include <LibWebView/Utilities.h>
#include <LibWebView/WebContentPage.h>
#include <AK/Windows.h>
#include <cstdio>
#include <thread>

struct Member { StringView name; JsonValue value; };

static JsonObject object(std::initializer_list<Member> fields)
{
    JsonObject result;
    for (auto const& [name, value] : fields)
        result.set(name, value);
    return result;
}

static void send(std::initializer_list<Member> fields)
{
    auto line = object(fields).serialized();
    fprintf(stdout, "LADYBIRD:%s\n", line.to_byte_string().characters());
    fflush(stdout);
}

class PreviewApplication final : public WebView::Application {
    WEB_VIEW_APPLICATION(PreviewApplication)
    bool should_coordinate_browser_process() const override { return false; }
    ErrorOr<LexicalPath> default_path_for_downloaded_file(ByteString const&) const override
    {
        return Error::from_string_literal("Downloads are disabled in the Rune preview");
    }
    NonnullRefPtr<Core::Promise<ByteString>> ask_user_for_download_path(ByteString const&) const override
    {
        auto result = Core::Promise<ByteString>::construct();
        result->reject(Error::from_string_literal("Downloads are disabled in the Rune preview"));
        return result;
    }
};

class PreviewView final : public WebView::HeadlessWebView {
public:
    explicit PreviewView(Core::AnonymousBuffer theme)
        : HeadlessWebView(move(theme), { 640, 480 }, WebView::IsPrivate::Yes)
    {
        on_new_web_view = [](auto, auto, auto&) { return String {}; };
        on_request_alert = [this](auto const&) { alert_closed(); };
        on_request_confirm = [this](auto const&) { confirm_closed(false); };
        on_request_prompt = [this](auto const&, auto const&) { prompt_closed({}); };
        on_request_file_picker = [this](auto const&, auto) { file_picker_closed({}); };
        initialize_tab(Web::HTML::VisibilityState::Visible);
        on_load_start = [this] {
            ++m_epoch;
            m_loaded = false;
            state();
        };
        on_load_finish = [this](URL::URL const& url) {
            m_url = url.serialize();
            m_loaded = true;
            state();
        };
        on_accessibility_tree_received = [this](u64, Vector<WebView::AccessibilityNodeData> nodes) {
            if (!m_ax_request.has_value())
                return;
            auto request = m_ax_request.release_value();
            if (request.epoch != m_epoch) {
                fail(request.id, "Browser document changed"sv);
                return;
            }
            JsonArray tree;
            for (auto const& node : nodes) {
                if (tree.size() == 2048)
                    break;
                if (tree.append(object({
                    { "node"sv, node.id }, { "parent"sv, node.parent_id },
                    { "role"sv, node.role }, { "name"sv, node.name },
                    { "description"sv, node.description }, { "value"sv, node.value },
                    { "x"sv, node.bounds.x() }, { "y"sv, node.bounds.y() },
                    { "w"sv, node.bounds.width() }, { "h"sv, node.bounds.height() },
                    { "focused"sv, node.is_focused }, { "disabled"sv, node.is_disabled },
                    { "editable"sv, node.is_editable }, { "readonly"sv, node.is_read_only },
                    { "password"sv, node.is_password },
                })).is_error())
                    break;
            }
            reply(request.id, { { "tree"sv, move(tree) } });
        };
        on_web_content_crashed = [](auto) { Core::EventLoop::current().quit(3); };
        on_preview_hit_test = [this](u64 id, Web::UniqueNodeID node) {
            auto hit = m_hit_request;
            if (!hit.has_value() || hit->id != id)
                return;
            m_hit_request.clear();
            if (hit->epoch != m_epoch) {
                fail(id, "Browser document changed"sv);
                return;
            }
            reply(id, { { "hit"sv, static_cast<i64>(node.value()) } });
        };
    }

    void command(JsonObject const& message)
    {
        auto string = [&](StringView key) -> String {
            return message.get_string(key).map([](auto const& value) { return value; }).value_or({});
        };
        auto number = [&](StringView key) { return message.get_double_with_precision_loss(key).value_or(0); };
        auto flag = [&](StringView key) { return message.get_bool(key).value_or(false); };
        auto op = string("op"sv);
        if (auto epoch = message.get_u64("epoch"sv); epoch.has_value()) {
            if (!current(*epoch, message.get_u64("deadline"sv).value_or(0))) {
                if (auto id = message.get_u64("id"sv); id.has_value())
                    fail(*id, "Browser document changed or command expired"sv);
                return;
            }
        }
        if (op == "resize"sv) {
            auto w = number("w"sv), h = number("h"sv), dpi = number("dpi"sv);
            if (w > 0 && h > 0 && w <= 2560 && h <= 2560 && dpi >= 1 && dpi <= 4) {
                m_device_pixel_ratio = dpi;
                reset_viewport_size({ static_cast<int>(w), static_cast<int>(h) });
            }
        } else if (op == "navigate"sv || op == "reload"sv) {
            m_generation = message.get_u64("generation"sv).value_or(0);
            m_loaded = false;
            state();
            if (op == "reload"sv) {
                reload();
            } else {
                auto url = URL::Parser::basic_parse(string("url"sv));
                if (url.has_value())
                    load_from_browser_ui(*url);
            }
        } else if (op == "release"sv) {
            auto token = message.get_u64("frame"sv);
            if (token.has_value())
                release(*token);
        } else if (op == "focus"sv) {
            set_has_system_focus(flag("focused"sv));
        } else if (op == "move"sv || op == "pointer"sv || op == "wheel"sv || op == "click"sv) {
            auto down = flag("down"sv);
            bool click = op == "pointer"sv;
            auto button = string("button"sv) == "right"sv ? Web::UIEvents::MouseButton::Secondary : Web::UIEvents::MouseButton::Primary;
            if (click)
                m_buttons = down ? button : Web::UIEvents::MouseButton::None;
            Web::DevicePixelPoint point { static_cast<int>(number("x"sv)), static_cast<int>(number("y"sv)) };
            auto dx = number("dx"sv), dy = number("dy"sv);
            auto event = Web::MouseEvent {
                .type = click ? (down ? Web::MouseEvent::Type::MouseDown : Web::MouseEvent::Type::MouseUp)
                              : (op == "move"sv ? Web::MouseEvent::Type::MouseMove : Web::MouseEvent::Type::MouseWheel),
                .position = point,
                .screen_position = point,
                .button = click ? button : Web::UIEvents::MouseButton::None,
                .buttons = m_buttons,
                .wheel_delta_x = dx, .wheel_delta_y = dy,
                .wheel_tick_120ths_x = dx, .wheel_tick_120ths_y = dy,
                .click_count = click ? 1 : 0,
            };
            if (op == "click"sv) {
                set_has_system_focus(true);
                event.type = Web::MouseEvent::Type::MouseDown;
                event.button = event.buttons = button;
                event.click_count = 1;
                enqueue_input_event(event.clone_without_browser_data());
                event.type = Web::MouseEvent::Type::MouseUp;
                event.buttons = Web::UIEvents::MouseButton::None;
            }
            enqueue_input_event(move(event));
            if (auto id = message.get_u64("id"sv); id.has_value())
                reply(*id, { { "dispatched"sv, true } });
        } else if (op == "key"sv || op == "press"sv) {
            auto modifiers = (flag("alt"sv) ? Web::UIEvents::Mod_Alt : 0)
                | (flag("ctrl"sv) ? Web::UIEvents::Mod_Ctrl : 0)
                | (flag("shift"sv) ? Web::UIEvents::Mod_Shift : 0)
                | (flag("meta"sv) ? Web::UIEvents::Mod_Super : 0);
            if (op == "press"sv) {
                set_has_system_focus(true);
                key(string("key"sv), true, modifiers, false);
                key(string("key"sv), false, modifiers, false);
            } else {
                key(string("key"sv), flag("down"sv), modifiers, flag("repeat"sv));
            }
            if (auto id = message.get_u64("id"sv); id.has_value())
                reply(*id, { { "dispatched"sv, true } });
        } else if (op == "ime"sv) {
            auto text = Utf16String::from_utf8(string("text"sv));
            auto phase = string("phase"sv);
            if (phase == "update"sv || phase == "cancel"sv)
                set_marked_text_from_input_method(text);
            if (phase == "end"sv) {
                if (text.is_empty())
                    unmark_text_from_input_method();
                else
                    commit_text_from_input_method(text);
            }
        } else if (op == "ax"sv || op == "shot"sv || op == "ax-focus"sv || op == "hit"sv || op == "text"sv) {
            auto id = message.get_u64("id"sv).value_or(0);
            if (!m_loaded || message.get_u64("epoch"sv) != m_epoch) {
                fail(id, "Browser document changed"sv);
                return;
            }
            if (op == "ax"sv) {
                m_ax_request = AxRequest { id, m_epoch };
                request_accessibility_tree();
            } else if (op == "shot"sv) {
                screenshot(id);
            } else if (op == "hit"sv) {
                m_hit_request = AxRequest { id, m_epoch };
                page().async_get_node_id_at_position((1ULL << 63) | id,
                    { static_cast<int>(number("x"sv)), static_cast<int>(number("y"sv)) });
            } else if (op == "text"sv) {
                auto node = message.get_i64("node"sv).value_or(-1);
                auto previous = string("previous"sv);
                auto length = static_cast<i32>(Utf8View { previous.bytes_as_string_view() }.length());
                auto text = string("text"sv);
                // LibWeb drives the focused form's native editor: normal insertText, not IME preedit.
                auto operation = text.is_empty() ? "delete_text"_string : "insert_text"_string;
                perform_accessibility_text_action(node, move(operation), flag("clear"sv) ? 0 : length, length, move(text));
                reply(id, {});
            } else {
                auto node = message.get_i64("node"sv).value_or(-1);
                set_has_system_focus(true);
                perform_accessibility_action(node, "focus"_string);
                reply(id, {});
            }
        }
    }

private:
    ViewImplementation* create_view_for_new_tab_or_window(WebView::IsPrivate) override { return nullptr; }
    struct Loan {
        u64 id;
        i32 bitmap;
        RefPtr<WebView::WebContentPage> page;
        IPC::File handle;
        bool superseded { false };
        bool returned { false };
    };
    struct AxRequest { u64 id; u64 epoch; };

    bool current(u64 epoch, u64 deadline) const
    {
        FILETIME ft;
        GetSystemTimePreciseAsFileTime(&ft);
        auto now = ((static_cast<u64>(ft.dwHighDateTime) << 32 | ft.dwLowDateTime) - 116444736000000000ULL) / 10'000;
        return epoch == m_epoch && m_loaded && deadline > now;
    }

    void did_accept_presented_backing_store(i32 bitmap_id, Gfx::IntRect) override
    {
        m_loans.remove_all_matching([&](auto& loan) {
            if (loan.page.ptr() != &page() || loan.bitmap != bitmap_id)
                loan.superseded = true;
            if (!loan.returned || !loan.superseded)
                return false;
            loan.page->release_presented_bitmap(loan.bitmap);
            return true;
        });
        if (m_loans.size() >= 128) {
            Core::EventLoop::current().quit(4);
            return;
        }
        auto frame = backing_stores().displayed_frame();
        if (!frame.has_value() || !frame->shared_image_buffer)
            return;
        auto const* source = frame->shared_image_buffer->windows_d3d_handle();
        if (!source) {
            if (!m_reported_cpu) {
                m_reported_cpu = true;
                send({ { "error"sv, "Ladybird compositor supplied a bitmap instead of D3D12"sv } });
            }
            return;
        }
        // The backing-store handle may disappear during resize before Rune reads the pipe.
        auto local = IPC::File::clone_fd(source->file.fd());
        if (local.is_error())
            return;
        auto token = ++m_serial;
        auto owner = local.release_value();
        auto handle = reinterpret_cast<uintptr_t>(to_handle(owner.fd()));
        m_loans.append({ token, bitmap_id, &page(), move(owner) });
        LARGE_INTEGER timestamp;
        QueryPerformanceCounter(&timestamp);
        send({
            { "frame"sv, token }, { "generation"sv, m_generation }, { "epoch"sv, m_epoch },
            { "w"sv, frame->size.width() }, { "h"sv, frame->size.height() },
            { "resource_w"sv, source->size.width() }, { "resource_h"sv, source->size.height() },
            { "dpi"sv, frame->device_pixel_ratio }, { "handle"sv, static_cast<u64>(handle) },
            { "qpc"sv, static_cast<u64>(timestamp.QuadPart) },
        });
    }

    void release_backing_store(i32 bitmap) override
    {
        for (size_t i = 0; i < m_loans.size(); ++i) {
            auto& loan = m_loans[i];
            if (loan.bitmap != bitmap || loan.page.ptr() != &page())
                continue;
            loan.superseded = true;
            if (loan.returned) {
                loan.page->release_presented_bitmap(bitmap);
                m_loans.remove(i);
            }
            return;
        }
        HeadlessWebView::release_backing_store(bitmap);
    }

    void release(u64 id)
    {
        for (size_t i = 0; i < m_loans.size(); ++i) {
            auto& loan = m_loans[i];
            if (loan.id != id)
                continue;
            loan.returned = true;
            if (loan.superseded || loan.page.ptr() != &page()) {
                loan.page->release_presented_bitmap(loan.bitmap);
                m_loans.remove(i);
            }
            return;
        }
    }

    void state() const
    {
        send({ { "generation"sv, m_generation }, { "epoch"sv, m_epoch }, { "ready"sv, m_loaded }, { "url"sv, m_url } });
    }

    static void reply(u64 id, std::initializer_list<Member> result) { send({ { "id"sv, id }, { "result"sv, object(result) } }); }
    static void fail(u64 id, StringView why) { reply(id, { { "error"sv, why } }); }

    void screenshot(u64 id)
    {
        take_frame_snapshot([this, id, epoch = m_epoch](Optional<Gfx::ShareableBitmap> bitmap) {
            if (epoch != m_epoch || !bitmap.has_value() || !bitmap->bitmap()) {
                fail(id, "Browser frame unavailable"sv);
                return;
            }
            auto png = Gfx::PNGWriter::encode(*bitmap->bitmap());
            if (png.is_error() || png.value().size() > 3 * 1024 * 1024) {
                fail(id, "Browser screenshot exceeds budget"sv);
                return;
            }
            auto data = encode_base64(png.value().bytes());
            if (data.is_error()) {
                fail(id, "Browser screenshot encoding failed"sv);
                return;
            }
            reply(id, { { "png"sv, data.release_value() } });
        });
    }

    void key(String const& name, bool down, unsigned modifiers, bool repeat)
    {
        using Web::UIEvents::KeyCode;
        auto raw = name.bytes_as_string_view();
        auto code = KeyCode::Key_Invalid;
        u32 cp = 0;
        if (raw == "Enter"sv) code = KeyCode::Key_Return;
        else if (raw == "Tab"sv) code = KeyCode::Key_Tab;
        else if (raw == "Backspace"sv) code = KeyCode::Key_Backspace;
        else if (raw == "Delete"sv) code = KeyCode::Key_Delete;
        else if (raw == "ArrowLeft"sv) code = KeyCode::Key_Left;
        else if (raw == "ArrowRight"sv) code = KeyCode::Key_Right;
        else if (raw == "ArrowUp"sv) code = KeyCode::Key_Up;
        else if (raw == "ArrowDown"sv) code = KeyCode::Key_Down;
        else if (raw == "Home"sv) code = KeyCode::Key_Home;
        else if (raw == "End"sv) code = KeyCode::Key_End;
        else if (raw == "PageUp"sv) code = KeyCode::Key_PageUp;
        else if (raw == "PageDown"sv) code = KeyCode::Key_PageDown;
        else if (raw == "Escape"sv) code = KeyCode::Key_Escape;
        else {
            Utf8View chars { raw };
            if (chars.length() == 1) {
                cp = *chars.begin();
                if (cp >= 'a' && cp <= 'z') code = static_cast<KeyCode>(cp - 'a' + 'A');
                else if ((cp >= 'A' && cp <= 'Z') || (cp >= '0' && cp <= '9') || cp == ' ')
                    code = static_cast<KeyCode>(cp);
            }
        }
        enqueue_input_event(Web::KeyEvent {
            .type = down ? Web::KeyEvent::Type::KeyDown : Web::KeyEvent::Type::KeyUp,
            .key = code,
            .modifiers = static_cast<Web::UIEvents::KeyModifier>(modifiers),
            .code_point = cp,
            .repeat = repeat,
            .should_insert_text = cp != 0 && !(modifiers & (Web::UIEvents::Mod_Ctrl | Web::UIEvents::Mod_Super)),
        });
    }

    Vector<Loan> m_loans;
    Optional<AxRequest> m_ax_request;
    Optional<AxRequest> m_hit_request;
    u64 m_generation { 0 };
    u64 m_epoch { 0 };
    u64 m_serial { 0 };
    bool m_loaded { false };
    bool m_reported_cpu { false };
    String m_url;
    Web::UIEvents::MouseButton m_buttons { Web::UIEvents::MouseButton::None };
};

ErrorOr<int> ladybird_main(Main::Arguments arguments)
{
    auto app = TRY(PreviewApplication::create(arguments));
    auto path = LexicalPath::join(WebView::s_ladybird_resource_root, "themes"sv, "Default.ini"sv);
    PreviewView view(TRY(Gfx::load_system_theme(path.string())));
    auto& loop = Core::EventLoop::current();
    auto weak = loop.current_weak();
    std::thread commands([weak, &view] {
        char line[65536];
        while (fgets(line, sizeof(line), stdin)) {
            StringView input { line, strlen(line) };
            if (!input.ends_with('\n'))
                break;
            auto parsed = JsonValue::from_string(input);
            if (parsed.is_error() || !parsed.value().is_object())
                break;
            if (auto owner = weak->take())
                owner->deferred_invoke([&view, value = parsed.release_value()] { view.command(value.as_object()); });
        }
        if (auto owner = weak->take())
            owner->deferred_invoke([] { Core::EventLoop::current().quit(0); });
    });
    // Rune owns the process job and can close the command pipe even after a renderer error.
    auto status = loop.exec();
    if (status != 0)
        ExitProcess(status);
    commands.join();
    return status;
}
