//! The setup's window: one task dialog whose pages follow each other, as Windows' own setups
//! look. Install (with "Create a desktop shortcut"), "is running" when a copy runs from the
//! install, Installing with a marquee while a thread installs, then Installed (with "Launch")
//! or what went wrong.

use std::path::Path;
use std::sync::{Arc, Mutex};

use codenomad_windows_install::Product;
use windows_sys::Win32::Foundation::{HWND, LPARAM, S_FALSE, S_OK, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{
    TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TD_ERROR_ICON, TDCBF_CANCEL_BUTTON, TDCBF_CLOSE_BUTTON,
    TDF_ALLOW_DIALOG_CANCELLATION, TDF_CALLBACK_TIMER, TDF_SHOW_MARQUEE_PROGRESS_BAR,
    TDF_VERIFICATION_FLAG_CHECKED, TDM_ENABLE_BUTTON, TDM_NAVIGATE_PAGE,
    TDM_SET_PROGRESS_BAR_MARQUEE, TDN_BUTTON_CLICKED, TDN_NAVIGATED, TDN_TIMER,
    TDN_VERIFICATION_CLICKED, TaskDialogIndirect,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{IDCANCEL, SendMessageW};
use windows_sys::core::{BOOL, HRESULT, PCWSTR};

use crate::install::{self, Args};

const INSTALL: i32 = 100;
const CLOSE_AND_INSTALL: i32 = 101;
const FINISH: i32 = 102;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Welcome,
    Running,
    Installing,
    Done,
    Failed,
}

/// One page: its config, and the strings and buttons it points at.
struct Page {
    config: TASKDIALOGCONFIG,
    _strings: Vec<Vec<u16>>,
    _buttons: Vec<TASKDIALOG_BUTTON>,
}

#[derive(Default)]
struct Text<'a> {
    instruction: &'a str,
    content: &'a str,
    footer: &'a str,
    verification: &'a str,
}

fn page(
    p: &Product,
    text: Text,
    buttons: &[(i32, &str)],
    common: i32,
    flags: i32,
    error: bool,
) -> Page {
    let mut strings = Vec::new();
    let mut keep = |s: &str| -> PCWSTR {
        if s.is_empty() {
            return std::ptr::null();
        }
        let wide: Vec<u16> = s.encode_utf16().chain(Some(0)).collect();
        let ptr = wide.as_ptr();
        strings.push(wide);
        ptr
    };
    let title = keep(&format!("{} Setup", p.name));
    let (instruction, content, footer, verification) = (
        keep(text.instruction),
        keep(text.content),
        keep(text.footer),
        keep(text.verification),
    );
    let buttons: Vec<TASKDIALOG_BUTTON> = buttons
        .iter()
        .map(|&(id, label)| TASKDIALOG_BUTTON {
            nButtonID: id,
            pszButtonText: keep(label),
        })
        .collect();
    // SAFETY: a zeroed config is the documented default for every field not set below.
    let mut config: TASKDIALOGCONFIG = unsafe { std::mem::zeroed() };
    config.cbSize = std::mem::size_of::<TASKDIALOGCONFIG>() as u32;
    // SAFETY: this executable's module, whose icon resource 1 is the application's icon.
    config.hInstance = unsafe { GetModuleHandleW(std::ptr::null()) };
    config.dwFlags = flags;
    config.dwCommonButtons = common;
    config.pszWindowTitle = title;
    // MAKEINTRESOURCE(1): the exe's icon.
    config.Anonymous1.pszMainIcon = if error {
        TD_ERROR_ICON
    } else {
        std::ptr::without_provenance(1)
    };
    config.pszMainInstruction = instruction;
    config.pszContent = content;
    config.pszFooter = footer;
    config.pszVerificationText = verification;
    config.cButtons = buttons.len() as u32;
    config.pButtons = buttons.as_ptr();
    config.nDefaultButton = buttons.first().map_or(0, |b| b.nButtonID);
    config.pfCallback = Some(callback);
    Page {
        config,
        _strings: strings,
        _buttons: buttons,
    }
}

