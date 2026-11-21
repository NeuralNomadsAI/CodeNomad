//! In-host automation (`packages/server-rs/docs/automation.md`, option B): the page engine of the
//! `codenomad.inspect`/`act`/`screenshot`/`browser` tools, driving pages this host owns in process.
pub(crate) mod input;
pub(crate) mod keys;
pub(crate) mod page;
pub(crate) mod refs;
pub(crate) mod snapshot;
#[cfg(windows)]
pub(crate) mod window;
#[cfg(windows)]
mod window_input;

#[cfg(test)]
mod tests;