struct Wizard<'a> {
    p: &'a Product,
    root: &'a Path,
    args: &'a Args,
    stage: Stage,
    desktop: bool,
    launch: bool,
    result: Arc<Mutex<Option<Result<(), String>>>>,
    pages: Vec<(Stage, Page)>,
}

/// What a notification asks of the dialog once the wizard's state is updated.
enum Next {
    /// Nothing more; the value answers the notification (`S_FALSE` keeps the dialog open).
    Answer(HRESULT),
    Go(Stage, HRESULT),
    /// The Installing page is up: start its marquee and grey out Cancel.
    Marquee,
}

impl Wizard<'_> {
    fn on(&mut self, msg: i32, wparam: WPARAM) -> Next {
        match msg {
            TDN_VERIFICATION_CLICKED => match self.stage {
                Stage::Welcome => self.desktop = wparam != 0,
                Stage::Done => self.launch = wparam != 0,
                _ => {}
            },
            TDN_BUTTON_CLICKED => match (self.stage, wparam as i32) {
                (Stage::Welcome, INSTALL) if install::running(self.root) => {
                    return Next::Go(Stage::Running, S_FALSE);
                }
                (Stage::Welcome, INSTALL) | (Stage::Running, CLOSE_AND_INSTALL) => {
                    return Next::Go(Stage::Installing, S_FALSE);
                }
                // Nothing stops an install halfway.
                (Stage::Installing, _) => return Next::Answer(S_FALSE),
                _ => {}
            },
            TDN_NAVIGATED if self.stage == Stage::Installing => {
                self.start();
                return Next::Marquee;
            }
            TDN_TIMER if self.stage == Stage::Installing => {
                let done = self.result.lock().unwrap_or_else(|e| e.into_inner()).take();
                match done {
                    Some(Ok(())) => {
                        self.launch = true;
                        return Next::Go(Stage::Done, S_OK);
                    }
                    Some(Err(e)) => {
                        self.failed(&e);
                        return Next::Go(Stage::Failed, S_OK);
                    }
                    None => {}
                }
            }
            _ => {}
        }
        Next::Answer(S_OK)
    }

    /// Installs on a thread of its own; the page's timer picks up the result.
    fn start(&self) {
        let (p, root, desktop, result) = (
            self.p.clone(),
            self.root.to_path_buf(),
            self.desktop,
            self.result.clone(),
        );
        let args = Args {
            log: self.args.log.clone(),
            ..Args::default()
        };
        std::thread::spawn(move || {
            let done = install::install(&p, &root, desktop, &|line| args.log(line));
            if let Err(e) = &done {
                args.log(&format!("couldn't install: {e}"));
            }
            *result.lock().unwrap_or_else(|e| e.into_inner()) = Some(done);
        });
    }

    fn failed(&mut self, error: &str) {
        let text = Text {
            instruction: &format!("Couldn't install {}", self.p.name),
            content: error,
            ..Text::default()
        };
        let failed = page(
            self.p,
            text,
            &[],
            TDCBF_CLOSE_BUTTON,
            TDF_ALLOW_DIALOG_CANCELLATION,
            true,
        );
        self.pages.retain(|(s, _)| *s != Stage::Failed);
        self.pages.push((Stage::Failed, failed));
    }
}

/// Shows `stage`'s page. The dialog calls back into [`callback`] before `SendMessageW` returns,
/// so no reference to the wizard is alive across it: the page's config is taken as a pointer.
///
/// # Safety
/// `wizard` is the live `Wizard` of the dialog `hwnd`, and no reference to it exists.
unsafe fn navigate(wizard: *mut Wizard, hwnd: HWND, stage: Stage) {
    // SAFETY: the caller's contract; the reference ends with this block.
    let config = unsafe {
        let w = &mut *wizard;
        w.stage = stage;
        let Some((_, page)) = w.pages.iter_mut().find(|(s, _)| *s == stage) else {
            return;
        };
        page.config.lpCallbackData = wizard as isize;
        &raw const page.config
    };
    // SAFETY: the page's config, and everything it points at, lives in the wizard's pages for
    // the rest of the dialog.
    unsafe { SendMessageW(hwnd, TDM_NAVIGATE_PAGE as u32, 0, config as LPARAM) };
}

unsafe extern "system" fn callback(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    _: LPARAM,
    data: isize,
) -> HRESULT {
    let wizard = data as *mut Wizard;
    if wizard.is_null() {
        return S_OK;
    }
    // SAFETY: `data` is the `Wizard` `run` passed, alive while its modal dialog runs; this
    // reference ends before any message is sent to the dialog.
    let next = unsafe { (*wizard).on(msg as i32, wparam) };
    match next {
        Next::Answer(answer) => answer,
        Next::Go(stage, answer) => {
            // SAFETY: the wizard of this dialog, with no reference to it alive.
            unsafe { navigate(wizard, hwnd, stage) };
            answer
        }
        Next::Marquee => {
            // SAFETY: messages to the dialog that sent this notification.
            unsafe {
                SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_MARQUEE as u32, 1, 0);
                SendMessageW(hwnd, TDM_ENABLE_BUTTON as u32, IDCANCEL as WPARAM, 0);
            }
            S_OK
        }
    }
}
/// Runs the pages; the exit code is 0 once installed, 1 when it failed, 2 when cancelled.
pub fn run(p: &Product, root: &Path, args: &Args) -> i32 {
    let name = &p.name;
    let welcome = page(
        p,
        Text {
            instruction: &format!("Install {name}"),
            content: &format!(
                "Version {}, for your Windows account only. No administrator rights needed.",
                p.version
            ),
            footer: &format!("Installs in {}", root.display()),
            verification: "Create a desktop shortcut",
        },
        &[(INSTALL, "Install")],
        TDCBF_CANCEL_BUTTON,
        TDF_ALLOW_DIALOG_CANCELLATION | TDF_VERIFICATION_FLAG_CHECKED,
        false,
    );
    let running = page(
        p,
        Text {
            instruction: &format!("{name} is running"),
            content: "Setup closes it to install this version.",
            ..Text::default()
        },
        &[(CLOSE_AND_INSTALL, "Close and install")],
        TDCBF_CANCEL_BUTTON,
        TDF_ALLOW_DIALOG_CANCELLATION,
        false,
    );
    let installing = page(
        p,
        Text {
            instruction: &format!("Installing {name}"),
            content: "This takes a few seconds.",
            ..Text::default()
        },
        &[],
        TDCBF_CANCEL_BUTTON,
        TDF_SHOW_MARQUEE_PROGRESS_BAR | TDF_CALLBACK_TIMER,
        false,
    );
    let done = page(
        p,
        Text {
            instruction: &format!("{name} is installed"),
            content: "Find it in the Start menu.",
            verification: &format!("Launch {name}"),
            ..Text::default()
        },
        &[(FINISH, "Finish")],
        0,
        TDF_ALLOW_DIALOG_CANCELLATION | TDF_VERIFICATION_FLAG_CHECKED,
        false,
    );
    let mut wizard = Wizard {
        p,
        root,
        args,
        stage: Stage::Welcome,
        desktop: true,
        launch: false,
        result: Arc::default(),
        pages: vec![
            (Stage::Welcome, welcome),
            (Stage::Running, running),
            (Stage::Installing, installing),
            (Stage::Done, done),
        ],
    };
    let me = &mut wizard as *mut Wizard as isize;
    let mut first = wizard.pages[0].1.config;
    first.lpCallbackData = me;
    let mut verified: BOOL = 0;
    // SAFETY: the config and the wizard it hands the callback outlive the modal call.
    unsafe {
        TaskDialogIndirect(
            &first,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut verified,
        )
    };
    match wizard.stage {
        Stage::Done if wizard.launch => install::launch(root, args),
        Stage::Done => 0,
        Stage::Failed => 1,
        _ => 2,
    }
}
